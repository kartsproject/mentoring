/* K예술영재 무용 온라인 멘토링 — 공통 모듈
 * - Apps Script 관문과 통신(입장·폴링·메시지)
 * - WebRTC 연결 관리(멘토↔학생 / 운영진 관람 / 연결 점검)
 * - 카메라·마이크 도우미
 */
(function () {
  'use strict';
  var CFG = window.MEET_CONFIG || {};

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var rid = function () { return Math.random().toString(36).slice(2, 10); };
  var NONCE = rid(); // 이 페이지(새로고침 단위) 식별값

  function api(body, timeout) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, timeout || 20000);
    return fetch(CFG.API, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      cache: 'no-store',
      signal: ctl.signal
    }).then(function (res) { return res.json(); }).finally(function () { clearTimeout(t); });
  }

  /* ───────── 세션: 입장·폴링·메시지 ───────── */
  function Session(o) {
    this.r = o.r; this.role = o.role; this.name = o.name; this.code = o.code || '';
    this.interval = o.interval || 2000;
    this.info = { n: NONCE };
    this.ls = {};
    this.outbox = [];
    this.fastUntil = 0;
    this.offset = 0;
    this.running = false;
    this.birth = o.birth || '';
    this.panel = !!o.panel;
    this.chat = { gv: 0, last: 0, list: [], bc: [] };   // 대기실 채팅·공지
  }
  Session.prototype.on = function (ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); };
  Session.prototype.emit = function (ev) {
    var args = [].slice.call(arguments, 1);
    (this.ls[ev] || []).forEach(function (f) { try { f.apply(null, args); } catch (e) { console.error(e); } });
  };
  Session.prototype.join = function () {
    var self = this;
    return api({ a: 'join', r: this.r, role: this.role, name: this.name, code: this.code, birth: this.birth, panel: this.panel }).then(function (j) {
      if (!j.ok) { var e = new Error(j.error); e.code = j.error; e.data = j; throw e; }
      self.id = j.id; self.tok = j.tok; self.ice = j.ice; self.name = j.name; if (j.pid) self.pid = j.pid;
      if (j.r) self.r = j.r;
      self.me = j.me || null;
      self.offset = j.now - Date.now();
      return j;
    });
  };
  Session.prototype.now = function () { return Date.now() + this.offset; };
  Session.prototype.rejoin = function () {
    var self = this;
    if (this._rj) return this._rj;   // 여러 요청이 동시에 다시 입장하지 않게
    this._rj = this.join().then(function () { self.emit('rejoin'); }).finally(function () { self._rj = null; });
    return this._rj;
  };
  Session.prototype.boost = function (ms) { this.fastUntil = Math.max(this.fastUntil, Date.now() + (ms || 10000)); };
  // 이미 연결된 상대에게는 영상 연결 안의 데이터 통로로 바로 보내고, 없으면 서버 메시지함으로
  Session.prototype.send = function (to, msg) {
    msg.from = msg.from || this.id;
    if (this.router && this.router(to, msg)) return;
    this.outbox.push({ to: to, msg: msg }); this.flush();
  };
  // 기다리지 말고 지금 바로 서버 상태 확인
  Session.prototype.kick = function () { this.boost(8000); if (this._wake) this._wake(); };
  // 빠른 신호로 받은 진행 상태(시작·종료)를 서버 반영 전까지 화면에 먼저 적용
  Session.prototype.setOverride = function (cur, extra) {
    this.ov = { cur: cur || null, prev: extra && extra.prev || null, until: Date.now() + 12000 };
    if (this.raw) { this.view = this.patch(this.raw); this.emit('view', this.view); }
    this.kick();
  };
  Session.prototype.patch = function (v) {
    var ov = this.ov;
    if (!ov || !v) return v;
    if (Date.now() > ov.until) { this.ov = null; return v; }
    var sc = v.cur || null;
    if (this.role === 'student') {
      var serverCalledMe = v.called;
      var ovCalledMe = !!(ov.cur && ov.cur.id === v.me);
      if (serverCalledMe === ovCalledMe && (ovCalledMe || !!v.busy === !!ov.cur)) { this.ov = null; return v; }
      var p = Object.assign({}, v);
      p.called = ovCalledMe; p.busy = !!ov.cur;
      if (ovCalledMe) { p.cur = ov.cur; p.done = false; }
      else { p.cur = null; if (v.called || (ov.prev && ov.prev === v.me)) p.done = true; }
      return p;
    }
    if ((!sc && !ov.cur) || (sc && ov.cur && sc.id === ov.cur.id)) { this.ov = null; return v; }
    var q = Object.assign({}, v);
    q.cur = ov.cur ? Object.assign({ live: true }, ov.cur) : null;
    var endedId = (sc && (!ov.cur || sc.id !== ov.cur.id)) ? sc.id : ov.prev;
    if (q.students) q.students = q.students.map(function (st) {
      if (st.id === endedId && !st.done) return Object.assign({}, st, { done: Date.now() });
      return st;
    });
    if (ov.cur && q.next && q.next.id === ov.cur.id) q.next = null;   // 멘토링실의 연구원(stage)은 멘토링 중에도 그대로
    return q;
  };
  Session.prototype.flush = async function () {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.outbox.length) {
        var batch = this.outbox.splice(0, 8);
        for (var i = 0; i < 4; i++) {
          try {
            var j = await api({ a: 'send', r: this.r, id: this.id, tok: this.tok, msgs: batch });
            if (j.ok) break;
            if (j.error === 'auth') await this.rejoin().catch(function () {});
          } catch (e) { await sleep(700 * (i + 1)); }
        }
      }
    } finally { this.flushing = false; }
  };
  // 서버 요청: 망이 잠깐 끊기거나 서버가 바쁘면(동시 접속 한도·잠금 대기) 잠깐 쉬었다 다시(최대 3번)
  Session.prototype.call = async function (body, timeout) {
    var j = null;
    for (var i = 0; i < 3; i++) {
      try {
        body.id = this.id; body.tok = this.tok;
        j = await api(body, timeout);
        if (!j.ok && j.error === 'auth') { await this.rejoin(); continue; }
        if (!j.ok && j.error === 'server') { await sleep(600 * (i + 1)); continue; }
        return j;
      } catch (e) { j = { ok: false, error: 'network' }; await sleep(700 * (i + 1)); }
    }
    return j || { ok: false, error: 'network' };
  };
  Session.prototype.op = async function (cmd, args) {
    var body = Object.assign({ a: 'op', r: this.r, id: this.id, tok: this.tok, cmd: cmd }, args || {});
    var j = await this.call(body);
    if (j.chat) this.mergeChat(j.chat);
    if (j.bc) this.mergeChat({ gv: this.chat.gv, last: this.chat.last, list: [], bc: j.bc });
    this.kick();
    return j;
  };
  // 대기실 채팅: 바뀐 부분만 받아 합침
  Session.prototype.mergeChat = function (c) {
    var ch = this.chat, changed = false;
    if (c.full || c.gv !== ch.gv) { ch.list = c.list.slice(); ch.gv = c.gv; changed = true; }
    else if (c.list.length) {
      var have = {}; ch.list.forEach(function (m) { have[m.i] = 1; });
      c.list.forEach(function (m) { if (!have[m.i]) { ch.list.push(m); changed = true; } });
      ch.list.sort(function (a, b) { return a.i - b.i; });
      if (ch.list.length > 300) ch.list = ch.list.slice(-300);
    }
    ch.last = Math.max(ch.last, c.last || 0);
    var bcSig = JSON.stringify(c.bc || []);
    if (bcSig !== ch.bcSig) { ch.bc = c.bc || []; ch.bcSig = bcSig; changed = true; }
    if (changed) this.emit('chat', ch);
  };
  Session.prototype.say = async function (text) {
    var body = { a: 'chat', r: this.r, id: this.id, tok: this.tok, text: text, since: this.chat.last, gv: this.chat.gv };
    var j = await this.call(body);
    if (j.ok && j.chat) this.mergeChat(j.chat);
    return j;
  };
  Session.prototype.start = function () {
    if (this.running) return;
    this.running = true; this.loop();
    // 망이 다시 연결되거나, 화면을 다시 켜면(휴대폰 잠금 해제·창 전환) 바로 상태 확인
    var self = this;
    if (!this._wired) {
      this._wired = true;
      window.addEventListener('online', function () { self.kick(); });
      document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') self.kick(); });
      window.addEventListener('pageshow', function () { self.kick(); });
    }
  };
  Session.prototype.stop = function () { this.running = false; };
  Session.prototype.loop = async function () {
    var fails = 0;
    while (this.running) {
      var t0 = Date.now();
      try {
        var j = await api({ a: 'poll', r: this.r, id: this.id, tok: this.tok, info: this.info, since: this.chat.last, gv: this.chat.gv }, 15000);
        if (j.ok) {
          if (j.chat) this.mergeChat(j.chat);
          fails = 0;
          this.offset = j.now - (t0 + Date.now()) / 2;
          if (j.msgs && j.msgs.length) this.boost(10000);
          for (var k = 0; k < (j.msgs || []).length; k++) this.emit('msg', j.msgs[k]);
          this.raw = j.view;
          this.view = this.patch(j.view);
          this.emit('view', this.view);
          this.emit('net', true, 0);
        } else if (j.error === 'auth') {
          try { await this.rejoin(); } catch (e2) { fails++; this.emit('net', false, fails); }
        } else { fails++; this.emit('net', false, fails); }
      } catch (e) { fails++; this.emit('net', false, fails); }
      var base = Date.now() < this.fastUntil ? 900 : this.interval;
      var wait = Math.max(150, base - (Date.now() - t0)) + (fails ? Math.min(6000, fails * 1000) : 0);
      var self = this;
      await new Promise(function (res) { var t = setTimeout(res, wait); self._wake = function () { clearTimeout(t); self._wake = null; res(); }; });
      this._wake = null;
    }
  };

  /* ───────── 연결 정보 모으기 ─────────
   * 다 모일 때까지 기다리지 않고, 쓸 만한 후보(외부 주소, 중계 서버가 있으면 중계 주소)가 모이면 바로 보냄.
   * 늦게 모인 후보는 'cand' 메시지로 이어서 보냄.
   */
  function gather(pc, wantRelay) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    var t0 = Date.now();
    return new Promise(function (res) {
      var hasSrflx = false, hasRelay = false, finished = false;
      var done = function () {
        if (finished) return; finished = true;
        clearTimeout(t); clearInterval(iv);
        pc.removeEventListener('icegatheringstatechange', chk);
        pc.removeEventListener('icecandidate', cand);
        res();
      };
      var good = function () {
        var el = Date.now() - t0;
        if (wantRelay) return (hasRelay && el > 300) || (hasSrflx && el > 1500);
        return hasSrflx && el > 300;
      };
      var chk = function () { if (pc.iceGatheringState === 'complete') done(); };
      var cand = function (e) {
        if (!e.candidate) return done();
        var c = e.candidate.candidate || '';
        if (/ typ srflx/.test(c)) hasSrflx = true;
        if (/ typ relay/.test(c)) hasRelay = true;
        if (good()) done();
      };
      var iv = setInterval(function () { if (good()) done(); }, 150);
      var t = setTimeout(done, 2500);
      pc.addEventListener('icegatheringstatechange', chk);
      pc.addEventListener('icecandidate', cand);
    });
  }

  /* ───────── 연결 관리 ─────────
   * kind: 'ms'   멘토↔학생 (멘토가 먼저 연결 요청, 양방향)
   *       'view' 운영진 관람 (운영진이 요청, 운영진은 받기만)
   *       'test' 연결 점검 (녹화 담당 운영진이 요청, 데이터만)
   *       'rs'   연구원 → 멘토링 중인 학생 (연구원이 요청, 연구원 영상·음성만 보냄)
   */
  function Links(sess, o) {
    this.s = sess;
    this.map = new Map();
    this.getLocal = o.getLocal || function () { return null; };
    this.localFor = o.localFor || null;   // 연결 종류별로 다른 내 영상·음성을 보낼 때(연구원 → 학생)
    this.onRemote = o.onRemote || function () {};
    this.onChange = o.onChange || function () {};
    this.onData = o.onData || function () {};
    // 미리 연결해 둔 연결에서 내 영상·음성을 보낼지(true) 멈출지(false)
    this.policy = o.sendPolicy || null;
    var self = this;
    this.pendC = {};
    sess.on('msg', function (m) { self.onMsg(m).catch(function (e) { console.warn('msg', e); }); });
    this.watch = setInterval(function () { self.watchdog(); }, 2000);
    this.wantRelay = (sess.ice || []).some(function (x) { return [].concat(x.urls || []).some(function (u) { return /^turns?:/.test(u); }); });
    // 데이터 통로가 열린 상대에게는 서버를 거치지 않고 바로 보냄
    sess.router = function (to, msg) {
      if (!/^(ev|offer|answer|cand)$/.test(msg.t)) return false;
      var L = self.all().find(function (x) { return x.peer === to && !x.closed && x.dc && x.dc.readyState === 'open'; });
      if (!L) return false;
      try { L.dc.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
    };
  }
  // 내가 요청한 연결(>)과 상대가 요청한 연결(<)을 따로 보관 — 서로 동시에 요청해도 충돌하지 않음
  Links.prototype.key = function (kind, peer, role) { return kind + (role === 'answer' ? '<' : '>') + peer; };
  Links.prototype.get = function (kind, peer, role) {
    if (role) return this.map.get(this.key(kind, peer, role));
    return this.map.get(this.key(kind, peer, 'offer')) || this.map.get(this.key(kind, peer, 'answer'));
  };
  Links.prototype.all = function () { return Array.from(this.map.values()); };
  Links.prototype.local = function (kind) { return this.localFor ? this.localFor(kind) : this.getLocal(); };
  Links.prototype.byCid = function (cid) { return this.all().find(function (L) { return L.cid === cid; }); };

  Links.prototype.make = function (kind, peer, cid, role, peerNonce) {
    var self = this;
    var pc = new RTCPeerConnection({ iceServers: this.s.ice || [], bundlePolicy: 'max-bundle' });
    var L = { kind: kind, peer: peer, cid: cid, role: role, pc: pc, stream: new MediaStream(), state: 'new',
              created: Date.now(), connectedAt: 0, badSince: 0, relay: null, dc: null, peerNonce: peerNonce || '' };
    pc.ontrack = function (e) {
      if (!L.stream.getTracks().some(function (t) { return t.id === e.track.id; })) L.stream.addTrack(e.track);
      self.onRemote(L);
    };
    var upd = function () {
      if (L.closed) return;
      var st = pc.connectionState || pc.iceConnectionState;
      if (pc.iceConnectionState === 'failed') st = 'failed';
      if (st === 'completed') st = 'connected';
      if (st === L.state) return;
      L.state = st;
      if (st === 'connected') { L.connectedAt = L.connectedAt || Date.now(); L.badSince = 0; self.checkRelay(L); }
      if (st === 'disconnected' || st === 'failed') L.badSince = L.badSince || Date.now();
      self.onChange(L);
    };
    pc.onconnectionstatechange = upd;
    pc.oniceconnectionstatechange = upd;
    pc.ondatachannel = function (e) { L.dc = e.channel; self.wireDc(L); };
    // 처음 보낸 뒤에 모인 연결 후보는 모아서 이어 보냄
    L.candQ = [];
    pc.onicecandidate = function (e) {
      if (!L.sdpSent || L.closed || !e.candidate) return;
      L.candQ.push(e.candidate.toJSON ? e.candidate.toJSON() : e.candidate);
      if (L.candT) return;
      L.candT = setTimeout(function () {
        L.candT = null;
        if (L.closed || !L.candQ.length) return;
        self.s.send(L.peer, { t: 'cand', cid: L.cid, cs: L.candQ.splice(0) });
      }, 250);
    };
    this.map.set(this.key(kind, peer, role), L);
    return L;
  };

  Links.prototype.wireDc = function (L) {
    var self = this;
    L.dc.onopen = function () { L.dcOpen = true; self.onData(L, 'open'); self.onChange(L); };
    L.dc.onmessage = function (e) {
      var m = null;
      try { m = JSON.parse(e.data); } catch (err) {}
      if (m && m.t) {
        m.from = L.peer;   // 통로 상대가 보낸 사람
        if (m.t === 'ev') return self.s.emit('ev', m);
        return self.onMsg(m).catch(function (err) { console.warn('dc msg', err); });
      }
      self.onData(L, 'msg', e.data);
    };
  };
  Links.prototype.addCands = function (L, cs) {
    (cs || []).forEach(function (c) { L.pc.addIceCandidate(c).catch(function () {}); });
  };

  Links.prototype.offer = async function (kind, peer, peerNonce) {
    var prev = this.get(kind, peer, 'offer');
    if (prev) this.closeLink(prev, true);
    var L = this.make(kind, peer, rid(), 'offer', peerNonce);
    var pc = L.pc;
    if (kind === 'ms') {
      var ls = this.local(kind);
      if (ls) ls.getTracks().forEach(function (t) { pc.addTrack(t, ls); });
      else { pc.addTransceiver('audio'); pc.addTransceiver('video'); }
      this.applyOne(L);
    } else if (kind === 'rs') {   // 보내기만
      var rs = this.local(kind);
      ['audio', 'video'].forEach(function (k) {
        var t = rs && rs.getTracks().find(function (x) { return x.kind === k; });
        pc.addTransceiver(t || k, { direction: 'sendonly', streams: rs ? [rs] : [] });
      });
      this.applyOne(L);
    } else if (kind === 'view') {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    if (kind === 'ms' || kind === 'view' || kind === 'rs') {
      L.dc = pc.createDataChannel('c');   // 빠른 신호용 통로
      this.wireDc(L);
    } else {
      L.dc = pc.createDataChannel('t');
      this.wireDc(L);
    }
    var off = await pc.createOffer();
    await pc.setLocalDescription(off);
    await gather(pc, this.wantRelay);
    if (L.closed) return L;
    L.sdpSent = true;
    this.s.send(peer, { t: 'offer', cid: L.cid, kind: kind, sdp: pc.localDescription.sdp });
    this.s.boost(20000);
    this.onChange(L);
    return L;
  };

  Links.prototype.onMsg = async function (m) {
    if (m.t === 'offer') {
      var old = this.get(m.kind, m.from, 'answer');
      if (old) this.closeLink(old, false);
      var L = this.make(m.kind, m.from, m.cid, 'answer');
      var pc = L.pc;
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      if (this.pendC[m.cid]) { this.addCands(L, this.pendC[m.cid]); delete this.pendC[m.cid]; }
      if (m.kind === 'ms' || m.kind === 'view') {
        var ls = this.local(m.kind);
        if (ls) ls.getTracks().forEach(function (t) { pc.addTrack(t, ls); });
        else { pc.getTransceivers().forEach(function (tr) { try { tr.direction = 'sendrecv'; } catch (e) {} }); }
        this.applyOne(L);
      }
      var ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await gather(pc, this.wantRelay);
      if (L.closed) return;
      L.sdpSent = true;
      this.s.send(m.from, { t: 'answer', cid: m.cid, sdp: pc.localDescription.sdp });
      this.s.boost(15000);
      this.onChange(L);
    } else if (m.t === 'answer') {
      var A = this.byCid(m.cid);
      if (A && A.role === 'offer' && A.pc.signalingState === 'have-local-offer') {
        await A.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
        if (this.pendC[m.cid]) { this.addCands(A, this.pendC[m.cid]); delete this.pendC[m.cid]; }
      }
    } else if (m.t === 'cand') {
      var C = this.byCid(m.cid);
      if (C && C.pc.remoteDescription) this.addCands(C, m.cs);
      else (this.pendC[m.cid] = this.pendC[m.cid] || []).push.apply(this.pendC[m.cid], m.cs || []);
    } else if (m.t === 'bye') {
      var B = this.byCid(m.cid);
      if (B) this.closeLink(B, false);
    }
  };

  Links.prototype.closeLink = function (L, notify) {
    if (!L || L.closed) return;
    L.closed = true;
    try { L.pc.close(); } catch (e) {}
    var k = this.key(L.kind, L.peer, L.role);
    if (this.map.get(k) === L) this.map.delete(k);
    if (notify) this.s.send(L.peer, { t: 'bye', cid: L.cid });
    L.state = 'closed';
    this.onChange(L);
  };
  Links.prototype.close = function (kind, peer, notify) { this.closeLink(this.get(kind, peer), notify); };
  Links.prototype.closeWhere = function (fn, notify) {
    var self = this;
    this.all().filter(fn).forEach(function (L) { self.closeLink(L, notify); });
  };

  // 오래 안 붙거나 끊긴 연결은 정리 → 요청 쪽이 다음 확인 때 다시 연결
  Links.prototype.watchdog = function () {
    var now = Date.now(), self = this;
    this.all().forEach(function (L) {
      var neverTimeout = L.kind === 'test' ? 20000 : 25000;
      if (!L.connectedAt && now - L.created > neverTimeout) {
        L.state = 'timeout'; self.onChange(L); self.closeLink(L, true);
      } else if (L.connectedAt && L.badSince && now - L.badSince > (L.state === 'failed' ? 1500 : 6000)) {   // 6초 넘게 불안정하면 새로 연결
        self.closeLink(L, true);
      }
    });
  };

  Links.prototype.checkRelay = async function (L) {
    try {
      var st = await L.pc.getStats();
      var pairId = null, pair = null;
      st.forEach(function (r) { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      st.forEach(function (r) {
        if (r.type !== 'candidate-pair') return;
        if ((pairId && r.id === pairId) || (!pairId && r.nominated && r.state === 'succeeded')) pair = r;
      });
      if (pair) {
        var lc = st.get(pair.localCandidateId), rc = st.get(pair.remoteCandidateId);
        L.relay = !!((lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay'));
      }
    } catch (e) {}
    this.onChange(L);
    return L.relay;
  };

  // 보내기 정책 적용: 미리 연결(대기) 중에는 트랙을 비워 두었다가, 차례가 되면 즉시 채움(재연결 없음)
  Links.prototype.applyOne = function (L) {
    if (L.kind === 'test') return;
    if (L.kind === 'rs' && L.role === 'answer') return;   // 학생은 연구원에게 보내지 않음
    var on = this.policy ? !!this.policy(L) : true;
    var stream = this.local(L.kind);
    L.sending = on;
    L.pc.getTransceivers().forEach(function (tr) {
      if (!tr.sender || tr.stopped) return;
      var kind = tr.receiver && tr.receiver.track ? tr.receiver.track.kind : null;
      if (!kind) return;
      var t = on && stream ? stream.getTracks().find(function (x) { return x.kind === kind; }) || null : null;
      if (tr.sender.track !== t) tr.sender.replaceTrack(t).catch(function () {});
    });
  };
  Links.prototype.applyPolicy = function () { var self = this; this.all().forEach(function (L) { self.applyOne(L); }); };

  // 카메라 전환 등 내 트랙이 바뀌면 모든 연결에 반영
  Links.prototype.replaceLocal = function (stream) {
    var self = this;
    this.all().forEach(function (L) {
      if (L.kind === 'test' || L.kind === 'rs' || !stream || L.sending === false) { if (L.kind === 'rs' && L.role === 'offer') self.applyOne(L); return; }
      L.pc.getTransceivers().forEach(function (tr) {
        if (!tr.sender || !(tr.currentDirection === 'sendrecv' || tr.currentDirection === 'sendonly' || tr.sender.track)) return;
        var kind = tr.receiver && tr.receiver.track ? tr.receiver.track.kind : (tr.sender.track && tr.sender.track.kind);
        var t = stream.getTracks().find(function (x) { return x.kind === kind; });
        if (t && tr.sender.track !== t) tr.sender.replaceTrack(t).catch(function () {});
      });
    });
  };

  /* ───────── 장치 ───────── */
  var Media = {
    get: function (o) {
      o = o || {};
      var video = CFG.CAM_43 ? { width: { ideal: 960 }, height: { ideal: 720 }, aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 30, max: 30 } }   // 4:3(무용)
        : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
      if (o.videoId) video.deviceId = { exact: o.videoId }; else video.facingMode = o.facing || 'user';
      var audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (o.audioId) audio.deviceId = { exact: o.audioId };
      return navigator.mediaDevices.getUserMedia({ audio: audio, video: video });
    },
    list: async function () {
      var d = await navigator.mediaDevices.enumerateDevices();
      return {
        video: d.filter(function (x) { return x.kind === 'videoinput'; }),
        audio: d.filter(function (x) { return x.kind === 'audioinput'; })
      };
    },
    meter: function (stream, el) {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        var ac = new AC();
        var src = ac.createMediaStreamSource(stream);
        var an = ac.createAnalyser(); an.fftSize = 512;
        src.connect(an);
        var buf = new Uint8Array(an.fftSize), stop = false;
        (function loop() {
          if (stop) return;
          an.getByteTimeDomainData(buf);
          var peak = 0;
          for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
          el.style.width = Math.min(100, peak / 128 * 260) + '%';
          requestAnimationFrame(loop);
        })();
        return function () { stop = true; try { ac.close(); } catch (e) {} };
      } catch (e) { return function () {}; }
    },
    stop: function (stream) { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); },
    errText: function (e) {
      var n = e && e.name;
      if (n === 'NotAllowedError' || n === 'SecurityError') return '카메라·마이크 사용이 차단되어 있습니다. 주소창의 자물쇠(또는 설정)에서 카메라·마이크를 「허용」으로 바꾼 뒤 새로고침해 주세요.';
      if (n === 'NotFoundError' || n === 'OverconstrainedError') return '카메라나 마이크를 찾지 못했습니다. 연결 상태를 확인해 주세요.';
      if (n === 'NotReadableError') return '다른 앱(ZOOM·카메라 앱 등)이 카메라를 쓰고 있습니다. 그 앱을 닫고 다시 시도해 주세요.';
      return '카메라·마이크를 켜지 못했습니다. (' + (n || e) + ')';
    }
  };

  /* 장치 점검 화면 묶음: 미리보기·마이크 막대·장치 선택 */
  function DeviceCheck(o) {
    this.o = o; this.stream = null; this.stopMeter = null; this.facing = 'user';
  }
  DeviceCheck.prototype.start = async function (opt) {
    var o = this.o, self = this;
    opt = opt || {};
    if (this.stopMeter) this.stopMeter();
    var old = this.stream;
    try {
      this.stream = await Media.get({ videoId: opt.videoId, audioId: opt.audioId, facing: this.facing });
    } catch (e) {
      if (opt.videoId || opt.audioId) { this.stream = await Media.get({}); }
      else throw e;
    }
    if (old && old !== this.stream) Media.stop(old);
    UI.attach(o.video, this.stream);
    if (o.meter) this.stopMeter = Media.meter(this.stream, o.meter);
    var d = await Media.list();
    var fill = function (sel, list, cur, label) {
      if (!sel) return;
      sel.innerHTML = list.map(function (x, i) {
        return '<option value="' + x.deviceId + '"' + (x.deviceId === cur ? ' selected' : '') + '>' + UI.esc(x.label || (label + ' ' + (i + 1))) + '</option>';
      }).join('');
      sel.onchange = function () {
        var v = self.o.selCam ? self.o.selCam.value : undefined, a = self.o.selMic ? self.o.selMic.value : undefined;
        self.start({ videoId: v, audioId: a }).then(function () { if (self.o.onChange) self.o.onChange(self.stream); })
          .catch(function (e) { if (o.err) o.err.textContent = Media.errText(e); });
      };
    };
    var vt = this.stream.getVideoTracks()[0], at = this.stream.getAudioTracks()[0];
    fill(o.selCam, d.video, vt && vt.getSettings().deviceId, '카메라');
    fill(o.selMic, d.audio, at && at.getSettings().deviceId, '마이크');
    this.camCount = d.video.length;
    return this.stream;
  };
  DeviceCheck.prototype.flip = async function () {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    if (this.camCount > 2 || !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      // 데스크톱·카메라 여러 개: 목록에서 다음 카메라
      var d = await Media.list();
      var cur = this.stream && this.stream.getVideoTracks()[0];
      var curId = cur && cur.getSettings().deviceId;
      var i = d.video.findIndex(function (x) { return x.deviceId === curId; });
      var next = d.video[(i + 1) % d.video.length];
      return this.start({ videoId: next && next.deviceId });
    }
    return this.start({});
  };
  DeviceCheck.prototype.stopMeterOnly = function () { if (this.stopMeter) { this.stopMeter(); this.stopMeter = null; } };

  /* ───────── 화면 도우미 ───────── */
  var UI = {
    $: function (s, el) { return (el || document).querySelector(s); },
    $$: function (s, el) { return Array.from((el || document).querySelectorAll(s)); },
    show: function (el, on) { if (typeof el === 'string') el = document.querySelector(el); if (el) el.classList.toggle('hide', !on); },
    attach: function (video, stream) {
      if (!video) return;
      if (video.srcObject !== stream) video.srcObject = stream || null;
      if (stream) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    },
    esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
    toast: function (text, ms) {
      var t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
      document.body.appendChild(t); setTimeout(function () { t.remove(); }, ms || 2600);
    },
    mmss: function (ms) {
      var neg = ms < 0; ms = Math.abs(ms);
      var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
      return (neg ? '-' : '') + String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    },
    netbar: function (sess) {
      var bar = null;
      sess.on('net', function (ok, fails) {
        if (ok) { if (bar) { bar.remove(); bar = null; } return; }
        if (fails < 3) return;
        if (!bar) { bar = document.createElement('div'); bar.className = 'netbar'; document.body.appendChild(bar); }
        bar.textContent = '서버 연결이 불안정합니다 — 다시 연결하는 중…';
      });
    },
    wakeLock: function () {
      var lock = null;
      var req = function () { if (navigator.wakeLock && document.visibilityState === 'visible') navigator.wakeLock.request('screen').then(function (l) { lock = l; }).catch(function () {}); };
      req();
      document.addEventListener('visibilitychange', req);
    },
    param: function (k) { return new URLSearchParams(location.search).get(k) || ''; },
    // 여러 사람 영상 바둑판: items [{key, label, stream, mirror, muted}]
    grid: function (box, items) {
      box.className = 'sgrid n' + Math.min(items.length, 4);
      var keep = {};
      items.forEach(function (it, idx) {
        keep[it.key] = 1;
        var cell = box.querySelector('[data-k="' + it.key + '"]');
        if (!cell) {
          cell = document.createElement('div');
          cell.className = 'gcell'; cell.dataset.k = it.key;
          cell.innerHTML = '<video autoplay playsinline></video><div class="gwait">연결 중…</div><span class="label"></span>';
          box.appendChild(cell);
        }
        cell.style.order = idx;
        var v = cell.querySelector('video');
        v.muted = !!it.muted;
        v.classList.toggle('mirror', !!it.mirror);
        UI.attach(v, it.stream || null);
        var ok = it.stream && it.stream.getVideoTracks().length;
        cell.querySelector('.gwait').style.display = ok ? 'none' : '';
        cell.querySelector('.label').textContent = it.label || '';
      });
      Array.from(box.children).forEach(function (c) { if (!keep[c.dataset.k]) { var v = c.querySelector('video'); if (v) v.srcObject = null; c.remove(); } });
    },
    // 작은 화면 묶음(멘토링실의 연구원): items [{key, label, stream, muted, mirror, off(안 보이게 — 소리는 그대로)}]
    pips: function (box, items) {
      if (!box) return;
      var keep = {};
      items.forEach(function (it, idx) {
        keep[it.key] = 1;
        var cell = box.querySelector('[data-k="' + it.key + '"]');
        if (!cell) {
          cell = document.createElement('div');
          cell.className = 'rpip'; cell.dataset.k = it.key;
          cell.innerHTML = '<video autoplay playsinline></video><span class="rpl"></span><span class="rpm"></span>';
          box.appendChild(cell);
        }
        cell.style.order = idx;
        var v = cell.querySelector('video');
        v.muted = !!it.muted;
        v.classList.toggle('mirror', !!it.mirror);
        UI.attach(v, it.stream || null);
        cell.classList.toggle('off', !!it.off);
        cell.classList.toggle('nov', !(it.stream && it.stream.getVideoTracks().length));
        cell.classList.toggle('talk', !!it.mic);
        cell.querySelector('.rpl').textContent = it.label || '';
        cell.querySelector('.rpm').innerHTML = it.mic ? ICON.mic : ICON.micOff;
      });
      Array.from(box.children).forEach(function (c) { if (!keep[c.dataset.k]) { var v = c.querySelector('video'); if (v) v.srcObject = null; c.remove(); } });
      box.classList.toggle('has', items.some(function (it) { return !it.off; }));
    },
    // 입장 시간 전 안내(무용·미술 학생 공통): 「멘토링 시간이 아닙니다.」 + 들어올 수 있는 날짜·시각
    notTime: function (d) {
      d = d || {};
      var out = '<b>멘토링 시간이 아닙니다.</b>';
      if (d.date && !d.past) {
        var y = Number(d.date.slice(0, 4)), mo = Number(d.date.slice(5, 7)), da = Number(d.date.slice(8, 10));
        var wd = '일월화수목금토'.charAt(new Date(Date.UTC(y, mo - 1, da)).getUTCDay());
        var op = d.open ? (function (h) { var q = h.split(':'), H = Number(q[0]); return (H < 12 ? '오전 ' : '오후 ') + (H % 12 || 12) + ':' + q[1]; })(d.open) : '';
        out += '<br>' + mo + '월 ' + da + '일(' + wd + ')' + (op ? ' ' + op + '부터' : '') + ' 입장할 수 있습니다.';
      }
      return out;
    },
    roleName: function (role) { return role === 'research' ? '연구원' : role === 'ops' ? '운영' : role === 'mentor' ? '멘토' : ''; },
    stateText: function (st) {
      return { 'new': '준비', connecting: '연결 중', connected: '연결됨', disconnected: '불안정', failed: '실패', timeout: '시간 초과', closed: '끊김', checking: '연결 중' }[st] || st || '-';
    }
  };

  /* 녹화 안내 문구 등 공통 */
  var ICON = {
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.9 5M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/></svg>',
    cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
    camOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 16v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1M10 6h4a2 2 0 0 1 2 2v3l5-3v9M3 3l18 18"/></svg>',
    flip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h11l-3-3M20 17H9l3 3"/></svg>'
  };
  // 작은 선 아이콘(운영 Hub·홈페이지와 같은 굵기·둥근 끝) — UI.ico('bell')
  var IC = {
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
    bellOff: '<path d="M8.5 5.2A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17"/><path d="M10 20.5a2 2 0 0 0 4 0M3 3l18 18"/>',
    list: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3h6v3H9zM9 11h6M9 15h4"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    win: '<rect x="3" y="5" width="15" height="14" rx="2"/><path d="M3 9h15M14 3h7v7M21 3l-7 7"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.7 3.3-5.5 6.5-5.5s5.8 1.8 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.4 3.5 5.2"/>',
    chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
    pin: '<path d="M9 3h6l-1 5 4 4H6l4-4z"/><path d="M12 12v9"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    home: '<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    door: '<path d="M5 21V4a1 1 0 0 1 1-1h9v18"/><path d="M15 5h4v16M3 21h18M12 12v1"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4a1.5 1.5 0 0 1 3 0v7M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7c-2.5 0-4-1-5.5-3L3 15.5a1.5 1.5 0 0 1 2.3-1.9L8 16"/>',
    layout: '<rect x="2" y="7" width="20" height="11" rx="2"/><path d="M18 12.5h.01M6 21h12"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 10 6 10 9s-10 4-10 9M17 3c0 5-10 6-10 9"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5v.5M15 9.5v.5"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4.2-6.5 8-6.5s7 2 8 6.5"/>',
    mega: '<path d="M3 10v4h4l8 5V5L7 10z"/><path d="M18.5 9a4 4 0 0 1 0 6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    out: '<path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 8l-4 4 4 4M6 12h10"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    rec: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    vol: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
    volOff: '<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>'
  };
  UI.ico = function (k, cls) {
    return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (IC[k] || '') + '</svg>';
  };
  // 아이콘 + 글자 버튼 내용
  UI.label = function (el, k, text) { if (typeof el === 'string') el = document.querySelector(el); if (el) el.innerHTML = UI.ico(k) + '<span>' + UI.esc(text) + '</span>'; };
  // K 표지
  UI.kmark = function (cls) { return '<span class="kmark' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><b>K</b><span><i></i><i></i><i></i><i></i></span></span>'; };

  /* ───── 발언자 표시: 소리 크기를 재서 말하는 사람 칸에 아이콘(왼쪽 아래)·초록 후광 ─────
   *  track(key, stream): 키(사람)별 소리 재기 / on(key): 지금 말하는 중인지 / listen(fn): 바뀔 때 알림
   *  auto(videoSel, hostSel): 화면의 영상 요소들을 찾아 그 영상의 소리로 칸(host)에 표시(무용 화면용)
   */
  var Speak = (function () {
    var ac = null, items = {}, fns = [], autos = [], timer = null, buf = null;
    var THR = 0.015, HOLD = 800;
    function ctx() {
      if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
      if (ac.state !== 'running') ac.resume().catch(function () {});
      return ac;
    }
    ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) { document.addEventListener(t, function () { if (ac && ac.state !== 'running') ac.resume().catch(function () {}); }, true); });
    function set(key, stream) {
      var at = stream && stream.getAudioTracks && stream.getAudioTracks()[0], it = items[key];
      if (it && it.tid === (at && at.id)) return;
      if (it) { try { it.src.disconnect(); } catch (e) {} delete items[key]; if (it.on) emit(key, false); }
      if (!at || at.readyState === 'ended') return;
      var c = ctx(); if (!c) return;
      try {
        var src = c.createMediaStreamSource(new MediaStream([at])), an = c.createAnalyser();
        an.fftSize = 2048; src.connect(an);
        items[key] = { src: src, an: an, tid: at.id, track: at, on: false, last: 0, hits: 0 };
      } catch (e) {}
      if (!timer) timer = setInterval(loop, 140);
    }
    function emit(key, on) { fns.forEach(function (f) { try { f(key, on); } catch (e) {} }); }
    function loop() {
      var now = Date.now();
      autos.forEach(function (a) {
        document.querySelectorAll(a.v).forEach(function (el) {
          if (!el.__spk) el.__spk = 'v' + Math.random().toString(36).slice(2, 8);
          set(el.__spk, el.srcObject || null);
          var host = el.closest(a.h) || el.parentNode, on = !!(items[el.__spk] && items[el.__spk].on);
          if (host && host.classList.contains('speaking') !== on) mark(host, on);
        });
      });
      Object.keys(items).forEach(function (k) {
        var it = items[k];
        if (it.track.readyState === 'ended') { set(k, null); return; }
        if (!buf || buf.length !== it.an.fftSize) buf = new Float32Array(it.an.fftSize);
        it.an.getFloatTimeDomainData(buf);
        var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        var rms = Math.sqrt(sum / buf.length), loud = it.track.enabled && rms > THR;
        it.hits = loud ? it.hits + 1 : 0;
        if (it.hits >= 1) it.last = now;
        var on = now - it.last < HOLD;
        if (on !== it.on) { it.on = on; emit(k, on); }
      });
    }
    function mark(host, on) {
      host.classList.toggle('speaking', on);
      if (on && !host.querySelector(':scope > .spk')) { var s = document.createElement('span'); s.className = 'spk'; s.innerHTML = ICON_SPK; host.appendChild(s); }
    }
    var ICON_SPK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/></svg>';
    return {
      track: set,
      on: function (k) { return !!(items[k] && items[k].on); },
      listen: function (fn) { fns.push(fn); },
      auto: function (videoSel, hostSel) { autos.push({ v: videoSel, h: hostSel }); if (!timer) timer = setInterval(loop, 140); },
      mark: mark, ICON: ICON_SPK
    };
  })();

  /* ───────── 휴대폰 키보드가 입력 칸을 가리지 않게(모든 화면 공통) ─────────
   * 키보드가 올라오면 그만큼 아래 여백을 만들어 스크롤할 수 있게 하고, 입력 중인 칸을 보이는 영역 가운데로 옮김 */
  (function keyboardSafe() {
    var vv = window.visualViewport;
    var isField = function (el) { return el && (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|file)$/i.test(el.type) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'); };
    try {
      var st = document.createElement('style');
      st.textContent = 'body.kb-open{padding-bottom:var(--kb,0px)!important}';
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}
    function kbH() { return vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0; }
    function show(el) {
      if (!isField(el) || !document.body.contains(el)) return;
      var r = el.getBoundingClientRect();
      var top = vv ? vv.offsetTop : 0, bottom = top + (vv ? vv.height : window.innerHeight);
      var box = el.closest('label, .field') || el, rb = box.getBoundingClientRect();
      if (rb.bottom > bottom - 12 || r.top < top + 8) {
        try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { box.scrollIntoView(); }
      }
    }
    function apply() {
      var h = kbH(), open = h > 80 && isField(document.activeElement);
      document.documentElement.style.setProperty('--kb', (open ? h : 0) + 'px');
      if (document.body) document.body.classList.toggle('kb-open', open);
      if (open) show(document.activeElement);
    }
    if (vv) { vv.addEventListener('resize', apply); vv.addEventListener('scroll', function () { if (document.body && document.body.classList.contains('kb-open')) apply(); }); }
    window.addEventListener('resize', apply);
    document.addEventListener('focusin', function (e) {
      if (!isField(e.target)) return;
      [120, 350, 700].forEach(function (t) { setTimeout(function () { apply(); show(e.target); }, t); });   // 키보드가 올라오는 동안 몇 번 확인
    });
    document.addEventListener('focusout', function () { setTimeout(apply, 200); });
  })();

  window.Meet = { CFG: CFG, api: api, Session: Session, Links: Links, Media: Media, UI: UI, ICON: ICON, sleep: sleep, NONCE: NONCE, DeviceCheck: DeviceCheck, Speak: Speak };
})();
