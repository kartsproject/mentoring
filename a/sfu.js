/* K예술영재 미술 온라인 멘토링 — Cloudflare Realtime SFU 연결
 * 한 사람당 연결(PeerConnection) 하나로
 *  - 내 영상·소리(카메라·마이크·화면 공유)를 한 번만 올리고(push)
 *  - 필요한 사람의 영상·소리만 골라 받음(pull) — 단계·조가 바뀌면 받는 목록만 바꿈
 * Cloudflare 앱 비밀키는 Apps Script 관문이 갖고 있고, 여기서는 연결 정보(SDP)만 주고받음.
 */
(function () {
  'use strict';
  var M = window.Meet, api = M.api;
  var rnd = function () { return Math.random().toString(36).slice(2, 7); };

  function SFU(sess, o) {
    o = o || {};
    this.sess = sess; this.pc = null; this.sid = '';
    this.q = Promise.resolve();
    this.pub = {};          // kind → { tr, name, track }
    this.pulled = {};       // key → { mid, rid, sessionId, trackName, track }
    this.failAt = {};       // key → 마지막 실패 시각(잠깐 쉬었다 다시)
    this.onTrack = o.onTrack || function () {};
    this.onState = o.onState || function () {};
    this.onPub = o.onPub || function () {};
    this.simulcast = o.simulcast !== false;
    this.state = 'new';
  }

  // 관문을 거쳐 Cloudflare에 요청
  SFU.prototype.call = async function (op, args) {
    var s = this.sess;
    var body = Object.assign({ a: 'sfu', r: s.r, id: s.id, tok: s.tok, op: op, sid: this.sid }, args || {});
    var j = await api(body, 30000);
    if (!j.ok && j.error === 'auth') { await s.rejoin(); body.id = s.id; body.tok = s.tok; j = await api(body, 30000); }
    if (!j.ok) { var e = new Error(j.detail || j.error); e.code = j.error; throw e; }
    return j.res || {};
  };
  // 협상은 한 번에 하나씩
  SFU.prototype.serial = function (fn) {
    var p = this.q.then(fn, fn);
    this.q = p.catch(function () {});
    return p;
  };

  SFU.prototype.open = async function () {
    var self = this;
    if (this.pc) try { this.pc.close(); } catch (e) {}
    this.pub = {}; this.pulled = {};
    var pc = this.pc = new RTCPeerConnection({ iceServers: this.sess.ice || [{ urls: 'stun:stun.cloudflare.com:3478' }], bundlePolicy: 'max-bundle' });
    pc.ontrack = function (e) {
      var mid = e.transceiver && e.transceiver.mid;
      Object.keys(self.pulled).forEach(function (k) { var p = self.pulled[k]; if (p.mid === mid) { p.track = e.track; self.onTrack(k, e.track); } });
    };
    pc.onconnectionstatechange = function () {
      self.state = pc.connectionState; self.onState(pc.connectionState);
    };
    var r = await this.call('new');
    this.sid = r.sessionId;
    if (!this.sid) throw new Error('no session');
    return this.sid;
  };

  /* 내 영상·소리 올리기 — kind: cam | mic | scr. 이미 올렸으면 트랙만 바꿈(재협상 없음) */
  SFU.prototype.publish = function (kind, track) {
    var self = this;
    return this.serial(async function () {
      var cur = self.pub[kind];
      if (cur) { await cur.tr.sender.replaceTrack(track); cur.track = track; return cur.name; }
      var pc = self.pc, init = { direction: 'sendonly' };
      if (track.kind === 'video') {
        // 작은 칸은 낮은 화질(l), 크게 볼 때·녹화는 높은 화질(h)
        if (self.simulcast && kind === 'cam') init.sendEncodings = [{ rid: 'h', maxBitrate: 1200000 }, { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 180000 }];
        else init.sendEncodings = [{ maxBitrate: kind === 'scr' ? 2500000 : 1200000 }];
      }
      var tr;
      try { tr = pc.addTransceiver(track, init); }
      catch (e) { tr = pc.addTransceiver(track, { direction: 'sendonly' }); }   // 화질 나누기를 못 하는 브라우저
      if (kind === 'scr' && track.contentHint !== undefined) track.contentHint = 'detail';
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      var name = self.sess.pid + '-' + kind + '-' + rnd();
      var res = await self.call('push', { sdp: pc.localDescription.sdp, tracks: [{ mid: tr.mid, trackName: name }] });
      await pc.setRemoteDescription(res.sessionDescription);
      self.pub[kind] = { tr: tr, name: name, track: track };
      self.onPub(self.names());
      return name;
    });
  };
  SFU.prototype.unpublish = function (kind) {
    var self = this;
    return this.serial(async function () {
      var cur = self.pub[kind]; if (!cur) return;
      delete self.pub[kind];
      self.onPub(self.names());
      await self.closeMids([cur.tr.mid], [cur.tr]);
    });
  };
  SFU.prototype.names = function () {
    var o = {}, p = this.pub; Object.keys(p).forEach(function (k) { o[k] = p[k].name; }); return o;
  };

  SFU.prototype.closeMids = async function (mids, trs) {
    if (!mids.length) return;
    var pc = this.pc;
    trs.forEach(function (t) { try { t.stop(); } catch (e) {} });
    var offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    var res = await this.call('close', { mids: mids, sdp: pc.localDescription.sdp });
    if (res.sessionDescription && res.sessionDescription.type === 'answer') await pc.setRemoteDescription(res.sessionDescription);
  };

  /* 받을 목록 맞추기 — want: [{ key, sessionId, trackName, rid }] (key가 같으면 같은 것으로 봄) */
  SFU.prototype.want = function (want) {
    var self = this;
    return this.serial(async function () {
      if (!self.pc || !self.sid) return;
      var pc = self.pc, now = Date.now(), wantMap = {};
      want.forEach(function (w) { wantMap[w.key] = w; });
      // ① 이제 필요 없거나(사람이 나감·방이 바뀜) 화질·트랙이 바뀐 것 닫기
      var del = Object.keys(self.pulled).filter(function (k) {
        var w = wantMap[k], p = self.pulled[k];
        return !w || w.trackName !== p.trackName || w.sessionId !== p.sessionId || (w.rid || '') !== (p.rid || '');
      });
      if (del.length) {
        var trs = [], mids = [];
        del.forEach(function (k) {
          var p = self.pulled[k]; delete self.pulled[k];
          self.onTrack(k, null);
          var t = pc.getTransceivers().filter(function (x) { return x.mid === p.mid; })[0];
          if (t && p.mid != null) { trs.push(t); mids.push(p.mid); }
        });
        try { await self.closeMids(mids, trs); } catch (e) { console.warn('sfu close', e); }
      }
      // ② 새로 받을 것
      var add = want.filter(function (w) { return !self.pulled[w.key] && !(self.failAt[w.key] && now - self.failAt[w.key] < 4000); });
      if (!add.length) return;
      var res = await self.call('pull', { tracks: add.map(function (w) { return { sessionId: w.sessionId, trackName: w.trackName, rid: w.rid || '' }; }) });
      var got = res.tracks || [];
      add.forEach(function (w) {
        var t = got.filter(function (g) { return g.trackName === w.trackName && g.sessionId === w.sessionId; })[0];
        if (!t || t.errorCode || t.mid == null) { self.failAt[w.key] = Date.now(); return; }
        self.pulled[w.key] = { mid: String(t.mid), rid: w.rid || '', sessionId: w.sessionId, trackName: w.trackName, track: null };
      });
      if (res.requiresImmediateRenegotiation && res.sessionDescription) {
        await pc.setRemoteDescription(res.sessionDescription);
        var ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await self.call('reneg', { sdp: pc.localDescription.sdp });
      }
      // ontrack이 먼저 왔을 수도 있으니 다시 맞춤
      pc.getTransceivers().forEach(function (x) {
        Object.keys(self.pulled).forEach(function (k) {
          var p = self.pulled[k];
          if (p.mid === x.mid && !p.track && x.receiver && x.receiver.track) { p.track = x.receiver.track; self.onTrack(k, p.track); }
        });
      });
    });
  };

  SFU.prototype.close = function () {
    try { this.pc && this.pc.close(); } catch (e) {}
    this.pc = null; this.sid = ''; this.pub = {}; this.pulled = {};
  };

  window.ArtSFU = SFU;
})();
