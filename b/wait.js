/* K예술영재 무용 온라인 멘토링 — 대기실 화상(Ver.2.7)
 * 대기실에 있는 학생·운영진·연구원이 서로 얼굴을 보고 이야기합니다.
 * 영상은 Cloudflare Realtime SFU가 중계(미술과 같은 ../a/sfu.js 사용): 각자 영상 1개만 올리고, 필요한 만큼 낮은 화질로 받음.
 * 멘토링실(멘토 ↔ 학생, 녹화)은 지금처럼 따로 직접 연결 — 이 화상은 녹화하지 않습니다.
 */
(function () {
  'use strict';
  var M = window.Meet, UI = M.UI;
  var MIC_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 5 2.2M15 10V5a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11 5.7M12 18v3M3 3l18 18"/></svg>';

  // 관문 호출(인증이 풀렸으면 다시 들어가서 한 번 더)
  async function call(sess, body) {
    var b = Object.assign({ r: sess.r, id: sess.id, tok: sess.tok }, body);
    if (sess.call) return sess.call(b);   // 망이 잠깐 끊기거나 서버가 바쁘면 다시 시도
    var j = await M.api(b);
    if (!j.ok && j.error === 'auth') { await sess.rejoin(); b.id = sess.id; b.tok = sess.tok; j = await M.api(b); }
    return j;
  }

  /* o: { sess, el(칸을 그릴 곳), role 'student'|'staff', getLocal(학생: 카메라·마이크 스트림), listen(소리 켬), onMute(학생: 운영진이 마이크 끔), onChange } */
  function WaitRoom(o) {
    this.sess = o.sess; this.el = o.el; this.role = o.role || 'student';
    this.getLocal = o.getLocal || function () { return null; };
    this.listen = o.listen !== false;
    this.onChange = o.onChange || function () {};
    this.onMuteReq = o.onMute || function () {};
    this.canMute = !!o.canMute;
    this.roster = !!o.roster;            // (운영 화면) 명단 전체를 칸으로 — 접속 안 한 학생은 정보 칸
    this.flags = o.flags || null;        // () → { 학생 id: { due, late, … } }
    this.onAct = o.onAct || function () {};
    this.on = false; this.sfu = null; this.view = null; this.lastWant = ''; this.err = '';
    this.rt = {};             // 사람 id → { cam, mic } 받은 트랙
    this.tiles = {};          // 사람 id → 칸 요소
    this.audios = {};         // 사람 id → 소리 요소
    this.mic = null; this.cam = null;   // (운영진·연구원) 대기실용 내 마이크·카메라
    this.talking = false; this.openMic = false;
    this.muteSeen = null;
    this.audioBox = document.createElement('div'); this.audioBox.hidden = true; document.body.appendChild(this.audioBox);
    var self = this;
    this.ro = window.ResizeObserver ? new ResizeObserver(function () { self.fit(); }) : null;
    if (this.ro && this.el) this.ro.observe(this.el);
    if (this.el) this.el.addEventListener('click', function (e) {
      var r = e.target.closest('[data-ring]'); if (r) { e.stopPropagation(); self.ring(r.dataset.ring, r); return; }
      var m = e.target.closest('[data-more]'); if (m) { var mn = m.parentNode.querySelector('.wmenu'); if (mn) mn.hidden = !mn.hidden; return; }
      var b = e.target.closest('button[data-a]'); if (b) { var mm = b.closest('.wmenu'); if (mm) mm.hidden = true; self.onAct(b.dataset.a, b.dataset.id, b); }
    });
  }

  WaitRoom.prototype.start = async function () {
    if (this.on) return;
    this.on = true; this.err = ''; this.lastWant = '';
    var self = this;
    var sfu = this.sfu = new window.ArtSFU(this.sess, {
      onTrack: function (k, t) { self.gotTrack(k, t); },
      onPub: function (names) { self.announce(names); },
      // 연결이 끊기면(망 바뀜·잠깐 끊김) 다시 연결: 실패는 바로, 불안정은 8초 넘게 이어지면
      onState: function (st) {
        if (self.sfu !== sfu) return;
        clearTimeout(self.badT);
        if (st === 'failed') self.restart('failed');
        else if (st === 'disconnected') self.badT = setTimeout(function () { if (self.sfu === sfu && sfu.state !== 'connected') self.restart('disconnected'); }, 8000);
      }
    });
    try {
      await sfu.open();
      if (this.sfu !== sfu) return;
      if (this.role === 'student') {
        var L = this.getLocal(), v = L && L.getVideoTracks()[0], a = L && L.getAudioTracks()[0];
        if (v) await sfu.publish('cam', v);
        if (a) await sfu.publish('mic', a);
      } else {
        if (this.mic) await sfu.publish('mic', this.mic.getAudioTracks()[0]);
        if (this.cam) await sfu.publish('cam', this.cam.getVideoTracks()[0]);
      }
      sfu.watch(function () { self.lastWant = ''; if (self.view) self.sync(self.view); });
      this.announce(sfu.names());
      if (this.view) this.sync(this.view);
    } catch (e) {
      console.warn('대기실 화상', e);
      this.err = e.code === 'sfu_not_set' ? '대기실 화상이 아직 설정되지 않았습니다(관리자: Code.gs 스크립트 속성 CF_SFU_APP_ID·CF_SFU_APP_TOKEN)' : '대기실 화상 연결에 실패했습니다 — 잠시 후 다시 연결합니다';
      try { sfu.close(); } catch (e2) {}
      if (this.sfu === sfu) { this.sfu = null; this.on = false; }
      this.render();
      if (e.code !== 'sfu_not_set') setTimeout(function () { if (!self.on && self.wantOn) self.start(); }, 8000);
    }
  };
  WaitRoom.prototype.restart = function (why) {
    if (Date.now() - (this.lastRestart || 0) < 5000) return;
    this.lastRestart = Date.now();
    console.warn('대기실 화상 다시 연결', why);
    var want = this.wantOn;
    this.stop(true);
    if (want) this.start();
  };
  WaitRoom.prototype.want = function (on) {   // 켜야 할 때 true(실패하면 다시 시도)
    this.wantOn = !!on;
    if (on && !this.on) this.start();
    if (!on && this.on) this.stop();
  };
  WaitRoom.prototype.stop = function (quiet) {
    if (!this.on && !this.sfu) return;
    this.on = false;
    clearTimeout(this.badT);
    var sfu = this.sfu; this.sfu = null;
    if (sfu) try { sfu.close(); } catch (e) {}
    this.rt = {}; this.lastWant = ''; this.annAt = 0;
    Object.keys(this.audios).forEach(function (k) { this.audios[k].remove(); }, this); this.audios = {};
    if (!quiet) call(this.sess, { a: 'wr', cmd: 'pub', sfu: '' }).catch(function () {});
    this.render();
  };
  // (학생) 카메라를 바꾸는 등 내 스트림이 바뀌면 올리는 트랙만 바꿈
  WaitRoom.prototype.replaceLocal = function () {
    if (!this.on || !this.sfu || !this.sfu.sid || this.role !== 'student') return;
    var L = this.getLocal(), v = L && L.getVideoTracks()[0], a = L && L.getAudioTracks()[0];
    if (v) this.sfu.publish('cam', v).catch(function () {});
    if (a) this.sfu.publish('mic', a).catch(function () {});
    this.render();
  };
  WaitRoom.prototype.announce = function (names) {
    if (!this.sfu || !this.sfu.sid) return;
    var self = this;
    this.annAt = Date.now();
    call(this.sess, { a: 'wr', cmd: 'pub', sfu: this.sfu.sid, tr: names || this.sfu.names() }).then(function (j) { if (j && j.ok) self.sess.kick(); else self.annAt = 0; }).catch(function () { self.annAt = 0; });
  };

  // 받을 영상·소리 맞추기
  WaitRoom.prototype.sync = function (v) {
    this.view = v;
    var me = this.sess.id, list = (v && v.wr || []).filter(function (p) { return p.id !== me; });
    // 서버에 내 대기실 화상이 안 보이면(등록 실패·서버 기록이 비워짐) 다시 알림 — 10초에 한 번
    if (this.on && this.sfu && this.sfu.sid && v && v.wr && Date.now() - (this.annAt || 0) > 10000) {
      var mine = v.wr.find(function (p) { return p.id === me; });
      if (!mine || mine.sfu !== this.sfu.sid) this.announce();
    }
    if (this.role === 'student' && v && v.wmuteAt) {   // 운영진이 내 마이크를 끔
      if (this.muteSeen == null) this.muteSeen = v.wmuteAt;
      else if (v.wmuteAt > this.muteSeen) { this.muteSeen = v.wmuteAt; this.onMuteReq(); }
    } else if (this.muteSeen == null) this.muteSeen = 0;
    if (this.on && this.sfu && this.sfu.sid) {
      var nStu = list.filter(function (p) { return p.role === 'student'; }).length;
      var small = this.el && this.el.clientWidth < 520;
      var want = [];
      list.forEach(function (p) {
        if (p.tr.cam) want.push({ key: p.id + '|cam', sessionId: p.sfu, trackName: p.tr.cam,
          rid: p.role !== 'student' ? 'h' : (nStu <= (small ? 2 : 4) ? 'h' : 'q') });
        if (p.tr.mic) want.push({ key: p.id + '|mic', sessionId: p.sfu, trackName: p.tr.mic });
      });
      var sig = JSON.stringify(want);
      if (sig !== this.lastWant) {
        this.lastWant = sig;
        var self = this;
        this.sfu.want(want).catch(function (e) { console.warn('대기실 받기', e); self.lastWant = ''; });
      }
    }
    this.render();
  };
  WaitRoom.prototype.gotTrack = function (key, track) {
    var i = key.lastIndexOf('|'), id = key.slice(0, i), kind = key.slice(i + 1);
    var r = this.rt[id] = this.rt[id] || {};
    if (track) r[kind] = track; else delete r[kind];
    this.render();
  };

  // 대기실 사람들: 위 = 운영진·연구원, 아래 = 학생(운영 화면은 명단 전체 — 접속 안 한 학생은 정보 칸)
  WaitRoom.prototype.people = function () {
    var v = this.view || {}, me = this.sess.id, list = (v.wr || []).slice(), self = this;
    // 위: 대기실에 있는 운영진·연구원 모두(카메라를 끄면 이름 칸)
    var staff = list.filter(function (p) { return p.role !== 'student' && p.id !== me; })
      .map(function (p) { return { p: p, zone: 'top', cam: true }; });
    var meIt = null;
    if (this.on) meIt = { p: { id: me, name: this.sess.name, role: this.role }, me: true, zone: this.role === 'student' ? 'bot' : 'top' };
    if (meIt && meIt.zone === 'top') staff.push(meIt);
    var inWr = {}; list.forEach(function (p) { if (p.role === 'student') inWr[p.id] = p; });
    var stu = [];
    if (this.roster && v.students) {
      v.students.forEach(function (x) {
        if (x.extra && !x.live && !inWr[x.id]) return;
        stu.push({ p: inWr[x.id] || { id: x.id, name: x.name, role: 'student' }, st: x, cam: !!inWr[x.id] && self.on, zone: 'bot' });
      });
    } else {
      if (meIt && meIt.zone === 'bot') stu.push(meIt);
      list.filter(function (p) { return p.role === 'student' && p.id !== me; }).sort(function (a, b) { return a.at - b.at; })
        .forEach(function (p) { stu.push({ p: p, cam: true, zone: 'bot' }); });
    }
    return staff.concat(stu);
  };

  function hm(t) { return t ? new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }) : ''; }
  function ago(t, now) { if (!t) return '미접속'; var s = Math.round((now - t) / 1000); return s < 60 ? s + '초 전 나감' : Math.round(s / 60) + '분 전 나감'; }
  var BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';

  // (운영 화면) 학생 칸 아래 줄·정보 칸 내용
  WaitRoom.prototype.stuHtml = function (x, cam, f) {
    var v = this.view || {}, ops = this.canMute, cur = v.cur && v.cur.id === x.id;
    var when = (x.time ? x.time + (x.end ? '–' + x.end : '') : '');
    var start = ops && !cur ? '<button class="wa' + (f.due ? ' due' : '') + '" type="button" data-a="call" data-id="' + x.id + '">시작</button>' : '';
    if (cam) {
      return '<div class="wbt"><b>' + (x.no ? x.no + '번' : 'T') + '</b><span>' + UI.esc(when ? '멘토링 ' + when : '') + '</span>' +
        (ops ? '<button class="wring" type="button" data-ring="' + x.id + '" title="학생에게 알림 소리(띵동)">' + BELL + '<span>알림</span></button>' : '') + start +
        (ops ? '<button class="wa more" type="button" data-more="' + x.id + '" title="ZOOM·재점검">⋯</button>' : '') +
        '<div class="wmenu" hidden><button type="button" data-a="zoom" data-id="' + x.id + '">' + (x.zoom ? 'ZOOM 해제' : 'ZOOM 안내') + '</button>' +
        (x.test ? '<button type="button" data-a="untest" data-id="' + x.id + '">연결 재점검</button>' : '') + '</div></div>';
    }
    var now = this.sess.now(), stt, cls;
    if (cur) { stt = '멘토링실에서 진행 중'; cls = 'cur'; }
    else if (x.done) { stt = '완료 ' + hm(x.done); cls = 'done'; }
    else if (x.zoom) { stt = 'ZOOM 안내 중'; cls = 'zoom'; }
    else if (x.live) { stt = '접속 중 · 화상 연결 중'; cls = 'on'; }
    else { stt = ago(x.seenAt, now); cls = 'off'; }
    var acts = '';
    if (ops) {
      if (cur) acts += '<button class="wa end" type="button" data-a="end" data-id="' + x.id + '">종료</button>';
      else if (x.done) acts += '<button class="wa" type="button" data-a="undone" data-id="' + x.id + '">완료 취소</button>';
      else acts += start;
      if (!x.done) acts += '<button class="wa" type="button" data-a="zoom" data-id="' + x.id + '">' + (x.zoom ? 'ZOOM 해제' : 'ZOOM') + '</button>';
      if (x.test && !x.done) acts += '<button class="wa" type="button" data-a="untest" data-id="' + x.id + '">재점검</button>';
    }
    var ph = '';
    if (ops && !x.done && !cur) {
      var one = function (lb, n) { return n ? '<a href="tel:' + String(n).replace(/\D/g, '') + '">' + lb + ' ' + UI.esc(n) + '</a>' : ''; };
      ph = one('학생', x.sPhone) + one('보호자', x.pPhone);
      ph = ph ? '<div class="wph2">' + ph + '</div>' : '';
    }
    return '<div class="wi ' + cls + '"><div class="wih"><b>' + (x.extra ? 'T' : x.no) + '</b><span class="wn">' + UI.esc(x.name) + '</span></div>' +
      '<div class="wst">' + (f.late ? '대기실 접속 시각 지남 · ' : '') + UI.esc(stt) + '</div>' +
      (x.extra ? '' : '<div class="wtm">대기실 ' + UI.esc(x.wait || '-') + ' · 멘토링 ' + UI.esc(when || '-') + '</div>') + ph +
      (acts ? '<div class="wact">' + acts + '</div>' : '') + '</div>';
  };

  WaitRoom.prototype.render = function () {
    var el = this.el; if (!el) return;
    var self = this, items = this.people(), seen = {};
    if (!this.on && !this.roster) {
      el.classList.add('wempty');
      el.innerHTML = '<div class="wmsg">' + UI.esc(this.err || (this.wantOn ? '대기실 화상 연결 중…' : '대기실 화상 꺼짐')) + '</div>';
      this.tiles = {}; this.zones = null; this.onChange(0); return;
    }
    if (!this.zones || !el.contains(this.zones.top)) {
      el.classList.remove('wempty'); el.innerHTML = '<div class="wz top"></div><div class="wz bot"></div><div class="wmsg2" hidden></div>';
      this.zones = { top: el.querySelector('.wz.top'), bot: el.querySelector('.wz.bot'), msg: el.querySelector('.wmsg2') };
      this.tiles = {};
    }
    this.zones.msg.hidden = this.on || !this.err; this.zones.msg.textContent = this.on ? '' : (this.err || '');
    var F = this.flags ? this.flags() : {}, idx = { top: 0, bot: 0 };
    items.forEach(function (it) {
      var p = it.p, t = self.tiles[p.id], z = self.zones[it.zone];
      if (!t) {
        t = document.createElement('div'); t.className = 'wt'; t.dataset.id = p.id;
        t.innerHTML = '<video autoplay playsinline muted></video><div class="wph"></div><div class="wix"></div><span class="wnm"></span><span class="wmo" hidden>' + MIC_OFF + '</span>' +
          (self.canMute && !it.me && p.role === 'student' ? '<button class="wmute" type="button" title="이 학생 마이크 끄기">' + MIC_OFF + '<span>마이크 끄기</span></button>' : '');
        var mb = t.querySelector('.wmute');
        if (mb) mb.onclick = function (e) { e.stopPropagation(); self.mute(p.id, mb); };
        self.tiles[p.id] = t;
      }
      seen[p.id] = 1;
      var i = idx[it.zone]++;
      if (t.parentNode !== z || z.children[i] !== t) z.insertBefore(t, z.children[i] || null);
      var vid = t.querySelector('video'), stream = null, hasCam = false, micOn = true, cam = it.me || it.cam;
      if (it.me) {
        var L = self.role === 'student' ? self.getLocal() : null;
        var tr = [];
        if (L) tr = L.getTracks(); else { if (self.cam) tr = tr.concat(self.cam.getVideoTracks()); if (self.mic) tr = tr.concat(self.mic.getAudioTracks()); }
        var vt = tr.filter(function (x) { return x.kind === 'video'; })[0], at = tr.filter(function (x) { return x.kind === 'audio'; })[0];
        hasCam = !!(vt && vt.enabled && vt.readyState === 'live');
        micOn = !!(at && at.enabled);
        var sg = tr.map(function (x) { return x.id; }).join();
        stream = t.__s && t.__sig === sg ? t.__s : new MediaStream(tr);
        t.__sig = sg;
        t.classList.add('me');
      } else if (cam) {
        var r = self.rt[p.id] || {}, arr = [];
        if (r.cam) arr.push(r.cam); if (r.mic) arr.push(r.mic);
        var sig = arr.map(function (x) { return x.id; }).join();
        stream = t.__sig === sig && t.__s ? t.__s : (arr.length ? new MediaStream(arr) : null);
        t.__sig = sig;
        hasCam = !!(r.cam && p.tr && p.tr.cam);
        micOn = p.role === 'student' ? p.mic !== false : !!p.talk;
        self.playAudio(p.id, r.mic || null);
      } else { t.__sig = ''; self.playAudio(p.id, null); }
      t.__s = stream;
      if (vid.srcObject !== stream) UI.attach(vid, stream);
      var info = !!(it.st && !cam);
      t.classList.toggle('info', info);
      t.classList.toggle('nocam', !info && !hasCam);
      t.classList.toggle('staff', p.role !== 'student');
      var f = it.st ? (F[p.id] || {}) : {};
      t.classList.toggle('late', !!f.late);
      t.classList.toggle('due', !!f.due);
      t.classList.toggle('cur', !!(it.st && self.view && self.view.cur && self.view.cur.id === p.id));
      t.classList.toggle('done', !!(it.st && it.st.done));
      t.querySelector('.wph').textContent = (p.name || '').slice(-2);
      t.querySelector('.wnm').textContent = (p.role === 'ops' ? '운영진 ' : p.role === 'research' ? '연구원 ' : '') + (p.name || '') + (it.me ? ' (나)' : '');
      t.querySelector('.wmo').hidden = info || micOn;
      var mb2 = t.querySelector('.wmute'); if (mb2) mb2.hidden = !cam;
      var x = t.querySelector('.wix'), h = it.st ? self.stuHtml(it.st, cam, f) : '';
      if (x.__h !== h) { var open = !!x.querySelector('.wmenu:not([hidden])'); x.innerHTML = h; x.__h = h; if (open) { var m = x.querySelector('.wmenu'); if (m) m.hidden = false; } }
    });
    Object.keys(this.tiles).forEach(function (id) {
      if (seen[id]) return;
      self.tiles[id].remove(); delete self.tiles[id];
      if (self.audios[id]) { self.audios[id].remove(); delete self.audios[id]; }
    });
    this.zones.top.hidden = !idx.top;
    this.fit();
    this.onChange(items.filter(function (it) { return it.cam || it.me || !it.st; }).length);
  };
  WaitRoom.prototype.playAudio = function (id, track) {
    var a = this.audios[id];
    if (!track) { if (a) { a.remove(); delete this.audios[id]; } return; }
    if (!a) { a = this.audios[id] = document.createElement('audio'); a.autoplay = true; this.audioBox.appendChild(a); }
    if (!a.srcObject || a.srcObject.getAudioTracks()[0] !== track) { a.srcObject = new MediaStream([track]); }
    a.muted = !this.listen;
    var pr = a.play(); if (pr && pr.catch) pr.catch(function () {});
  };
  WaitRoom.prototype.setListen = function (on) {
    this.listen = !!on;
    var self = this;
    Object.keys(this.audios).forEach(function (k) { var a = self.audios[k]; a.muted = !self.listen; if (self.listen) { var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); } });
  };

  // 칸 크기: 위(운영진)·아래(학생) 영역마다 가장 크게 들어가도록 열 수를 고름(4:3)
  function fitZone(z, n, W, H) {
    if (!n) return;
    var gap = 6, best = 1, bestW = 0;
    for (var c = 1; c <= n; c++) {
      var rows = Math.ceil(n / c), w = (W - gap * (c - 1)) / c, h = w * 3 / 4;
      if (H > 40 && rows * h + gap * (rows - 1) > H) { w = ((H - gap * (rows - 1)) / rows) * 4 / 3; }
      if (w > bestW) { bestW = w; best = c; }
    }
    z.style.setProperty('--wc', best);
    z.style.setProperty('--ww', Math.floor(bestW) + 'px');
  }
  // 위 운영진·연구원은 가로 한 줄로만, 아래 학생은 한 줄에 4명씩(12명이면 4명 × 3줄)(좁은 휴대폰 화면은 크기에 맞춰 자동)
  function setZone(z, c, w) { z.style.setProperty('--wc', c); z.style.setProperty('--ww', Math.max(40, Math.floor(w)) + 'px'); }
  WaitRoom.prototype.fit = function () {
    var el = this.el, Z = this.zones; if (!el || !Z) return;
    var nt = Z.top.children.length, nb = Z.bot.children.length, W = el.clientWidth, H = el.clientHeight, gap = 6;
    var topH = 0;
    if (nt) {
      var wt = (W - gap * (nt - 1)) / nt;
      var ht = Math.max(48, Math.min(nb ? Math.round(H * 0.26) : H, nb ? 200 : 9999, wt * 3 / 4));
      setZone(Z.top, nt, Math.min(wt, ht * 4 / 3));
      topH = Math.ceil(ht) + 9;
      Z.top.style.height = topH + 'px';
    } else Z.top.style.height = '';
    if (!nb) return;
    var hb = H - topH - (nt ? 8 : 0);
    if (W < 520) { fitZone(Z.bot, nb, W, hb); return; }
    var c = Math.min(4, nb), rows = Math.ceil(nb / c), w = (W - gap * (c - 1)) / c;
    if (hb > 40 && rows * w * 3 / 4 + gap * (rows - 1) > hb) w = ((hb - gap * (rows - 1)) / rows) * 4 / 3;
    setZone(Z.bot, c, w);
  };

  /* ── 운영진·연구원: 말하기·마이크 켜 두기·카메라 ── */
  WaitRoom.prototype.ensureMic = async function () {
    if (this.mic) return true;
    try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
    catch (e) { UI.toast('마이크를 쓸 수 없습니다(브라우저 권한 확인)'); return false; }
    this.mic.getAudioTracks().forEach(function (t) { t.enabled = false; });
    if (this.sfu && this.sfu.sid) await this.sfu.publish('mic', this.mic.getAudioTracks()[0]);
    return true;
  };
  WaitRoom.prototype.applyTalk = function () {
    var on = this.talking || this.openMic;
    if (this.mic) this.mic.getAudioTracks().forEach(function (t) { t.enabled = on; });
    this.sess.info.wtalk = on;
    this.sess.kick();
    this.render();
  };
  WaitRoom.prototype.talk = async function (down) {
    if (down && !(await this.ensureMic())) return;
    this.talking = !!down; this.applyTalk();
  };
  WaitRoom.prototype.setOpenMic = async function (on) {
    if (on && !(await this.ensureMic())) return false;
    this.openMic = !!on; this.applyTalk(); return true;
  };
  WaitRoom.prototype.setCam = async function (on) {
    if (on && !this.cam) {
      try { this.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 720 }, aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 24, max: 24 } }, audio: false }); }
      catch (e) { UI.toast('카메라를 켜지 못했습니다'); return false; }
      if (this.sfu && this.sfu.sid) await this.sfu.publish('cam', this.cam.getVideoTracks()[0]);
    } else if (!on && this.cam) {
      if (this.sfu && this.sfu.sid) await this.sfu.unpublish('cam');
      this.cam.getTracks().forEach(function (t) { t.stop(); }); this.cam = null;
    }
    this.render(); return true;
  };
  // 학생 호출: 학생 화면에 「띵동」 소리
  WaitRoom.prototype.ring = async function (sid, btn) {
    if (btn) { btn.disabled = true; setTimeout(function () { btn.disabled = false; }, 2500); }
    var j = await call(this.sess, { a: 'wr', cmd: 'ring', sid: sid }).catch(function () { return null; });
    UI.toast(j && j.ok ? '학생에게 알림(띵동)을 보냈습니다' : '알림을 보내지 못했습니다');
  };
  WaitRoom.prototype.mute = async function (sid, btn) {
    if (btn) { if (!(btn.dataset.armed && Date.now() - Number(btn.dataset.armed) < 3000)) { btn.dataset.armed = Date.now(); btn.classList.add('arm'); btn.querySelector('span').textContent = '한 번 더'; setTimeout(function () { btn.classList.remove('arm'); btn.querySelector('span').textContent = '마이크 끄기'; delete btn.dataset.armed; }, 3000); return; } }
    var j = await call(this.sess, { a: 'wr', cmd: 'mute', sid: sid }).catch(function () { return null; });
    UI.toast(j && j.ok ? '학생 마이크를 껐습니다(학생이 다시 켤 수 있음)' : '마이크를 끄지 못했습니다');
  };

  // (운영진) 대기실 학생 마이크 모두 끄기(on=true)·모두 켜기(on=false)
  WaitRoom.prototype.muteAll = async function (on) {
    var j = await call(this.sess, { a: 'wr', cmd: 'muteall', on: !!on }).catch(function () { return null; });
    if (j && j.ok) { this.sess.kick(); UI.toast(on ? '대기실 학생 마이크를 모두 껐습니다' : '대기실 학생 마이크를 모두 켰습니다'); }
    else UI.toast('학생 마이크를 바꾸지 못했습니다' + (j && j.error ? ' (' + j.error + ')' : ''));
    return !!(j && j.ok);
  };

  M.WaitRoom = WaitRoom;
})();
