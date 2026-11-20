/* K예술영재 온라인 멘토링 — 시연 조종판
 * 진짜 학생·멘토 화면을 이 페이지 안에 여러 개 띄우고, 가상 카메라·가상 목소리로 자동으로 움직입니다.
 * - 실제 회차와 섞이지 않게 시연 회차 demo 에서만 진행(Apps Script 무용 Ver.2.7 · 미술 Ver.1.5 필요)
 * - 운영자·연구원은 각자 PC에서 진짜 운영 화면(o.html?r=demo)으로 들어옵니다
 */
(function () {
  'use strict';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  var pick = function (l) { return l[Math.floor(Math.random() * l.length)]; };
  var now = function () { return Date.now() + S.offset; };
  var GL = function (g) { return 'ABCDEFGHI'.charAt(g - 1) || g; };   // 조 이름(A조…)

  /* ───────── 설정 ───────── */
  var API = { b: (window.B_CFG || {}).API, a: (window.A_CFG || {}).API };
  // 진행 속도: 무용은 학생 1명 멘토링 시간, 미술은 전체·분반·마무리 단계 시간(분)
  var SPEED = {
    fast: { label: '빠르게', slot: 2, all: 1.5, group: 2.5, all2: 1 },
    normal: { label: '보통', slot: 3, all: 2, group: 4, all2: 1.5 },
    slow: { label: '여유 있게', slot: 5, all: 4, group: 7, all2: 3 }
  };
  var DANCE_MENTOR = '정다온';
  var LATE_NO = 3, DROP_NO = 6;          // 무용: 3번 학생은 늦게 입장, 6번 학생은 멘토링 중 연결이 잠깐 끊김

  var S = {                               // 시연 상태
    field: 'b', code: '', speed: 'normal', auto: true, running: false, offset: 0,
    plan: null, ops: null, view: null, t0: 0, events: {}, steps: [], sel: null, big: null, sound: false
  };
  var BOTS = [], BOT = {};
  var AC = null;                          // 가상 목소리용 오디오(시작 버튼을 누를 때 만듦)

  /* ───────── Apps Script 통신 ───────── */
  function api(body) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 25000);
    return fetch(API[S.field], { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, cache: 'no-store', signal: ctl.signal })
      .then(function (r) { return r.json(); }).finally(function () { clearTimeout(t); });
  }
  function demoCmd(cmd, extra) { return api(Object.assign({ a: 'demo', r: 'demo', code: S.code, cmd: cmd }, extra || {})); }
  // 자동 진행용 운영 창(영상은 받지 않는 「대기실 창」으로 들어감 → 다른 사람이 이 창으로 영상을 보내지 않음)
  async function opsJoin() {
    var j = await api({ a: 'join', r: 'demo', role: 'ops', name: '시연자동진행', code: S.code, panel: 1 });
    if (!j.ok) throw new Error(j.error || 'join');
    S.ops = { id: j.id, tok: j.tok }; S.offset = j.now - Date.now();
  }
  async function op(cmd, args) {
    if (!S.ops) return null;
    var j = await api(Object.assign({ a: 'op', r: 'demo', id: S.ops.id, tok: S.ops.tok, cmd: cmd }, args || {})).catch(function () { return null; });
    S.lastOp = { cmd: cmd, res: j && (j.ok ? 'ok' : j.error) };
    if (!j || (!j.ok && /auth|forbidden/.test(j.error || ''))) {   // 다시 들어가서 한 번 더
      await opsJoin().catch(function () {});
      j = await api(Object.assign({ a: 'op', r: 'demo', id: S.ops.id, tok: S.ops.tok, cmd: cmd }, args || {})).catch(function () { return null; });
    }
    pollSoon();
    return j;
  }
  var pollT = 0, polling = false;
  function pollSoon() { clearTimeout(pollT); pollT = setTimeout(poll, 300); }
  async function poll() {
    clearTimeout(pollT);
    if (!S.running || !S.ops || polling) { if (S.running) pollT = setTimeout(poll, 2500); return; }
    polling = true;
    try {
      var j = await api({ a: 'poll', r: 'demo', id: S.ops.id, tok: S.ops.tok, info: {} });
      if (j && j.ok) { S.view = j.view; if (j.now) S.offset = j.now - Date.now(); }
      else if (j && /auth/.test(j.error || '')) await opsJoin();
    } catch (e) {}
    polling = false;
    if (S.running) pollT = setTimeout(poll, 2500);
  }

  /* ───────── 가상 카메라 ───────── */
  var HUES = [206, 268, 330, 18, 152, 46, 190, 292, 0, 120, 236, 30, 176, 312, 88, 252];
  function mkCanvas(bot) {
    var c = document.createElement('canvas');
    c.width = bot.kind === 'men' ? 640 : 400; c.height = bot.kind === 'men' ? 480 : 300;   // 학생은 작게(시연 PC 부담 줄이기)
    bot.canvas = c; bot.ctx = c.getContext('2d');
    bot.hue = HUES[(bot.no - 1 + (bot.kind === 'men' ? 7 : 0)) % HUES.length];
    bot.ph = Math.random() * 6;
    paint(bot, performance.now());
    bot.vtrack = c.captureStream(bot.kind === 'men' ? 12 : 10).getVideoTracks()[0];
  }
  function paint(bot, t) {
    var c = bot.ctx, W = bot.canvas.width, H = bot.canvas.height, h = bot.hue;
    var art = bot.field === 'a';
    // 방: 무용은 연습실(벽·나무 바닥·바), 미술은 작업실(벽·이젤 위 그림)
    var g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'hsl(' + h + ',22%,' + (art ? 30 : 24) + '%)'); g.addColorStop(1, 'hsl(' + h + ',26%,' + (art ? 18 : 13) + '%)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    if (!art) {
      c.fillStyle = 'hsl(30,30%,22%)'; c.fillRect(0, H * .78, W, H * .22);
      c.strokeStyle = 'rgba(255,255,255,.13)'; c.lineWidth = W * .012;
      c.beginPath(); c.moveTo(0, H * .52); c.lineTo(W, H * .52); c.stroke();
    } else {
      var ex = W * .74, ey = H * .2;
      c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(ex - 4, ey - 4, W * .2 + 8, H * .34 + 8);
      c.fillStyle = 'hsl(' + ((h + 40) % 360) + ',35%,82%)'; c.fillRect(ex, ey, W * .2, H * .34);
      c.fillStyle = 'hsl(' + ((h + 180) % 360) + ',60%,55%)'; c.beginPath(); c.arc(ex + W * .07, ey + H * .13, W * .045, 0, 7); c.fill();
      c.fillStyle = 'hsl(' + ((h + 90) % 360) + ',55%,45%)'; c.fillRect(ex + W * .09, ey + H * .17, W * .08, H * .12);
    }
    // 사람(실루엣): 숨 쉬듯 살짝 흔들림, 말할 때 고개 끄덕임, 무용 학생은 팔 동작
    var cx = W * (art ? .42 : .5) + Math.sin(t / 1600 + bot.ph) * W * .012;
    var talk = bot.sylOn ? Math.sin(t / 70) * H * .006 : 0;
    var by = H * .58 + Math.sin(t / 1100 + bot.ph) * H * .006;
    var sk = 'hsl(' + ((h + 25) % 360) + ',18%,72%)', cl = 'hsl(' + h + ',45%,' + (bot.kind === 'men' ? 40 : 56) + '%)';
    if (bot.dance) {
      var a = Math.sin(t / 900 + bot.ph) * .9;
      c.strokeStyle = sk; c.lineCap = 'round'; c.lineWidth = W * .045;
      [-1, 1].forEach(function (s) {
        var sx = cx + s * W * .12, sy = by + H * .02, ang = -Math.PI / 2 + s * (1.1 + a * (s > 0 ? 1 : -.6));
        c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + Math.cos(ang) * W * .2, sy + Math.sin(ang) * H * .3); c.stroke();
      });
    }
    c.fillStyle = cl;
    c.beginPath(); c.ellipse(cx, by + H * .36, W * .24, H * .4, 0, Math.PI, 0); c.fill();
    c.fillStyle = sk; c.fillRect(cx - W * .03, by - H * .09, W * .06, H * .1);
    c.beginPath(); c.ellipse(cx, by - H * .2 + talk, W * .085, H * .145, 0, 0, 7); c.fill();
    c.fillStyle = 'hsl(' + h + ',20%,16%)';
    c.beginPath(); c.ellipse(cx, by - H * .27 + talk, W * .09, H * .085, 0, Math.PI, 0); c.fill();
    // 이름표(화면 위 가운데 — 각 화면의 이름 칸과 겹치지 않게)
    var lb = (bot.kind === 'men' ? '가상 멘토 ' : '가상 학생 ') + bot.name;
    c.font = '600 ' + Math.round(H * .045) + 'px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    var tw = c.measureText(lb).width + H * .06, th = H * .075;
    c.fillStyle = 'rgba(0,0,0,.42)'; c.beginPath(); c.roundRect ? c.roundRect((W - tw) / 2, H * .035, tw, th, th / 2) : c.rect((W - tw) / 2, H * .035, tw, th); c.fill();
    c.fillStyle = 'rgba(255,255,255,.92)'; c.textBaseline = 'middle'; c.textAlign = 'center';
    c.fillText(lb, W / 2, H * .035 + th / 2); c.textAlign = 'left';
  }
  setInterval(function () {
    var t = performance.now();
    BOTS.forEach(function (b) { if (b.on && b.canvas) paint(b, t); });
  }, 83);

  /* ───────── 가상 목소리(웅얼거림) ───────── */
  var VOWELS = [[730, 1090], [270, 2290], [300, 870], [530, 1840], [570, 840], [440, 1020], [660, 1700]];
  function mkVoice(bot) {
    if (!AC) return;
    var o = AC.createOscillator(); o.type = 'sawtooth';
    bot.f0 = bot.kind === 'men' ? rnd(110, 150) : rnd(190, 260);
    o.frequency.value = bot.f0;
    var f1 = AC.createBiquadFilter(), f2 = AC.createBiquadFilter(), mix = AC.createGain(), syl = AC.createGain(), dest = AC.createMediaStreamDestination();
    f1.type = f2.type = 'bandpass'; f1.Q.value = 5; f2.Q.value = 8; mix.gain.value = 3.2; syl.gain.value = 0;
    o.connect(f1); o.connect(f2); f1.connect(mix); f2.connect(mix); mix.connect(syl); syl.connect(dest); o.start();
    bot.voice = { o: o, f1: f1, f2: f2, syl: syl };
    bot.atrack = dest.stream.getAudioTracks()[0];
  }
  setInterval(function () {
    if (!AC) return;
    var t = Date.now();
    BOTS.forEach(function (b) {
      if (!b.voice) return;
      if (b.talking && t > b.talkUntil) stopTalk(b);
      if (!b.talking) { b.sylOn = false; return; }
      if (t < b.nextSyl) return;
      var v = b.voice, at = AC.currentTime, d = rnd(.09, .2), vw = pick(VOWELS);
      v.f1.frequency.setTargetAtTime(vw[0], at, .02); v.f2.frequency.setTargetAtTime(vw[1], at, .02);
      v.o.frequency.setTargetAtTime(b.f0 * rnd(.88, 1.15), at, .05);
      v.syl.gain.cancelScheduledValues(at);
      v.syl.gain.setTargetAtTime(.55, at, .015); v.syl.gain.setTargetAtTime(0, at + d, .03);
      b.sylOn = true; setTimeout(function () { b.sylOn = false; }, d * 1000);
      b.nextSyl = t + d * 1000 + (Math.random() < .14 ? rnd(250, 520) : rnd(25, 90));
    });
  }, 40);

  /* ───────── 진짜 화면에 끼워 넣는 고리(페이지 맨 앞에서 부름) ───────── */
  function store() {
    var m = {};
    return { getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }, clear: function () { m = {}; }, key: function (i) { return Object.keys(m)[i] || null; },
      get length() { return Object.keys(m).length; } };
  }
  window.DEMO_HOOK = function (win) {
    var fe = win.frameElement, bot = fe && BOT[fe.getAttribute('data-bot')];
    if (!bot) return;
    bot.win = win; bot.issued = []; bot.gateAt = 0; bot.checkAt = 0;
    win.DEMO_LIGHT = S.big !== bot.id;   // 다른 사람 영상은 받지 않음(크게 볼 때만 받음)
    try { Object.defineProperty(win, 'sessionStorage', { value: bot.ss, configurable: true }); } catch (e) {}
    try { Object.defineProperty(win, 'localStorage', { value: store(), configurable: true }); } catch (e) {}
    var md = win.navigator.mediaDevices;
    if (!md) return;
    md.getUserMedia = function (c) {
      c = c || {};
      var tr = [];
      if (c.video && bot.vtrack) tr.push(bot.vtrack.clone());
      if (c.audio && bot.atrack) tr.push(bot.atrack.clone());
      tr.forEach(function (x) { bot.issued.push(x); });
      return Promise.resolve(new win.MediaStream(tr));
    };
    md.enumerateDevices = function () {
      return Promise.resolve([{ kind: 'videoinput', deviceId: 'demo-cam', groupId: 'demo', label: '시연용 가상 카메라' },
                              { kind: 'audioinput', deviceId: 'demo-mic', groupId: 'demo', label: '시연용 가상 마이크' }]);
    };
  };

  /* ───────── 가상 참가자 ───────── */
  function Bot(o) {
    Object.assign(this, o);
    this.id = (o.kind === 'men' ? 'm' : 's') + o.no;
    this.ss = store(); this.on = false; this.status = '입장 전'; this.talking = false; this.talkUntil = 0; this.nextSyl = 0;
    this.issued = []; this.err = '';
  }
  Bot.prototype.url = function () {
    return '../' + this.field + '/' + (this.kind === 'men' ? 'm.html' : 'index.html') + '?r=demo';
  };
  Bot.prototype.enter = function () {
    if (this.on) return;
    if (!this.canvas) mkCanvas(this);
    if (!this.voice) mkVoice(this);
    this.on = true; this.status = '입장하는 중'; this.err = ''; this.left = false;
    this.frame.src = this.url();
    paintTile(this);
  };
  Bot.prototype.leave = function (keep) {
    if (!this.on) return;
    stopTalk(this);
    this.on = false; this.win = null; this.status = keep ? '연결 끊김' : '나감'; this.left = !keep;
    if (!keep) this.ss = store();
    this.frame.src = 'about:blank';
    if (S.big === this.id) closeBig();
    paintTile(this);
  };
  // 연결 끊김 흉내: 창이 닫혔다가 8초 뒤 다시 열림(새로고침과 같아서 자동으로 다시 들어옴)
  Bot.prototype.drop = function () {
    var self = this;
    if (!this.on) return;
    this.leave(true);
    setTimeout(function () { if (!self.left && S.running) self.enter(); }, 8000);
  };
  function doc(bot) { try { return bot.win && bot.win.document; } catch (e) { return null; } }
  function vis(d, id) { var e = d && d.getElementById(id); return !!(e && e.getClientRects().length); }
  function setv(bot, d, sel, v) { var e = d.querySelector(sel); if (!e) return; e.value = v; e.dispatchEvent(new bot.win.Event('input', { bubbles: true })); }
  function submit(f) { if (!f) return; if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true })); }

  // 화면 상태 읽기 + 입장 절차 자동 진행
  function scan(bot) {
    var d = doc(bot);
    if (!bot.on || !d || !d.body || d.readyState !== 'complete') return;   // 화면 스크립트가 다 준비된 뒤에만 누름
    var t = Date.now(), st = bot.status;
    if (vis(d, 's-gate')) {
      st = '입장 화면';
      var er = (d.getElementById('g-err') || {}).textContent || '';
      bot.err = er.trim();
      if (t - bot.gateAt > (bot.err ? 6000 : 15000)) {
        bot.gateAt = t;
        if (bot.kind === 'stu') {
          setv(bot, d, '#g-name', bot.name); setv(bot, d, '#g-birth', '20120101');
          var ag = d.getElementById('g-agree'); if (ag) ag.checked = true;
        } else {
          setv(bot, d, '#g-name', bot.name); setv(bot, d, '#g-code', S.code);
          var rm = d.getElementById('g-room'); if (rm && !rm.value) rm.value = 'demo';
        }
        submit(d.getElementById('f-gate'));
      }
    } else if (vis(d, 's-check')) {
      st = '장치 확인'; bot.err = '';
      var cb = d.getElementById('c-btn');
      if (cb && !cb.disabled && t - bot.checkAt > 8000) { bot.checkAt = t; submit(d.getElementById('f-check')); }
    } else if (vis(d, 's-live')) st = '멘토링 중';
    else if (vis(d, 's-end')) st = '멘토링 마침';
    else if (vis(d, 'room')) st = '대기실';
    else if (vis(d, 's-main')) st = (S.view && S.view.cur) ? '멘토링 진행' : '멘토링실 대기';
    else if (vis(d, 's-room')) {
      var mv = d.getElementById('t-move');
      st = mv && mv.getClientRects().length && /끝났/.test(mv.textContent) ? '멘토링 마침' : '접속 · ' + (((d.getElementById('t-room') || {}).textContent || '').trim() || '방');
    }
    bot.status = st;
    // 크게 볼 때는 화면 소리를 들을 수 있게, 그 밖에는 시연 PC에서 소리가 나지 않게
    var loud = S.sound && S.big === bot.id;
    d.querySelectorAll('video,audio').forEach(function (m) { if (!m.muted) m.volume = loud ? 1 : 0; });
  }
  // 말하기: 화면의 마이크가 꺼져 있으면 켜고, 다 말하면 원래대로
  function micTracks(bot) { return bot.issued.filter(function (x) { return x.kind === 'audio' && x.readyState === 'live'; }); }
  function micBtn(bot) {
    var d = doc(bot); if (!d) return null;
    var l = ['#b-mic', '#w-mic'].map(function (s) { return d.querySelector(s); }).filter(function (e) { return e && e.getClientRects().length; });
    return l[0] || null;
  }
  function talk(bot, ms) {
    if (!bot.on || !bot.voice) return;
    if (AC && AC.state !== 'running') AC.resume();
    var tr = micTracks(bot);
    if (tr.length && !tr.some(function (x) { return x.enabled; })) { var b = micBtn(bot); if (b) { b.click(); bot.micByUs = true; } }
    bot.talking = true; bot.talkUntil = Date.now() + ms; bot.nextSyl = 0;
    paintTile(bot);
  }
  function stopTalk(bot) {
    if (!bot.talking) return;
    bot.talking = false; bot.sylOn = false;
    if (bot.voice && AC) { bot.voice.syl.gain.cancelScheduledValues(AC.currentTime); bot.voice.syl.gain.setTargetAtTime(0, AC.currentTime, .02); }
    if (bot.micByUs) {
      bot.micByUs = false;
      var tr = micTracks(bot);
      if (tr.some(function (x) { return x.enabled; })) { var b = micBtn(bot); if (b) b.click(); }
    }
    paintTile(bot);
  }
  function hand(bot, on) {
    var d = doc(bot), b = d && d.getElementById('b-hand');
    if (!b || !b.getClientRects().length) return false;
    if (!!b.dataset.on !== !!on) b.click();
    return true;
  }
  // 작품 사진: 그림을 하나 그려서 화면의 「작품 사진 올리기」로 올림(드라이브 「시연」 폴더에 저장됨)
  function photo(bot) {
    var d = doc(bot), inp = d && d.getElementById('s-file');
    if (!inp) return false;
    var c = document.createElement('canvas'); c.width = 1200; c.height = 900;
    var x = c.getContext('2d'), h = bot.hue;
    x.fillStyle = 'hsl(' + ((h + 30) % 360) + ',30%,88%)'; x.fillRect(0, 0, 1200, 900);
    for (var i = 0; i < 14; i++) {
      x.fillStyle = 'hsla(' + ((h + i * 37) % 360) + ',' + rnd(40, 75) + '%,' + rnd(35, 65) + '%,' + rnd(.55, .9) + ')';
      x.beginPath();
      if (i % 3) x.ellipse(rnd(100, 1100), rnd(100, 800), rnd(40, 240), rnd(30, 180), rnd(0, 3), 0, 7); else x.rect(rnd(0, 900), rnd(0, 650), rnd(80, 320), rnd(60, 260));
      x.fill();
    }
    x.fillStyle = 'rgba(0,0,0,.55)'; x.font = '600 34px sans-serif'; x.fillText('시연용 가상 작품 · ' + bot.name, 40, 860);
    c.toBlob(function (blob) {
      try {
        var w = bot.win, f = new w.File([blob], 'demo-' + bot.no + '.jpg', { type: 'image/jpeg' }), dt = new w.DataTransfer();
        dt.items.add(f); inp.files = dt.files; inp.dispatchEvent(new w.Event('change', { bubbles: true }));
      } catch (e) { console.warn('photo', e); }
    }, 'image/jpeg', .85);
    return true;
  }
  setInterval(function () { if (S.running) BOTS.forEach(function (b) { try { scan(b); } catch (e) {} }); }, 900);

  /* ───────── 시나리오 ───────── */
  function hm2ms(hm) {
    var day = new Date(now() + 9 * 3600e3).toISOString().slice(0, 10);
    return new Date(day + 'T' + hm + ':00+09:00').getTime();
  }
  function ev(k) { if (!S.events[k]) S.events[k] = now(); return S.events[k]; }
  function did(k) { return !!S.events[k]; }
  var CONV = {};
  // 대화: 사람들이 번갈아 말함(한 번에 한 명)
  function converse(key, people, durOf, chooser) {
    people = people.filter(function (p) { return p && p.on && p.voice; });
    if (!people.length) return;
    var c = CONV[key] || (CONV[key] = { next: Date.now() + 1500, last: null, n: 0 });
    if (Date.now() < c.next || people.some(function (p) { return p.talking; })) return;
    var p = chooser ? chooser(c, people) : people.filter(function (x) { return x !== c.last; })[0] || people[0];
    if (!p) return;
    var d = durOf(p, c); talk(p, d);
    c.last = p; c.n++; c.next = Date.now() + d + rnd(500, 1600);
  }
  function stu(no) { return BOT['s' + no]; }
  function men(no) { return BOT['m' + no]; }

  /* 무용: 대기실 입장 → 운영진 「시작」(자동이면 조종판이) → 멘토링실 → 다음 학생 … */
  function danceSteps() {
    var sp = SPEED[S.speed], n = BOTS.filter(function (b) { return b.kind === 'stu'; }).length;
    var done = S.view ? (S.view.students || []).filter(function (s) { return s.done; }).length : 0;
    var cur = S.view && S.view.cur;
    return [
      { k: 'enter', t: '가상 학생이 차례로 대기실에 들어옵니다', on: did('enter') },
      { k: 'mentor', t: '가상 멘토가 멘토링실에 들어옵니다', on: did('mentor') },
      { k: 'first', t: '첫 학생 멘토링 시작(학생이 멘토링실로 이동)', on: did('first') },
      { k: 'late', t: LATE_NO + '번 학생 지각 → 늦게 입장(운영 화면 빨간 테두리·전화)', on: did('late') },
      { k: 'drop', t: DROP_NO + '번 학생 멘토링 중 연결 끊김 → 다시 연결', on: did('dropBack') },
      { k: 'loop', t: '학생 1명당 ' + (S.plan ? S.plan.slot : sp.slot) + '분씩 차례로 진행 (' + done + '/' + n + ')' + (cur ? ' · 지금 ' + cur.name : ''), on: done >= n },
      { k: 'fin', t: '모든 멘토링 마침 → 멘토 퇴장', on: did('fin') }
    ];
  }
  var lastEnd = 0, endFor = '';
  function danceTick() {
    var v = S.view, t = now(), sp = SPEED[S.speed];
    var studs = BOTS.filter(function (b) { return b.kind === 'stu'; }), m = men(1);
    // 입장: 대부분은 처음에, 뒤쪽 학생은 자기 대기 시간에, LATE_NO 학생은 자기 차례가 지난 뒤
    if (S.auto) {
      studs.forEach(function (b) {
        if (b.on || b.left || b.entered) return;
        var due = b.no === LATE_NO ? (did('first') ? hm2ms(b.time) + 40000 : Infinity)
          : b.no <= 8 ? S.t0 + 2500 + b.no * 3500 : Math.max(S.t0 + 40000, hm2ms(b.wait));
        if (t >= due) { b.entered = true; b.enter(); ev('enter'); if (b.no === LATE_NO) ev('late'); }
      });
      if (m && !m.on && !m.left && !m.entered && t >= S.t0 + 6000) { m.entered = true; m.enter(); ev('mentor'); }
    }
    if (!v) return;
    var cur = v.cur, list = v.students || [];
    if (S.auto && m && m.on) {
      if (cur) {
        var el = t - cur.at;
        if (el >= S.plan.slot * 60000 && endFor !== cur.id + cur.at) {
          endFor = cur.id + cur.at; lastEnd = t;
          var cb = BOTS.filter(function (b) { return 'S_' + b.name === cur.id; })[0];
          op('end');
          if (cb) setTimeout(function () { cb.leave(); }, 9000);   // 마친 학생은 잠시 뒤 창을 닫음
        }
        // 연결 끊김 시연
        var cbot = BOTS.filter(function (b) { return 'S_' + b.name === cur.id; })[0];
        if (cbot && cbot.no === DROP_NO && !did('drop') && el > S.plan.slot * 60000 * .35) { ev('drop'); cbot.drop(); }
      } else if (t >= hm2ms(S.plan.first) - 20000 && t - lastEnd > 7000) {
        var nx = list.filter(function (s) { return !s.done && s.live && !s.zoom; })[0];
        if (nx && t - (S.lastCall || 0) > 8000) { S.lastCall = t; op('call', { sid: nx.id, at: t }); ev('first'); }
      }
      if (!cur && list.length && list.every(function (s) { return s.done; }) && !did('fin')) {
        ev('fin'); setTimeout(function () { if (m) m.leave(); }, 8000);
      }
    }
    if (cur && cur.live) {
      var c2 = BOTS.filter(function (b) { return 'S_' + b.name === cur.id; })[0];
      if (c2 && c2.status === '멘토링 중' && did('drop') && c2.no === DROP_NO) ev('dropBack');
      if (c2 && m && /멘토링/.test(m.status)) {
        converse('live|' + cur.id, [m, c2], function (p) { return p === m ? rnd(5000, 10000) : rnd(3000, 6500); });
        c2.dance = !!(m.talking && (Math.floor(t / 15000) % 2));   // 멘토 설명 중에는 가끔 동작을 해 봄
      }
    }
    // 대기실: 가끔 한 학생이 짧게 말함(말하는 사람 표시 시연)
    if (S.auto) {
      var waiting = studs.filter(function (b) { return b.on && b.status === '대기실'; });
      converse('wait', waiting, function () { return rnd(2500, 4000); }, function (c, l) { return l[Math.floor(Math.random() * l.length)]; });
      if (CONV.wait && CONV.wait.next < Date.now() + 1000) CONV.wait.next = Date.now() + rnd(25000, 45000);
    }
  }

  /* 미술: 입장 → 전체 → 분반(조별: 손들기·작품 사진) → 다시 전체 → 마침·모두 퇴장 */
  var ART_STEPS = [
    { k: 'enter', t: '가상 멘토 4명·학생이 차례로 들어옵니다', phase: null },
    { k: 'all', t: '전체 멘토링(A조 멘토가 설명)', phase: 'all' },
    { k: 'group', t: '분반 — 조별 방으로 이동 · 손들기 · 작품 사진', phase: 'group' },
    { k: 'all2', t: '다시 전체 — 조별 발표·마무리', phase: 'all' },
    { k: 'end', t: '마침 · 모두 퇴장', phase: 'end' }
  ];
  function artSteps() {
    return ART_STEPS.map(function (s, i) { return { k: s.k, t: s.t, on: did('art:' + s.k), cur: S.artStep === i }; });
  }
  async function artGo(i) {
    var st = ART_STEPS[i]; if (!st) return;
    S.artStep = i; S.artAt = now(); ev('art:' + st.k); CONV = {};
    if (st.k === 'enter') {
      BOTS.filter(function (b) { return b.kind === 'men'; }).forEach(function (b, k) { setTimeout(function () { if (!b.left) { b.entered = true; b.enter(); } }, 800 + k * 1500); });
      BOTS.filter(function (b) { return b.kind === 'stu'; }).forEach(function (b, k) {
        var late = b.no === BOTS.filter(function (x) { return x.kind === 'stu'; }).length;   // 마지막 학생은 늦게
        setTimeout(function () { if (!b.left && S.running) { b.entered = true; b.enter(); } }, late ? 75000 : 7000 + k * 2600);
      });
    } else if (st.k === 'end') {
      await op('closeall');
      setTimeout(function () { BOTS.forEach(function (b) { b.leave(); }); }, 15000);
    } else await op('phase', { to: st.phase });
    paintSteps();
  }
  function artTick() {
    var sp = SPEED[S.speed], t = now();
    if (S.auto && S.artStep != null) {
      var dur = [55000, sp.all * 60000, sp.group * 60000, sp.all2 * 60000][S.artStep];
      if (dur && t - S.artAt >= dur) artGo(S.artStep + 1);
    }
    var v = S.view, ph = v ? v.phase : 'ready';
    var studs = BOTS.filter(function (b) { return b.kind === 'stu' && b.on && /접속/.test(b.status); });
    var mens = BOTS.filter(function (b) { return b.kind === 'men' && b.on && /접속/.test(b.status); });
    var inPh = t - (S.artAt || t);
    if (ph === 'all') {
      var lead = S.artStep === 3 ? men(2) : men(1);
      // 설명 중간중간 학생 한 명이 손들고 질문
      converse('all|' + S.artStep, [lead].concat(studs), function (p) { return p.kind === 'men' ? rnd(7000, 13000) : rnd(3500, 6000); }, function (c, l) {
        var q = c.asker;
        if (q && q.handAt && Date.now() - q.handAt > 5000) { c.asker = null; q.handAt = 0; setTimeout(function () { hand(q, false); }, 4000); return q; }
        if (c.n % 4 === 3 && !c.asker && l.length > 1) { var a = pick(l.slice(1)); if (hand(a, true)) { a.handAt = Date.now(); c.asker = a; } }
        return l[0];
      });
    } else if (ph === 'group') {
      mens.forEach(function (mb) {
        var mine = studs.filter(function (s) { return s.g === mb.g; });
        converse('g' + mb.g, [mb].concat(mine), function (p) { return p.kind === 'men' ? rnd(5000, 9000) : rnd(3000, 6000); }, function (c, l) {
          if (c.last && c.last.kind === 'men' && l.length > 1) return pick(l.slice(1));
          return l[0];
        });
        // 조마다 한 번씩: 손들기, 작품 사진
        var k1 = 'hand' + mb.g, k2 = 'photo' + mb.g;
        if (S.auto && inPh > 15000 + mb.g * 4000 && !did(k1) && mine.length) { var hb = mine[mine.length - 1]; if (hand(hb, true)) { ev(k1); setTimeout(function () { hand(hb, false); }, 20000); } }
        if (S.auto && S.photos && inPh > 30000 + mb.g * 6000 && !did(k2) && mine.length) { if (photo(mine[0])) ev(k2); }
      });
    }
  }

  /* ───────── 시작·다시·끝 ───────── */
  async function start() {
    var code = $('#code').value.trim();
    if (!code) { msg('운영진 코드를 넣어 주세요.', true); $('#code').focus(); return; }
    if (!API[S.field]) { msg('config.js의 Apps Script 주소를 읽지 못했습니다.', true); return; }
    S.code = code; try { sessionStorage.setItem('demo_code', code); } catch (e) {}
    if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (AC && AC.state !== 'running') AC.resume();
    $('#b-start').disabled = true; msg('시연 회차를 만드는 중…');
    try {
      var sp = SPEED[S.speed];
      var Q = new URLSearchParams(location.search);   // 시험용: ?slot=1&lead=1
      var j = S.field === 'b' ? await demoCmd('plan', { n: 12, slot: Number(Q.get('slot')) || sp.slot, lead: Number(Q.get('lead')) || 2 }) : await demoCmd('plan', { n: 16, groups: 4 });
      if (!j || !j.ok) throw new Error(j && j.error || 'plan');
      S.plan = j.plan; S.events = {}; S.view = null; S.artStep = null; CONV = {}; lastEnd = 0; endFor = ''; S.lastCall = 0;
      await opsJoin();
      build(j.roster || [], j.mentors || []);
      S.running = true; S.t0 = now();
      document.body.classList.add('run');
      poll();
      if (S.field === 'a') artGo(0);
      msg(S.field === 'b' ? '시작했습니다. 첫 학생 멘토링은 ' + S.plan.first + '에 시작합니다.' : '시작했습니다. 멘토·학생이 들어오면 전체 멘토링으로 넘어갑니다.');
    } catch (e) {
      msg(e.message === 'code' ? '운영진 코드가 맞지 않습니다.' : /bad_action|plan/.test(e.message) ? '시연 회차를 만들지 못했습니다. Apps Script를 ' + (S.field === 'b' ? '무용 Ver.2.7' : '미술 Ver.1.5') + '로 새 버전 배포했는지 확인해 주세요.' : '연결하지 못했습니다. (' + e.message + ')', true);
    } finally { $('#b-start').disabled = false; paintAll(); }
  }
  async function stop(again) {
    S.running = false; document.body.classList.remove('run');
    BOTS.forEach(function (b) { b.leave(); });
    closeBig();
    try { await demoCmd(again ? 'reset' : 'off'); } catch (e) {}
    S.view = null; S.ops = null;
    if (again) return start();
    msg('시연을 끝냈습니다. 시연 회차를 닫았습니다.');
    paintAll();
  }

  /* ───────── 화면 ───────── */
  function msg(t, bad) { var e = $('#msg'); e.textContent = t || ''; e.classList.toggle('bad', !!bad); }
  function build(roster, mentors) {
    BOTS.forEach(function (b) { b.frame.src = 'about:blank'; });
    BOTS = []; BOT = {};
    if (S.field === 'b') {
      BOTS.push(new Bot({ field: 'b', kind: 'men', no: 1, name: DANCE_MENTOR }));
      roster.forEach(function (x) { BOTS.push(new Bot({ field: 'b', kind: 'stu', no: x.no, name: x.name, time: x.time, wait: x.wait })); });
    } else {
      mentors.forEach(function (x, i) { BOTS.push(new Bot({ field: 'a', kind: 'men', no: i + 1, name: x.name, g: x.g })); });
      roster.forEach(function (x, i) { BOTS.push(new Bot({ field: 'a', kind: 'stu', no: i + 1, name: x.name, g: x.g })); });
    }
    BOTS.forEach(function (b) { BOT[b.id] = b; });
    ['#g-men', '#g-stu'].forEach(function (s) { $(s).innerHTML = ''; });
    BOTS.forEach(function (b) {
      var el = document.createElement('div');
      el.className = 'bot ' + b.kind; el.dataset.id = b.id;
      el.innerHTML = '<div class="scr"><iframe data-bot="' + b.id + '" title="' + esc(b.name) + '" allow="camera; microphone; autoplay; display-capture" tabindex="-1"></iframe>' +
        '<div class="veil"><b>' + esc(b.name) + '</b><span></span></div><button class="zoom" type="button" title="크게 보기" aria-label="크게 보기">' +
        '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button></div>' +
        '<div class="cap"><span class="nm">' + (b.kind === 'stu' ? '<i>' + String(b.no).padStart(2, '0') + '</i>' : '') + esc(b.name) +
        (b.g ? ' <em>' + GL(b.g) + '조</em>' : '') + '</span><span class="st"></span></div>';
      b.el = el; b.frame = $('iframe', el);
      el.onclick = function (e) { if (e.target.closest('.zoom')) return openBig(b); select(b); };
      el.ondblclick = function () { openBig(b); };
      $(b.kind === 'men' ? '#g-men' : '#g-stu').appendChild(el);
      paintTile(b);
    });
    select(null);
  }
  function paintTile(b) {
    if (!b.el) return;
    b.el.classList.toggle('on', b.on); b.el.classList.toggle('talk', !!b.talking);
    b.el.classList.toggle('live', /멘토링 중|멘토링 진행/.test(b.status));
    $('.st', b.el).textContent = b.err ? '확인 필요' : b.status;
    $('.veil span', b.el).textContent = b.on ? '여는 중…' : b.status;
    if (S.sel === b) paintSel();
  }
  function paintSteps() {
    var l = S.field === 'b' ? danceSteps() : artSteps();
    var h = l.map(function (s, i) {
      return '<li class="' + (s.on ? 'done' : '') + (s.cur ? ' cur' : '') + '" data-i="' + i + '"><i></i><span>' + esc(s.t) + '</span>' +
        (S.field === 'a' && S.running && !s.on ? '<button type="button" class="mini" data-go="' + i + '">지금</button>' : '') + '</li>';
    }).join('');
    if (h !== paintSteps.last) { paintSteps.last = h; $('#steps').innerHTML = h; }   // 바뀔 때만(누르는 중에 버튼이 사라지지 않게)
  }
  function select(b) { S.sel = b; BOTS.forEach(function (x) { x.el && x.el.classList.toggle('sel', x === b); }); paintSel(); }
  function paintSel() {
    var b = S.sel, box = $('#sel');
    if (!b) { paintSel.last = ''; box.innerHTML = '<p class="hint">위 화면 칸을 누르면 그 가상 참가자를 직접 움직일 수 있습니다. 두 번 누르면 크게 봅니다.</p>'; return; }
    var art = b.field === 'a', stuA = art && b.kind === 'stu';
    var h = '<div class="who"><b>' + esc(b.name) + '</b><span>' + (b.kind === 'men' ? '가상 멘토' : '가상 학생 ' + b.no + '번') + (b.g ? ' · ' + GL(b.g) + '조' : '') +
      (b.time ? ' · ' + esc(b.time) : '') + '</span><em>' + esc(b.err || b.status) + '</em></div><div class="acts">' +
      '<button type="button" data-a="io">' + (b.on ? '퇴장시키기' : '입장시키기') + '</button>' +
      '<button type="button" data-a="talk"' + (b.on ? '' : ' disabled') + '>' + (b.talking ? '말 멈추기' : '말하기 (8초)') + '</button>' +
      '<button type="button" data-a="drop"' + (b.on ? '' : ' disabled') + '>연결 끊기</button>' +
      (stuA ? '<button type="button" data-a="hand"' + (b.on ? '' : ' disabled') + '>손들기 / 내리기</button><button type="button" data-a="photo"' + (b.on ? '' : ' disabled') + '>작품 사진 올리기</button>' : '') +
      (!art && b.kind === 'stu' ? '<button type="button" data-a="dance"' + (b.on ? '' : ' disabled') + '>' + (b.dance ? '동작 멈추기' : '춤 동작 보이기') + '</button>' : '') +
      '<button type="button" data-a="big">크게 보기</button></div>';
    if (h !== paintSel.last) { paintSel.last = h; box.innerHTML = h; }
  }
  $('#sel').onclick = function (e) {
    var a = e.target.closest('[data-a]'), b = S.sel; if (!a || !b) return;
    var k = a.dataset.a;
    if (k === 'io') { if (b.on) b.leave(); else { b.left = false; b.entered = true; b.enter(); } }
    else if (k === 'talk') { if (b.talking) stopTalk(b); else talk(b, 8000); }
    else if (k === 'drop') b.drop();
    else if (k === 'hand') { var d = doc(b), hb = d && d.getElementById('b-hand'); if (!hand(b, !(hb && hb.dataset.on))) msg('지금 화면에서는 손들기를 할 수 없습니다.', true); }
    else if (k === 'photo') { if (!photo(b)) msg('지금 화면에서는 사진을 올릴 수 없습니다.', true); }
    else if (k === 'dance') b.dance = !b.dance;
    else if (k === 'big') openBig(b);
    paintSel();
  };
  $('#steps').onclick = function (e) { var g = e.target.closest('[data-go]'); if (g) artGo(Number(g.dataset.go)); };

  // 크게 보기: 칸을 화면 가운데로 키움(창을 옮기지 않아서 다시 불러오지 않음) + 그동안만 다른 사람 영상을 받음
  function light(b, on) {
    if (!b || !b.win) return;
    try { b.win.DEMO_LIGHT = on; (b.win.__sfus || []).forEach(function (s) { s.want(s._wantAll || []); }); } catch (e) {}
  }
  function openBig(b) {
    if (S.big) closeBig();
    S.big = b.id; b.el.classList.add('big'); document.body.classList.add('bigon');
    $('#bigbar b').textContent = (b.kind === 'men' ? '가상 멘토 ' : '가상 학생 ') + b.name + ' 화면';
    fitBig(); light(b, false); select(b);
  }
  function closeBig() {
    var b = BOT[S.big]; S.big = null; document.body.classList.remove('bigon');
    if (b && b.el) { b.el.classList.remove('big'); b.el.style.removeProperty('--bs'); light(b, true); }
  }
  function fitBig() {
    var b = BOT[S.big]; if (!b) return;
    var W = b.kind === 'men' ? 1280 : 390, H = b.kind === 'men' ? 800 : 780;
    b.el.style.setProperty('--bs', Math.min((innerWidth - 60) / W, (innerHeight - 130) / H).toFixed(3));
  }
  addEventListener('resize', fitBig);
  addEventListener('keydown', function (e) { if (e.key === 'Escape') closeBig(); });
  $('#bigbar .x').onclick = closeBig;
  $('#snd').onchange = function () { S.sound = this.checked; };

  function paintAll() {
    document.body.dataset.field = S.field;
    $('#b-start').textContent = S.running ? '처음부터 다시' : '시연 시작';
    $('#b-stop').disabled = !S.running;
    var base = location.href.replace(/demo\/.*$/, '');
    $('#l-ops').textContent = base + S.field + '/o.html?r=demo';
    $('#f-photo').hidden = S.field !== 'a';
    $('#speed').innerHTML = Object.keys(SPEED).map(function (k) {
      var s = SPEED[k];
      return '<option value="' + k + '"' + (k === S.speed ? ' selected' : '') + '>' + s.label + ' — ' + (S.field === 'b' ? '학생 1명 ' + s.slot + '분' : '전체 ' + s.all + '분 · 분반 ' + s.group + '분') + '</option>';
    }).join('');
    paintSteps();
    if (!S.running && !BOTS.length) { $('#g-men').innerHTML = $('#g-stu').innerHTML = ''; }
    $('#empty').hidden = !!BOTS.length; document.body.classList.toggle('has', !!BOTS.length);
    var on = BOTS.filter(function (b) { return b.on; }).length;
    $('#cnt').textContent = BOTS.length ? '접속 ' + on + ' / ' + BOTS.length : '';
  }

  /* 버튼 */
  document.querySelectorAll('.fpill button').forEach(function (b) {
    b.onclick = function () {
      if (S.running || b.dataset.f === S.field) return msg(S.running ? '시연 중에는 분야를 바꿀 수 없습니다. 먼저 「시연 끝내기」를 눌러 주세요.' : '', S.running);
      S.field = b.dataset.f; document.body.classList.toggle('fa', S.field === 'a');
      BOTS = []; BOT = {}; select(null); paintAll();
    };
  });
  $('#speed').onchange = function () { S.speed = this.value; paintAll(); };
  $('#auto').onchange = function () { S.auto = this.checked; };
  $('#photos').onchange = function () { S.photos = this.checked; };
  $('#b-start').onclick = function () { if (S.running) stop(true); else start(); };
  $('#b-stop').onclick = function () { stop(false); };
  $('#b-copy').onclick = function () { navigator.clipboard && navigator.clipboard.writeText($('#l-ops').textContent).then(function () { msg('주소를 복사했습니다.'); }); };
  try { $('#code').value = sessionStorage.getItem('demo_code') || ''; } catch (e) {}

  setInterval(function () {
    if (!S.running) return;
    try { if (S.field === 'b') danceTick(); else artTick(); } catch (e) { console.warn(e); }
    BOTS.forEach(paintTile);
    paintSteps();
    var on = BOTS.filter(function (b) { return b.on; }).length;
    $('#cnt').textContent = '접속 ' + on + ' / ' + BOTS.length;
    var v = S.view;
    $('#clock').textContent = new Date(now() + 9 * 3600e3).toISOString().slice(11, 19) +
      (v && S.field === 'b' && v.cur ? ' · 멘토링 ' + v.cur.name : v && S.field === 'a' ? ' · ' + ({ ready: '준비', all: '전체', group: '분반', end: '마침' }[v.phase] || '') : '');
  }, 1000);

  window.__demo = { S: S, BOTS: function () { return BOTS; }, talk: talk, hand: hand, photo: photo, artGo: artGo };
  paintAll();
})();
