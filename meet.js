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
  }
  Session.prototype.on = function (ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); };
  Session.prototype.emit = function (ev) {
    var args = [].slice.call(arguments, 1);
    (this.ls[ev] || []).forEach(function (f) { try { f.apply(null, args); } catch (e) { console.error(e); } });
  };
  Session.prototype.join = function () {
    var self = this;
    return api({ a: 'join', r: this.r, role: this.role, name: this.name, code: this.code }).then(function (j) {
      if (!j.ok) { var e = new Error(j.error); e.code = j.error; throw e; }
      self.id = j.id; self.tok = j.tok; self.ice = j.ice; self.name = j.name;
      self.offset = j.now - Date.now();
      return j;
    });
  };
  Session.prototype.now = function () { return Date.now() + this.offset; };
  Session.prototype.rejoin = function () {
    var self = this;
    return this.join().then(function () { self.emit('rejoin'); });
  };
  Session.prototype.boost = function (ms) { this.fastUntil = Math.max(this.fastUntil, Date.now() + (ms || 10000)); };
  Session.prototype.send = function (to, msg) { this.outbox.push({ to: to, msg: msg }); this.flush(); };
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
            if (j.error === 'auth') await this.rejoin();
          } catch (e) { await sleep(700 * (i + 1)); }
        }
      }
    } finally { this.flushing = false; }
  };
  Session.prototype.op = async function (cmd, args) {
    var body = Object.assign({ a: 'op', r: this.r, id: this.id, tok: this.tok, cmd: cmd }, args || {});
    var j = await api(body);
    if (!j.ok && j.error === 'auth') { await this.rejoin(); body.id = this.id; body.tok = this.tok; j = await api(body); }
    this.boost(4000);
    return j;
  };
  Session.prototype.start = function () { if (!this.running) { this.running = true; this.loop(); } };
  Session.prototype.stop = function () { this.running = false; };
  Session.prototype.loop = async function () {
    var fails = 0;
    while (this.running) {
      var t0 = Date.now();
      try {
        var j = await api({ a: 'poll', r: this.r, id: this.id, tok: this.tok, info: this.info }, 15000);
        if (j.ok) {
          fails = 0;
          this.offset = j.now - (t0 + Date.now()) / 2;
          if (j.msgs && j.msgs.length) this.boost(10000);
          for (var k = 0; k < (j.msgs || []).length; k++) this.emit('msg', j.msgs[k]);
          this.view = j.view;
          this.emit('view', j.view);
          this.emit('net', true, 0);
        } else if (j.error === 'auth') {
          await this.rejoin();
        } else { fails++; this.emit('net', false, fails); }
      } catch (e) { fails++; this.emit('net', false, fails); }
      var base = Date.now() < this.fastUntil ? 900 : this.interval;
      var wait = Math.max(150, base - (Date.now() - t0)) + (fails ? Math.min(6000, fails * 1000) : 0);
      await sleep(wait);
    }
  };

  /* ───────── 연결 정보 모으기(한 번에 보내기) ───────── */
  function gather(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(function (res) {
      var done = function () {
        clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', chk);
        pc.removeEventListener('icecandidate', cand);
        res();
      };
      var chk = function () { if (pc.iceGatheringState === 'complete') done(); };
      var cand = function (e) { if (!e.candidate) done(); };
      var t = setTimeout(done, ms || 5000);
      pc.addEventListener('icegatheringstatechange', chk);
      pc.addEventListener('icecandidate', cand);
    });
  }

  /* ───────── 연결 관리 ─────────
   * kind: 'ms'   멘토↔학생 (멘토가 먼저 연결 요청, 양방향)
   *       'view' 운영진 관람 (운영진이 요청, 운영진은 받기만)
   *       'test' 연결 점검 (녹화 담당 운영진이 요청, 데이터만)
   */
  function Links(sess, o) {
    this.s = sess;
    this.map = new Map();
    this.getLocal = o.getLocal || function () { return null; };
    this.onRemote = o.onRemote || function () {};
    this.onChange = o.onChange || function () {};
    this.onData = o.onData || function () {};
    var self = this;
    sess.on('msg', function (m) { self.onMsg(m).catch(function (e) { console.warn('msg', e); }); });
    this.watch = setInterval(function () { self.watchdog(); }, 2000);
  }
  Links.prototype.key = function (kind, peer) { return kind + ':' + peer; };
  Links.prototype.get = function (kind, peer) { return this.map.get(this.key(kind, peer)); };
  Links.prototype.all = function () { return Array.from(this.map.values()); };
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
    this.map.set(this.key(kind, peer), L);
    return L;
  };

  Links.prototype.wireDc = function (L) {
    var self = this;
    L.dc.onopen = function () { L.dcOpen = true; self.onData(L, 'open'); };
    L.dc.onmessage = function (e) { self.onData(L, 'msg', e.data); };
  };

  Links.prototype.offer = async function (kind, peer, peerNonce) {
    this.close(kind, peer, true);
    var L = this.make(kind, peer, rid(), 'offer', peerNonce);
    var pc = L.pc;
    if (kind === 'ms') {
      var ls = this.getLocal();
      if (ls) ls.getTracks().forEach(function (t) { pc.addTrack(t, ls); });
      else { pc.addTransceiver('audio'); pc.addTransceiver('video'); }
    } else if (kind === 'view') {
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    } else {
      L.dc = pc.createDataChannel('t');
      this.wireDc(L);
    }
    var off = await pc.createOffer();
    await pc.setLocalDescription(off);
    await gather(pc);
    if (L.closed) return L;
    this.s.send(peer, { t: 'offer', cid: L.cid, kind: kind, sdp: pc.localDescription.sdp });
    this.s.boost(20000);
    this.onChange(L);
    return L;
  };

  Links.prototype.onMsg = async function (m) {
    if (m.t === 'offer') {
      var old = this.get(m.kind, m.from);
      if (old) this.close(m.kind, m.from, false);
      var L = this.make(m.kind, m.from, m.cid, 'answer');
      var pc = L.pc;
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      if (m.kind === 'ms' || m.kind === 'view') {
        var ls = this.getLocal();
        if (ls) ls.getTracks().forEach(function (t) { pc.addTrack(t, ls); });
      }
      var ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await gather(pc);
      if (L.closed) return;
      this.s.send(m.from, { t: 'answer', cid: m.cid, sdp: pc.localDescription.sdp });
      this.s.boost(15000);
      this.onChange(L);
    } else if (m.t === 'answer') {
      var A = this.byCid(m.cid);
      if (A && A.role === 'offer' && A.pc.signalingState === 'have-local-offer') {
        await A.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      }
    } else if (m.t === 'bye') {
      var B = this.byCid(m.cid);
      if (B) this.close(B.kind, B.peer, false);
    }
  };

  Links.prototype.close = function (kind, peer, notify) {
    var L = this.get(kind, peer);
    if (!L) return;
    L.closed = true;
    try { L.pc.close(); } catch (e) {}
    this.map.delete(this.key(kind, peer));
    if (notify) this.s.send(peer, { t: 'bye', cid: L.cid });
    L.state = 'closed';
    this.onChange(L);
  };
  Links.prototype.closeWhere = function (fn, notify) {
    var self = this;
    this.all().filter(fn).forEach(function (L) { self.close(L.kind, L.peer, notify); });
  };

  // 오래 안 붙거나 끊긴 연결은 정리 → 요청 쪽이 다음 확인 때 다시 연결
  Links.prototype.watchdog = function () {
    var now = Date.now(), self = this;
    this.all().forEach(function (L) {
      var neverTimeout = L.kind === 'test' ? 20000 : 25000;
      if (!L.connectedAt && now - L.created > neverTimeout) {
        L.state = 'timeout'; self.onChange(L); self.close(L.kind, L.peer, true);
      } else if (L.connectedAt && L.badSince && now - L.badSince > (L.state === 'failed' ? 1500 : 9000)) {
        self.close(L.kind, L.peer, true);
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

  // 카메라 전환 등 내 트랙이 바뀌면 모든 연결에 반영
  Links.prototype.replaceLocal = function (stream) {
    this.all().forEach(function (L) {
      if (L.kind === 'test' || !stream) return;
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
      var video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
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

  window.Meet = { CFG: CFG, api: api, Session: Session, Links: Links, Media: Media, UI: UI, ICON: ICON, sleep: sleep, NONCE: NONCE, DeviceCheck: DeviceCheck };
})();
