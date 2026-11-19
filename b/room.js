/* 대기실 운영(학생 카드·시간 알림·채팅·공지·알림 미리보기·운영 순서)
 * o.html(녹화 창·대기실 창) 공용. 기존 b_apply room.html 기능을 새 시스템에 맞춰 옮김.
 */
(function () {
  'use strict';
  var M = window.Meet, UI = M.UI, C = M.CFG, $ = UI.$;
  var PREFIX = C.PREFIX || '';

  function Room(o) {
    this.o = o;                       // { sess, role, onAction(a,id,btn), onUnread(n), onHot(n) }
    this.view = null;
    this.SIM_OFF = 0; this.SIM_OPEN = false;
    this.sound = true; this.audio = null;
    this.NOTIFIED = {}; this.POPPED = {}; this.prevLive = null; this.prevCur = '';
    this.ABS_ACK = {}; this.lastAlertSig = ''; this.lastDueBeep = 0; this.titleOn = false;
    this.PENDING = []; this.seenChat = 0; this.lastChatMax = -1; this.lastChatSig = '';
    try { this.ABS_ACK = JSON.parse(sessionStorage.getItem('meet_ack') || '{}'); } catch (e) {}
    var self = this;
    this.bind();
    setInterval(function () { self.tick(false); self.simTick(); }, 1000);
  }
  Room.prototype.staff = function () { return this.o.role === 'ops'; };

  /* ───── 시계(알림 미리보기용) ───── */
  Room.prototype.clock = function () { return Date.now() + this.SIM_OFF; };
  function kstDay(t) { return new Date(t + 9 * 3600e3).toISOString().slice(0, 10); }
  function kst(d, hm) { var m = String(hm || '').match(/(\d{1,2}):(\d{2})/); return m ? new Date(d + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00+09:00').getTime() : NaN; }
  function fmt(t) { return new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }); }
  function hhmm(t) { return new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' }); }
  Room.prototype.day = function () { var s = this.view && this.view.session; return (s && s.date) || kstDay(Date.now()); };
  Room.prototype.rlabel = function () { var r = this.o.sess.r; return r === 'test' ? '리허설' : r + '회차'; };

  /* ───── 소리·알림 ───── */
  Room.prototype.audioReady = function () { try { this.audio = this.audio || new (window.AudioContext || window.webkitAudioContext)(); this.audio.resume(); } catch (e) {} };
  Room.prototype.beep = function () {
    var a = this.audio; if (!this.sound || !a) return;
    try { a.resume(); var o = a.createOscillator(), g = a.createGain(); o.frequency.value = 660; o.connect(g); g.connect(a.destination);
      g.gain.setValueAtTime(.0001, a.currentTime); g.gain.exponentialRampToValueAtTime(.25, a.currentTime + .02); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + .25); o.start(); o.stop(a.currentTime + .27); } catch (e) {}
  };
  Room.prototype.alarm = function (type) {
    var a = this.audio; if (!this.sound || !a) return;
    try { a.resume();
      var seq = type === 'due' ? [[880, 0], [1175, .18], [880, .36], [1175, .54]] : [[520, 0], [520, .3]];
      seq.forEach(function (x) { var o = a.createOscillator(), g = a.createGain(); o.frequency.value = x[0]; o.connect(g); g.connect(a.destination);
        g.gain.setValueAtTime(.0001, a.currentTime + x[1]); g.gain.exponentialRampToValueAtTime(.3, a.currentTime + x[1] + .02); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + x[1] + .16); o.start(a.currentTime + x[1]); o.stop(a.currentTime + x[1] + .18); });
    } catch (e) {}
  };
  Room.prototype.askNotify = function () { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {} };
  Room.prototype.notify = function (title, body, tag) {
    try { if ('Notification' in window && Notification.permission === 'granted') { var n = new Notification(title, { body: body, tag: tag, requireInteraction: true }); n.onclick = function () { window.focus(); n.close(); }; } } catch (e) {}
  };

  /* ───── 상태·알림 계산 ───── */
  Room.prototype.statusOf = function (s) {
    var v = this.view;
    if (v.cur && v.cur.id === s.id) return 'called';
    if (s.done) return 'done';
    return 'waiting';
  };
  Room.prototype.alertsOf = function () {
    var v = this.view, now = this.clock(), d = this.day(), out = [], self = this;
    if (!v || kstDay(now) !== d) return out;   // 그 회차 당일에만
    var nextId = v.next ? v.next.id : null;
    v.students.forEach(function (x) {
      if (x.extra || self.statusOf(x) !== 'waiting' || x.zoom || !x.time) return;
      var st = kst(d, x.time), wt = kst(d, x.wait);
      if (now >= st) out.push({ type: 'due', x: x, at: st });
      else if (x.live && x.id === nextId) out.push({ type: 'prep', x: x, at: st });
      else if (now >= st - 60000) out.push({ type: 'soon', x: x, at: st });
    });
    var rank = { due: 0, absent: 1, prep: 2, soon: 3 };
    return out.sort(function (a, b) { return rank[a.type] - rank[b.type] || (a.x.no || 0) - (b.x.no || 0); });
  };

  // 대기실 접속 시각이 지났는데 접속하지 않은 학생(대기실 칸 테두리 빨강 — 예전 「미접속」 알림 대신)
  Room.prototype.lateOf = function (x) {
    var v = this.view, now = this.clock(), d = this.day();
    if (!v || kstDay(now) !== d || x.extra || x.live || x.zoom || this.statusOf(x) !== 'waiting') return false;
    var wt = kst(d, x.wait);
    return !!(wt && now >= wt);
  };
  Room.prototype.flagMap = function () {
    var F = {}, self = this;
    if (!this.view) return F;
    this.alertsOf().forEach(function (a) { (F[a.x.id] = F[a.x.id] || {})[a.type] = true; });
    this.view.students.forEach(function (x) { if (self.lateOf(x)) (F[x.id] = F[x.id] || {}).late = true; });
    return F;
  };
  function ago(t, now) { if (!t) return '미접속'; var s = Math.round((now - t) / 1000); return s < 60 ? s + '초 전' : Math.round(s / 60) + '분 전'; }
  Room.prototype.phonesHtml = function (x, warn) {
    if (!this.staff()) return '';
    var one = function (label, v) { return v ? '<span>' + label + ' <a href="tel:' + String(v).replace(/\D/g, '') + '">' + UI.esc(v) + '</a><button class="cp" type="button" data-copy="' + UI.esc(v) + '">복사</button></span>' : ''; };
    var h = one(UI.ico('phone') + '학생', x.sPhone) + one(UI.ico('home') + '보호자', x.pPhone);
    return '<div class="ph' + (warn ? ' warn' : '') + '">' + (h || '<span class="none">연락처 없음 (시트 「명단」에 입력)</span>') + '</div>';
  };

  /* ───── 학생 목록 그리기 ───── */
  Room.prototype.render = function (v) {
    if (v !== this.view) this.events(v);
    this.view = v;
    var self = this, L = v.students, real = L.filter(function (x) { return !x.extra; });
    var on = real.filter(function (x) { return x.live; }).length;
    var done = real.filter(function (x) { return self.statusOf(x) === 'done'; }).length;
    var chatN = (v.wr || []).filter(function (p) { return p.role === 'student'; }).length;   // 대기실 화상에 있는 학생 수(채팅은 없앰)
    $('#sum').innerHTML = '<div><b>' + on + '<small style="font-size:13px;color:var(--faint);font-weight:700"> / ' + real.length + '</small></b>접속 중</div><div><b>' + (real.length - done - (v.cur ? 1 : 0)) + '</b>대기</div><div><b>' + done + '</b>완료</div><div><b>' + chatN + '</b>대기실 화상</div>';
    var F = {};
    this.alertsOf().forEach(function (a) { (F[a.x.id] = F[a.x.id] || {})[a.type] = true; });
    document.documentElement.style.setProperty('--ph', '-' + (this.clock() % 1200) + 'ms');   // 다시 그려도 깜빡임 박자 유지
    var brk = (v.session && v.session.brk) || 0, ri = 0, html = '';
    L.forEach(function (x) {
      var f = F[x.id] || {}, st = self.statusOf(x);
      var chips = [];
      if (x.test) chips.push(x.test.ok ? '<span class="badge ' + (x.test.relay ? 'nx' : 'ok') + '">' + (x.test.relay ? '중계 연결' : '연결 확인') + '</span>' : '<span class="badge absent">연결 실패</span>');
      if (x.live && x.info) {
        if (x.info.cam === false) chips.push('<span class="badge absent">카메라 꺼짐</span>');
        if (x.info.mic === false) chips.push('<span class="badge absent">마이크 꺼짐</span>');
        if (x.info.mobile) chips.push('<span class="badge waiting">휴대폰</span>');
      }
      if (x.zoom) chips.push('<span class="badge soon">ZOOM 안내 중</span>');
      var acts = [];
      if (self.staff()) {
        if (st !== 'called') acts.push('<button class="btn ' + (f.due ? 'coral' : '') + ' sm" data-a="call" data-id="' + x.id + '" type="button">' + (f.due ? UI.ico('clock') + '시작' : '시작') + '</button>');
        else acts.push('<button class="btn coral sm" data-a="end" data-id="' + x.id + '" type="button">종료</button>');
        acts.push('<button class="btn ghost sm" data-a="zoom" data-id="' + x.id + '" type="button">' + (x.zoom ? 'ZOOM 해제' : 'ZOOM') + '</button>');
        if (x.test) acts.push('<button class="btn ghost sm" data-a="untest" data-id="' + x.id + '" type="button">재점검</button>');
        if (st === 'done') acts.push('<button class="btn ghost sm" data-a="undone" data-id="' + x.id + '" type="button">완료 취소</button>');
      }
      html += '<div class="st ' + st + ' ' + (x.live ? 'live' : 'away') + (f.due ? ' due' : f.prep ? ' prep' : f.soon ? ' soon' : '') + '" data-id="' + x.id + '" data-n="' + UI.esc(x.name) + '">' +
        '<div class="no">' + (x.extra ? 'T' : x.no) + '</div>' +
        '<div class="nm">' + UI.esc(x.name) + ' <span class="dot ' + (x.live ? 'on' : 'off') + '"><i></i>' + (x.live ? '접속 중' : ago(x.seenAt, self.o.sess.now())) + '</span>' +
          '<span class="badge ' + st + '">' + (st === 'called' ? '멘토링 중' : st === 'done' ? '완료 ' + hhmm(x.done) : '대기') + '</span>' +
          (f.due ? '<span class="badge due">' + UI.ico('clock') + '멘토링 시간</span>' : f.prep ? '<span class="badge prep">다음 차례</span>' : f.soon ? '<span class="badge soon">곧 차례</span>' : '') +
          (f.absent ? '<span class="badge absent">' + UI.ico('alert') + (x.seenAt ? '연결 끊김' : '미접속') + '</span>' : '') + chips.join('') + '</div>' +
        '<div class="act">' + acts.join('') + '</div>' +
        '<div class="meta"><span>' + (x.extra ? '명단 밖 접속(리허설·테스트)' : '대기실 ' + UI.esc(x.wait || '-') + ' · 멘토링 ' + UI.esc(x.time || '-') + (x.end ? '–' + UI.esc(x.end) : '')) + '</span>' +
        (x.extra ? '' : self.phonesHtml(x, f.absent)) + '</div></div>';
      if (!x.extra && brk && ++ri === brk) html += '<div class="brk">휴식</div>';
    });
    $('#list').innerHTML = html || '<div class="empty-list">명단이 없습니다. 시트 「명단」에 학생을 넣어 주세요.</div>';
    this.tick(true);
    if (this.o.onRendered) this.o.onRendered();
    if ($('#guide').classList.contains('on')) this.renderGuide();
    if (this.SIM_OPEN || this.SIM_OFF) this.renderSim();
  };

  /* ───── 시간 알림 ───── */
  Room.prototype.tick = function (fromRender) {
    var v = this.view; if (!v) return;
    var self = this, A = this.alertsOf();
    if (!fromRender) {   // 문턱 시각을 넘는 순간 카드도 바로 갱신
      var want = A.map(function (a) { return a.type + a.x.id; }).sort().join();
      if (want !== this.lastWant) { this.lastWant = want; this.render(v); return; }
    } else this.lastWant = A.map(function (a) { return a.type + a.x.id; }).sort().join();
    var sig = this.o.sess.r + '|' + (v.cur ? v.cur.id : '') + '|' + A.map(function (a) { return a.type + a.x.id + (a.x.seenAt ? 1 : 0) + (a.type === 'prep' ? (v.mentorInfo || {}).warm : ''); }).join();
    if (sig !== this.lastAlertSig) {
      this.lastAlertSig = sig;
      var warm = (v.mentorInfo || {}).warm === 'connected', live = {};
      A.forEach(function (a) {
        var k = a.type + '|' + a.x.id; live[k] = 1;
        var html = self.alertHtml(a, v, warm);
        // 처음 생긴 알림만 띄움(같은 알림은 내용만 갱신). 멘토링 시간 알림은 아래에서 30초마다 다시 띄움
        if (!self.POPPED[k]) { self.POPPED[k] = Date.now(); self.pop(k, html, a.type === 'due' || a.type === 'absent' ? 12000 : 7000, 'al ' + a.type); }
        else self.pop(k, html, 0, 'al ' + a.type, true);
      });
      Object.keys(this.POPPED).forEach(function (k) { if (!live[k]) { delete self.POPPED[k]; self.unpop(k); } });
    }
    // 새 알림: 소리 + 데스크톱 알림
    A.forEach(function (a) {
      var k = self.o.sess.r + '|' + a.type + '|' + a.x.id;
      if (self.NOTIFIED[k] || a.type === 'soon' || a.type === 'prep') return;
      self.NOTIFIED[k] = 1;
      self.alarm(a.type);
      if (self.o.onHotAlert) self.o.onHotAlert(a.type);
      self.notify(a.type === 'due' ? '⏰ ' + a.x.name + ' 학생 멘토링 시간' : '⚠ ' + a.x.name + ' 학생 대기실 미접속',
        a.type === 'due' ? fmt(a.at) + ' 시작 · 운영 화면에서 [시작]을 눌러 주세요.' : '대기실 접속 시각 ' + fmt(a.at) + '이 지났습니다. 전화로 안내해 주세요.', k);
    });
    var due = A.some(function (a) { return a.type === 'due'; });
    if (due && Date.now() - this.lastDueBeep > 30000) {   // 누를 때까지 30초마다 다시(소리 + 위쪽 알림)
      if (this.lastDueBeep) {
        this.alarm('due');
        var warm2 = (v.mentorInfo || {}).warm === 'connected';
        A.filter(function (a) { return a.type === 'due'; }).forEach(function (a) { self.pop('due|' + a.x.id, self.alertHtml(a, v, warm2), 12000, 'al due'); });
      }
      this.lastDueBeep = Date.now();
    }
    if (!due) this.lastDueBeep = 0;
    var hot = A.filter(function (a) { return a.type === 'due' || a.type === 'absent'; });
    if (this.o.onHot) this.o.onHot(hot.length);
    this.titleOn = hot.length ? !this.titleOn : false;
    if (!(this.o.titleBusy && this.o.titleBusy())) document.title = this.titleOn ? (due ? '⏰ 시작할 학생이 있어요!' : '⚠ 미접속 학생') : this.o.title;
  };

  Room.prototype.alertHtml = function (a, v, warm) {
    var self = this, x = a.x, who = (x.no ? x.no + '번 ' : '') + UI.esc(x.name);
    if (a.type === 'due') return '<div class="tx">' + UI.ico('clock') + '<b>' + who + '</b> 학생 멘토링 시간(' + fmt(a.at) + ')입니다 · [시작]을 눌러 주세요' +
        (v.cur ? '<small>진행 중: ' + UI.esc(v.cur.name) + ' — 시작을 누르면 앞 학생은 자동으로 끝나고 녹화가 저장됩니다.</small>' : '') +
        (x.live ? '' : '<small>' + UI.ico('alert') + '이 학생은 지금 대기실에 접속해 있지 않습니다.</small>' + self.phonesHtml(x)) + '</div>' +
        (self.staff() ? '<button class="btn sm blink" data-a="call" data-id="' + x.id + '" type="button">' + UI.ico('clock') + '시작</button>' : '');
    if (a.type === 'absent') return '<div class="tx">' + UI.ico('alert') + '<b>' + who + '</b> 학생 · 대기실 접속 시각(' + fmt(a.at) + ')이 지났는데 ' + (x.seenAt ? '연결이 끊겼습니다' : '아직 접속하지 않았습니다') +
        self.phonesHtml(x) + '<small>채팅 말고 <b>바로 전화</b>로 안내해 주세요. 카드에도 「미접속」으로 남아 있습니다.</small></div>' +
        '<button class="btn ghost sm" data-ack="' + x.id + '" type="button">확인함</button>';
    if (a.type === 'prep') return '<div class="tx">' + UI.ico('target') + '<b>' + who + '</b> 학생 · 멘토링 ' + UI.esc(x.time) + ' · 다음 차례입니다' +
        '<small>' + (warm ? '멘토와 미리 연결됨 — 앞 학생이 끝나면 [다음 시작]만 누르면 1초 안에 바뀝니다.' : '멘토와 미리 연결하는 중입니다(자동).') + '</small></div>';
    return '<div class="tx">' + UI.ico('clock') + '1분 뒤 <b>' + who + '</b> 학생 차례입니다 (' + fmt(a.at) + ')</div>';
  };
  // 화면 위쪽 알림: 학생 목록·시작 버튼을 가리지 않는 자리에 잠깐 떴다가 사라짐
  Room.prototype.pop = function (key, html, ttl, cls, onlyUpdate) {
    var box = $('#alerts'), el = box.querySelector('[data-k="' + key.replace(/"/g, '') + '"]');
    if (!el) {
      if (onlyUpdate) return;
      el = document.createElement('div'); el.dataset.k = key;
      box.insertBefore(el, box.firstChild);
      while (box.children.length > 4) box.lastChild.remove();
    }
    el.className = (cls || 'al info') + ' pop';
    el.innerHTML = html + '<button class="x" type="button" aria-label="닫기">' + UI.ico('x') + '</button>';
    if (ttl) {
      clearTimeout(el._t);
      el.classList.remove('out');
      el._t = setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 300); }, ttl);
    }
  };
  Room.prototype.unpop = function (key) { var el = $('#alerts').querySelector('[data-k="' + key.replace(/"/g, '') + '"]'); if (el) el.remove(); };
  // 학생 접속·끊김, 멘토링 시작·종료를 짧게 알림
  Room.prototype.events = function (v) {
    var self = this, live = {}, prev = this.prevLive;
    v.students.forEach(function (x) { if (!x.extra || x.live) live[x.id] = !!x.live; });
    var cur = v.cur ? v.cur.id : '';
    if (prev) {
      v.students.forEach(function (x) {
        if (prev[x.id] === undefined || prev[x.id] === live[x.id] || x.done) return;
        var who = (x.no ? x.no + '번 ' : '') + UI.esc(x.name);
        self.pop('ev|' + x.id, live[x.id] ? '<div class="tx">' + UI.ico('check') + '<b>' + who + '</b> 학생이 대기실에 들어왔습니다</div>'
          : '<div class="tx">' + UI.ico('alert') + '<b>' + who + '</b> 학생 연결이 끊겼습니다' + self.phonesHtml(x) + '</div>', live[x.id] ? 5000 : 9000, live[x.id] ? 'al info ok' : 'al info warn');
      });
      if (cur !== this.prevCur) {
        if (cur) self.pop('ev|cur', '<div class="tx">' + UI.ico('video') + '<b>' + ((v.cur.no ? v.cur.no + '번 ' : '') + UI.esc(v.cur.name)) + '</b> 학생 멘토링을 시작했습니다</div>', 6000, 'al info start');
        else if (this.prevCur) self.pop('ev|cur', '<div class="tx">' + UI.ico('check') + '멘토링을 마쳤습니다 · 다음 학생 대기 중</div>', 5000, 'al info');
      }
    }
    this.prevLive = live; this.prevCur = cur;
  };

  /* ───── 알림 미리보기(리허설 시계) ───── */
  Room.prototype.setSim = function (ms) {
    this.SIM_OFF = ms == null ? 0 : ms - Date.now();
    var self = this;
    this.NOTIFIED = {}; this.POPPED = {}; $('#alerts').innerHTML = ''; this.lastAlertSig = ''; this.lastDueBeep = 0;
    Object.keys(this.ABS_ACK).forEach(function (k) { if (k.indexOf('sim|') === 0) delete self.ABS_ACK[k]; });
    this.renderSim(); if (this.view) this.render(this.view);
  };
  Room.prototype.renderSim = function () {
    var on = !!this.SIM_OFF, bar = $('#simbar');
    $('#simBtn').classList.toggle('sim-on', on || this.SIM_OPEN);
    UI.label('#simBtn', 'eye', on ? '미리보기 중' : '알림 미리보기');
    bar.classList.toggle('on', on || this.SIM_OPEN);
    if (!(on || this.SIM_OPEN)) return;
    var L = ((this.view && this.view.students) || []).filter(function (x) { return !x.extra && x.time; }), d = this.day();
    var p1 = L[0], p2 = L[1];
    var presets = p1 ? [
      ['1번 대기실 접속 10초 전', kst(d, p1.wait) - 10000],
      ['1번 멘토링 1분 전', kst(d, p1.time) - 60000],
      ['1번 멘토링 10초 전', kst(d, p1.time) - 10000]
    ].concat(p2 ? [['2번 대기실 접속 10초 전', kst(d, p2.wait) - 10000]] : []) : [];
    var cur = new Date(this.clock() + 9 * 3600e3).toISOString().slice(11, 19);
    bar.innerHTML = (on ? '<span class="tag">리허설 중</span> 이 화면의 시계 <b id="simClock">' + cur + '</b>' : '<span class="tag">알림 미리보기</span> ' + this.rlabel() + ' 당일 시각을 골라 주세요') +
      presets.map(function (p) { return '<button class="btn ghost sm" type="button" data-sim="' + p[1] + '">' + p[0] + '</button>'; }).join('') +
      '<input type="time" id="simTime" step="1" value="' + (on ? cur : (p1 ? p1.wait.padStart(5, '0') : '10:50')) + '">' +
      '<button class="btn ghost sm" type="button" id="simGo">이 시각으로</button>' +
      '<button class="btn coral sm" type="button" id="simOff">' + (on ? '리허설 끝내기 (실제 시각으로)' : '닫기') + '</button>' +
      '<span class="note">이 브라우저에서만 시계를 바꿔 알림·깜빡임·알림음을 미리 보는 기능입니다. 학생 화면·진행 상태·시트에는 영향이 없습니다.</span>';
  };
  Room.prototype.simTick = function () { var c = $('#simClock'); if (c && this.SIM_OFF) c.textContent = new Date(this.clock() + 9 * 3600e3).toISOString().slice(11, 19); };

  /* ───── 운영 순서 ───── */
  function addMin(hm, m) { var p = String(hm).split(':').map(Number), t = p[0] * 60 + p[1] + m; return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
  Room.prototype.renderGuide = function () {
    var L = ((this.view && this.view.students) || []).filter(function (x) { return !x.extra && x.time; }), f = L[0], last = L[L.length - 1];
    $('#guide').innerHTML = '<div class="gh"><b>' + UI.ico('list') + '당일 운영 순서 · ' + this.rlabel() + '</b><small>온라인 멘토링 시스템 기준</small><button class="btn ghost sm" type="button" id="guideClose">닫기</button></div>' +
      '<div class="cols"><div>' +
      '<h4>사전 안내</h4><ul><li>학생·보호자에게 접속 주소 안내(이름·생년월일로 입장, <b>멘토링 10분 전 접속</b>)</li><li>멘토에게 멘토 주소·멘토 코드 안내</li></ul>' +
      '<h4>시작 전</h4><ul>' + (f ? '<li><b class="t">' + addMin(f.wait, -20) + '</b>까지 운영진 접속 · 녹화 담당 PC에서 「이 PC에서 녹화」·저장 폴더 확인</li>' +
        '<li><b class="t">' + f.wait + '</b>까지 멘토 접속 · 첫 학생(' + f.no + '번 ' + UI.esc(f.name) + ') 대기실 입장 확인</li>' : '<li>시트 「명단」을 채우면 시각이 표시됩니다.</li>') +
      '<li>멘토링 전 연구원·운영진은 「화면 등장」으로 멘토와 사전 논의(스페이스 누르고 말하기)</li></ul>' +
      '</div><div>' +
      '<h4>진행 중</h4><ul><li><b>대기실</b>: 학생이 들어오면 녹화 PC가 자동 연결 점검 → 카드에 「연결 확인/중계 연결/연결 실패」. 실패 학생은 [ZOOM]. 미접속 알림이 뜨면 채팅 말고 <b>전화</b></li>' +
      '<li><b>다음 차례</b>는 멘토와 자동으로 미리 연결 → 앞 학생이 끝나면 [다음 시작] 한 번(앞 학생 녹화 자동 저장)</li>' +
      '<li>1인 10분(피드백 8분 + 질의응답 2분) · 멘토 화면에 큰 카운트다운·1분 전 경고</li>' +
      '<li>' + (last ? '<b class="t">' + UI.esc(last.end || last.time) + '</b> ' : '') + '마지막 학생은 [이 학생 종료] 두 번 → 녹화 저장 확인 후 마무리</li></ul>' +
      '</div></div>';
  };

  /* ───── 채팅·공지 ───── */
  Room.prototype.renderChat = function () {
    var self = this, sess = this.o.sess, ch = sess.chat, msgs = ch.list || [], me = sess.name;
    var v = this.view, on = v ? v.students.filter(function (x) { return !x.extra && x.live; }).length : 0;
    $('#cheadSub').textContent = this.rlabel() + ' · 학생 ' + on + '명 접속 중';
    $('#bcList').innerHTML = (ch.bc || []).slice().reverse().map(function (b) { return '<div>' + hhmm(b.t) + ' · ' + UI.esc(b.x) + (b.b ? ' <small>(' + UI.esc(b.b) + ')</small>' : '') + '</div>'; }).join('') || '<div class="muted">보낸 공지가 없습니다.</div>';
    var maxId = msgs.length ? msgs[msgs.length - 1].i : 0;
    if (this.lastChatMax >= 0 && msgs.some(function (m) { return m.i > self.lastChatMax && m.f === 's'; })) this.beep();   // 학생 새 메시지
    this.lastChatMax = maxId;
    var sig = ch.gv + '|' + msgs.length + '|' + maxId + '|' + this.PENDING.length;
    if (sig !== this.lastChatSig) {
      this.lastChatSig = sig;
      var box = $('#msgs');
      var canDel = this.staff();
      box.innerHTML = (msgs.length ? msgs.map(function (m) {
        var del = canDel ? '<button class="del" data-del="' + m.i + '" type="button" title="이 메시지 지우기">×</button>' : '';
        if (m.f === 'o') {
          var mine = m.b === me, peer = !mine;
          return '<div class="m o' + (peer ? ' peer' : '') + '">' + del + (peer ? '<span class="whoo">' + UI.esc(m.b || '운영진') + '</span>' : '') + UI.esc(m.x) + '<small>' + (mine ? '나(' + UI.esc(me) + ')' : '운영진') + ' · ' + hhmm(m.t) + '</small></div>';
        }
        return '<div class="m s">' + del + '<span class="who" data-at="' + UI.esc(m.n) + '">' + UI.esc(m.n) + '</span>' + UI.esc(m.x) + '<small>' + hhmm(m.t) + '</small></div>';
      }).join('') : (this.PENDING.length ? '' : '<div class="empty">아직 대화가 없습니다.<br>아래 문구 버튼으로 첫 인사를 보내 보세요.</div>')) +
        this.PENDING.map(function (p) { return '<div class="m o pend">' + UI.esc(p.x) + '<small>나(' + UI.esc(me) + ') · 보내는 중…</small></div>'; }).join('');
      box.scrollTop = box.scrollHeight;
    }
    this.updUnread();
  };
  Room.prototype.updUnread = function () {
    var m = this.o.sess.chat.list || [], last = m.length ? m[m.length - 1].i : 0;
    if (this.o.chatVisible && this.o.chatVisible()) this.seenChat = last;
    if (last < this.seenChat) this.seenChat = last;
    var self = this, n = m.filter(function (x) { return x.f === 's' && x.i > self.seenChat; }).length;
    if (this.o.onUnread) this.o.onUnread(n);
  };
  Room.prototype.mention = function (name) {
    if (this.o.showChat) this.o.showChat();
    var t = $('#chatText');
    if (t.value.indexOf('@' + name) !== 0) t.value = '@' + name + ' ' + t.value.replace(/^@\S+\s*/, '');
    t.focus();
  };

  /* ───── 이벤트 연결 ───── */
  Room.prototype.bind = function () {
    var self = this, sess = this.o.sess;
    sess.on('chat', function () { self.renderChat(); });
    // 전화번호 복사
    document.addEventListener('click', async function (e) {
      var c = e.target.closest('[data-copy]'); if (!c) return;
      e.stopPropagation();
      try { await navigator.clipboard.writeText(c.dataset.copy); UI.toast(c.dataset.copy + ' 복사했습니다'); } catch (er) { UI.toast(c.dataset.copy); }
    }, true);
    // 카드: 버튼은 조작, 그 밖은 @호출
    $('#list').addEventListener('click', function (e) {
      var card = e.target.closest('.st'); if (!card) return;
      if (e.target.closest('a,.ph')) return;
      var b = e.target.closest('button[data-a]');
      if (b) return self.o.onAction(b.dataset.a, b.dataset.id, b);
      if (self.staff()) self.mention(card.dataset.n);
    });
    $('#alerts').addEventListener('click', function (e) {
      var x = e.target.closest('.x'); if (x) { var el = x.closest('.pop'); if (el) el.remove(); return; }
      var a = e.target.closest('[data-ack]');
      if (a) { var pe = a.closest('.pop'); if (pe) pe.remove(); }
      if (a) {
        self.ABS_ACK[(self.SIM_OFF ? 'sim|' : '') + sess.r + '|' + a.dataset.ack] = 1;
        try { var keep = {}; Object.keys(self.ABS_ACK).forEach(function (k) { if (k.indexOf('sim|') !== 0) keep[k] = 1; }); sessionStorage.setItem('meet_ack', JSON.stringify(keep)); } catch (er) {}
        self.lastAlertSig = ''; self.render(self.view); return;
      }
      var b = e.target.closest('button[data-a]'); if (b) self.o.onAction(b.dataset.a, b.dataset.id, b);
    });
    // 알림 미리보기
    $('#simBtn').onclick = function () { self.SIM_OPEN = !self.SIM_OPEN || !!self.SIM_OFF; self.renderSim(); };
    $('#simbar').addEventListener('click', function (e) {
      var b = e.target.closest('[data-sim]'); if (b) { self.setSim(Number(b.dataset.sim)); UI.toast('리허설 시각으로 바꿨습니다'); return; }
      if (e.target.id === 'simGo') { var v = $('#simTime').value; if (!v) return; self.setSim(kst(self.day(), v) + (Number(v.split(':')[2]) || 0) * 1000); return; }
      if (e.target.id === 'simOff') { var was = !!self.SIM_OFF; self.SIM_OPEN = false; self.setSim(null); if (was) UI.toast('실제 시각으로 돌아왔습니다'); }
    });
    // 운영 순서
    $('#guideBtn').onclick = function () { var g = $('#guide'); g.classList.toggle('on'); if (g.classList.contains('on')) self.renderGuide(); };
    $('#guide').addEventListener('click', function (e) { if (e.target.id === 'guideClose') $('#guide').classList.remove('on'); });
    // 알림음
    $('#alarmBtn').onclick = function () { self.askNotify(); self.audioReady(); self.sound = !self.sound; UI.label(this, self.sound ? 'bell' : 'bellOff', self.sound ? '알림음 켬' : '알림음 끔'); };
    // 채팅
    $('#msgs').addEventListener('click', async function (e) {
      var d = e.target.closest('[data-del]');
      if (d) {
        if (!self.confirmBtn(d, '지우기?')) return;
        var j = await sess.op('del', { i: Number(d.dataset.del) });
        if (j.ok && j.chat) sess.mergeChat(j.chat);
        UI.toast(j.ok ? '메시지를 지웠습니다' : '지우지 못했습니다'); return;
      }
      var w = e.target.closest('[data-at]'); if (w && self.staff()) self.mention(w.dataset.at);
    });
    $('#clearChat').onclick = async function () {
      if (!self.confirmBtn(this, '정말 모두 지우기')) return;
      var j = await sess.op('del', {});
      if (j.ok && j.chat) sess.mergeChat(j.chat);
      UI.toast(j.ok ? self.rlabel() + ' 채팅을 모두 지웠습니다' : '지우지 못했습니다');
      UI.label(this, 'trash', '채팅 지우기'); delete this.dataset.orig;
    };
    $('#chatForm').onsubmit = async function (e) {
      e.preventDefault();
      var text = $('#chatText').value.trim(); if (!text) return;
      $('#chatText').value = ''; $('#chatText').focus();
      var p = { x: text }; self.PENDING.push(p); self.lastChatSig = ''; self.renderChat();
      var j = null;
      try { j = await sess.say(text); } catch (er) {}
      self.PENDING = self.PENDING.filter(function (q) { return q !== p; }); self.lastChatSig = ''; self.renderChat();
      if (!j || !j.ok) { UI.toast('보내지 못했습니다. 다시 보내 주세요.'); $('#chatText').value = text; }
    };
    $('#quick').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; $('#chatText').value = b.textContent; $('#chatText').focus(); });
    $('#bcForm').onsubmit = async function (e) {
      e.preventDefault();
      var text = $('#bcText').value.trim(); if (!text) return;
      var btn = $('#bcForm button[type=submit]');
      if (!self.confirmBtn(btn, '전체에 보내기 확인')) return;
      var j = await sess.op('bc', { text: text });
      if (j.ok) { $('#bcText').value = ''; UI.toast('전체 공지를 보냈습니다'); document.body.classList.remove('m-bc'); }
      else UI.toast('보내지 못했습니다');
      btn.textContent = '전체 보내기';
    };
    $('#bcClear').onclick = async function () {
      if (!self.confirmBtn(this, '공지 모두 내리기?')) return;
      var j = await sess.op('bcclear', {});
      UI.toast(j.ok ? '공지를 모두 내렸습니다' : '처리하지 못했습니다');
      this.textContent = '공지 모두 내리기';
    };
  };
  // 두 번 눌러 확인(브라우저 확인창 대신 — 확인창은 영상 연결을 멈출 수 있음)
  Room.prototype.confirmBtn = function (btn, label) {
    var now = Date.now();
    if (btn.dataset.armed && now - Number(btn.dataset.armed) < 3000) { delete btn.dataset.armed; return true; }
    btn.dataset.armed = now; btn.dataset.orig = btn.dataset.orig || btn.innerHTML; btn.textContent = label;
    setTimeout(function () { if (btn.dataset.armed && Date.now() - Number(btn.dataset.armed) >= 2900) { delete btn.dataset.armed; btn.innerHTML = btn.dataset.orig; } }, 3000);
    return false;
  };

  window.MeetRoom = Room;
})();
