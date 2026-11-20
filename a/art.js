/* K예술영재 미술 온라인 멘토링 — 방 화면 공통(학생·멘토·운영진)
 *  - 지금 내 방(전체 또는 조)에 있는 사람들의 영상·소리를 받아 화면에 배치
 *  - 크게 보기(멘토가 지정 / 화면 공유 / 작품 사진), 손들기, 공지, 단계 이동 안내, 남은 시간
 */
(function () {
  'use strict';
  var M = window.Meet, UI = M.UI, $ = UI.$;

  var A = {};
  A.gname = function (g) { g = Number(String(g || '').replace(/\D/g, '')) || 0; return g ? String.fromCharCode(64 + g) + '조' : '전체'; };
  A.roomName = function (room) { return !room || room === 'all' ? '전체' : A.gname(room.slice(1)); };
  A.PH = { ready: '시작 전', all: '전체 멘토링', group: '분반 멘토링', end: '마침' };
  A.roleName = function (r) { return { student: '학생', mentor: '멘토', ops: '운영', research: '연구원' }[r] || ''; };

  // 회차 시트의 시작·마침 시각 → 지금 기준으로 다음 시각까지 남은 시간(분반은 시각 없이 운영진이 버튼으로)
  A.nextMark = function (v, now) {
    var s = v.sess || {}, d = s.date;
    var t = function (hm) { if (!d || !hm) return 0; var x = new Date(d + 'T' + hm + ':00+09:00').getTime(); return isNaN(x) ? 0 : x; };
    if (v.phase === 'end') return null;
    if (v.phase === 'ready' && t(s.start)) return { to: 'all', at: t(s.start), left: t(s.start) - now, label: '멘토링 시작' };
    if (t(s.end)) return { to: 'end', at: t(s.end), left: t(s.end) - now, label: '마침' };
    return null;
  };

  /* 작품 사진: 로그인한 사람만 관문을 거쳐 받음(공개 링크 없음) */
  var IMG = {};
  A.img = function (sess, f) {
    if (IMG[f]) return IMG[f];
    IMG[f] = M.api({ a: 'img', r: sess.r, id: sess.id, tok: sess.tok, f: f }, 30000).then(function (j) {
      if (!j.ok) { delete IMG[f]; throw new Error(j.error); }
      var bin = atob(j.data), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([arr], { type: 'image/jpeg' }));
    });
    return IMG[f];
  };
  // 사진 줄여서 올리기(긴 변 2000px, JPEG)
  A.upload = async function (sess, file) {
    var url = URL.createObjectURL(file);
    var img = await new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = url; });
    var k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    var c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    var data = c.toDataURL('image/jpeg', 0.86);
    var j = await M.api({ a: 'photo', r: sess.r, id: sess.id, tok: sess.tok, data: data }, 60000);
    if (!j.ok) throw new Error(j.error);
    return j.f;
  };


  /* 방 자리 정하기(화면·녹화 공통)
   *  mentors: 그 방 멘토(명단 순서) / students: 그 방 학생(명단 순서) — 명단에 없지만 들어온 사람은 뒤에 붙임
   *  feature: 크게 볼 것 — 내가 누른 것 > 멘토가 지정한 것 > 화면 공유 > 최근 작품 사진 */
  // 받을 화질: 크게 보는 것 f, 멘토·분반 h, 전체의 학생 칸 q (녹화 PC는 따로)
  A.camRid = function (v, p, myRoom, pin) {
    var spot = v.spot && v.spot[myRoom];
    if ((spot && spot.id === p.id) || (pin && pin.indexOf(p.id + '|') === 0)) return 'f';
    if (myRoom !== 'all') return p.role === 'mentor' ? 'f' : 'h';
    return p.role === 'mentor' ? 'h' : 'q';
  };
  // 카메라를 미술용으로 가볍게(960×540, 초당 24장) — 3단 화질을 보내도 기기 부담이 적게
  A.lightCam = function (stream) {
    var t = stream && stream.getVideoTracks()[0];
    if (t && t.applyConstraints) t.applyConstraints({ width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 24 } }).catch(function () {});
  };
  A.MSUF = (M.CFG.MENTOR_SUFFIX != null ? M.CFG.MENTOR_SUFFIX : ' 교수님');
  // 한 조에 멘토가 여럿일 때(예: A조 2명) 들어오기 전에도 모두 이름이 보이게: 명단(멘토 시트)의 조 배정을 합침(Ver.1.15)
  A.fixMentors = function (v) {
    if (!v || v._mf) return v;
    var mo = v.mentorsOf = v.mentorsOf || {};
    (v.mroster || []).forEach(function (m) { if (m.g) { var l = mo[m.g] = mo[m.g] || []; if (l.indexOf(m.name) < 0) l.push(m.name); } });
    v._mf = 1; return v;
  };
  A.slots = function (v, room, o) {
    o = o || {};
    var people = v.people || [], byId = {}, me = o.me || v.me, streams = o.streams || {};
    people.forEach(function (p) { byId[p.id] = p; });
    var inRoom = function (p) { return p && p.room === room; };
    var gOf = function (x) { return room === 'all' ? true : 'g' + x.g === room; };
    var mk = function (id, name, role) {
      var p = byId[id], mine = id === me, st = streams[id] || {};
      if (p && !inRoom(p)) p = null;   // 다른 방에 있음(이 방 자리는 비움)
      var stream = mine ? o.localCam : st.cam;
      var tr = stream && stream.getVideoTracks && stream.getVideoTracks()[0], set = tr && tr.getSettings ? tr.getSettings() : {};
      return { key: id + '|cam', id: id, kind: 'cam', role: role, name: name, p: p || (mine ? { id: id, live: true } : null), mine: mine,
               label: role === 'mentor' ? name + A.MSUF : name + (mine ? ' (나)' : ''), stream: p || mine ? stream : null,
               mirror: mine && !o.backCam, portrait: !!(set.width && set.height && set.height > set.width) };
    };
    var seen = {}, mentors = [], students = [];
    (v.mroster || []).forEach(function (m) { if (gOf(m)) { seen[m.id] = 1; mentors.push(mk(m.id, m.name, 'mentor')); } });
    (v.roster || []).forEach(function (x) { if (gOf(x)) { seen[x.id] = 1; students.push(mk(x.id, x.name, 'student')); } });
    people.forEach(function (p) {   // 명단 밖(리허설·추가 인원)
      if (seen[p.id] || !inRoom(p) || (p.role !== 'mentor' && p.role !== 'student') || (!p.live && p.id !== me)) return;
      (p.role === 'mentor' ? mentors : students).push(mk(p.id, p.name, p.role));
    });
    // 카메라를 켠 운영진·연구원(그 방에 있을 때) — 멘토·학생 경계 가운데에 작게 떠 있음(Ver.1.19)
    var staff = [];
    people.forEach(function (p) {
      if ((p.role !== 'ops' && p.role !== 'research') || !inRoom(p) || !p.live) return;
      var mine = p.id === me, has = mine ? !!o.localCam : !!(p.tr && p.tr.cam);
      if (!has) return;
      var it = mk(p.id, p.name, 'staff');
      it.label = (p.role === 'ops' ? '운영 ' : '연구원 ') + p.name + (mine ? ' (나)' : '');
      staff.push(it);
    });
    // 크게 볼 것
    var here = people.filter(function (p) { return inRoom(p) && (p.role === 'mentor' || p.role === 'student') && (p.live || p.id === me); });
    var cand = [];
    here.forEach(function (p) {
      var mine = p.id === me, st = streams[p.id] || {};
      var scr = mine ? o.localScr : st.scr;
      if ((p.tr && p.tr.scr) || (mine && scr)) cand.push({ key: p.id + '|scr', id: p.id, kind: 'scr', p: p, name: p.name, label: p.name + ' · 화면 공유', stream: scr, mine: mine, at: p.scrAt || (mine ? Date.now() : 1) });
      if (p.photo) cand.push({ key: p.id + '|photo|' + p.photo.f, id: p.id, kind: 'photo', p: p, name: p.name, label: p.name + ' · 작품 사진', photo: p.photo.f, at: p.photo.at || 0 });
    });
    var spot = v.spot && v.spot[room], feat = null;
    var find = function (key) { return cand.filter(function (c) { return c.key === key; })[0]; };
    var asCam = function (id) { var s0 = mentors.concat(students).filter(function (x) { return x.id === id && x.p; })[0]; return s0 ? Object.assign({}, s0, { key: id + '|big', label: s0.label.replace(' (나)', '') + ' · 크게 보기', mine: s0.mine }) : null; };
    if (o.pin) feat = find(o.pin) || (o.pin.indexOf('|cam') > 0 ? asCam(o.pin.split('|')[0]) : null);
    if (!feat) {   // 가장 최근 것: 멘토가 지정한 것 · 화면 공유 · 작품 사진
      var sp = null;
      if (spot) { sp = spot.kind === 'cam' ? asCam(spot.id) : cand.filter(function (c) { return c.id === spot.id && c.kind === spot.kind; })[0] || null; if (sp) sp = Object.assign({}, sp, { at: spot.at || 0, isSpot: true }); }
      feat = (sp ? [sp] : []).concat(cand).sort(function (a, b) { return (b.at || 0) - (a.at || 0); })[0] || null;
    }
    if (feat) { feat.feature = true; feat.spot = !!feat.isSpot; }
    mentors.concat(students).forEach(function (x) { x.spot = !!(spot && spot.kind === 'cam' && spot.id === x.id); });
    return { mentors: mentors, students: students, staff: staff, feature: feat, photos: cand.filter(function (c) { return c.kind === 'photo'; }) };
  };

  /* ───────── 방: 받기·배치 ───────── */
  function Room(o) {
    var self = this;
    this.o = o; this.sess = o.sess; this.box = o.box;
    this.streams = {};     // id → { cam: MediaStream, scr: MediaStream, mic: MediaStream }
    this.audios = {};      // key → <audio>
    this.pin = null;       // 내 화면에서만 크게(클릭)
    this.listen = null;    // 운영진: 소리를 들을 방(null이면 내 방)
    // 말하는 사람 칸에 후광·아이콘
    M.Speak.listen(function (id, on) {
      Array.from(self.box.querySelectorAll('.tile')).forEach(function (c) { if (c._it && c._it.id === id && c._it.kind === 'cam') M.Speak.mark(c, on); });
    });
    this.sfu = new window.ArtSFU(o.sess, {
      onTrack: function (key, track) { self.track(key, track); },
      onState: function (st) { if (o.onSfuState) o.onSfuState(st); },
      onPub: function (tr) { self.sess.op('pub', { sfu: self.sfu.sid, tr: tr }).catch(function () {}); }
    });
    // 멈춘 영상은 다시 받기
    this.sfu.watch(function () { self.lastWant = ''; if (self.view && self.wantFn) self.sync(self.view, self.wantFn); });
  }
  Room.prototype.track = function (key, track) {
    var p = key.split('|'), id = p[0], kind = p[1];
    var st = this.streams[id] = this.streams[id] || {};
    if (!track) { delete st[kind]; this.audio(key, null); this.dirty = true; return; }
    st[kind] = new MediaStream([track]);
    if (kind === 'mic') this.audio(key, st[kind]);
    this.dirty = true;
    if (this.o.onTrack) this.o.onTrack(id, kind, st[kind]);
    if (this.view && !this.o.noRender) this.render(this.view);
  };
  Room.prototype.audio = function (key, stream) {
    M.Speak.track(key.split('|')[0], stream);   // 발언자 표시용 소리 재기
    var a = this.audios[key];
    if (!stream) { if (a) { a.srcObject = null; a.remove(); delete this.audios[key]; } return; }
    if (!a) { a = this.audios[key] = document.createElement('audio'); a.autoplay = true; a.dataset.k = key; document.body.appendChild(a); }
    a.srcObject = stream; var pr = a.play(); if (pr && pr.catch) pr.catch(function () {});
    this.applyVolumes();
  };
  // 운영진: 고른 방 소리만 들림(녹화에는 모두 들어감)
  Room.prototype.applyVolumes = function () {
    var v = this.view, self = this; if (!v) return;
    var hear = this.listen || v.myRoom;
    Object.keys(this.audios).forEach(function (k) {
      var id = k.split('|')[0], p = (v.people || []).filter(function (x) { return x.id === id; })[0];
      var on = !!p && (p.room === hear || (self.o.hearAll && hear === '*'));
      if (p && (p.role === 'ops' || p.role === 'research') && p.id !== v.me) on = p.talk && (p.room === hear || hear === '*');
      self.audios[k].muted = !on;
    });
  };
  // 이 사람 영상을 어떤 화질로 받을지 정하고 SFU에 요청
  Room.prototype.sync = function (v, wantFn) {
    this.wantFn = wantFn;
    var me = v.me, list = [];
    (v.people || []).forEach(function (p) {
      if (p.id === me || !p.live || !p.sfu || !p.tr) return;
      var w = wantFn(p);   // { cam: 'f'|'h'|'q'|false, mic: bool, scr: bool }
      if (!w) return;
      if (w.cam && p.tr.cam) list.push({ key: p.id + '|cam', sessionId: p.sfu, trackName: p.tr.cam, rid: w.cam === true ? '' : w.cam });
      if (w.mic && p.tr.mic) list.push({ key: p.id + '|mic', sessionId: p.sfu, trackName: p.tr.mic });
      if (w.scr && p.tr.scr) list.push({ key: p.id + '|scr', sessionId: p.sfu, trackName: p.tr.scr });
    });
    var sig = JSON.stringify(list.map(function (x) { return x.key + x.trackName + x.rid; }).sort());
    if (sig === this.lastWant && !this.retry) return;
    this.lastWant = sig; this.retry = false;
    var self = this;
    this.sfu.want(list).then(function () {
      if (list.some(function (w) { return !self.sfu.pulled[w.key]; })) self.retry = true;   // 아직 못 받은 것(상대가 막 올리는 중)은 다음에 다시
    }).catch(function (e) { console.warn('sfu want', e); self.retry = true; });
  };

  // 화면 배치(고정 자리): 위 멘토 · 아래 학생, 들어오지 않은 사람은 검은 칸에 이름. 작품(공유·사진·크게 보기)은 위 줄에 크게
  Room.prototype.render = function (v) {
    this.view = v;
    var self = this, me = v.me, room = v.myRoom;
    if (this.o.localCam && this.o.localCam()) M.Speak.track(me, this.o.localCam());
    var sl = A.slots(v, room, { pin: this.pin, streams: this.streams, me: me, localCam: this.o.localCam && this.o.localCam(), localScr: this.o.localScr && this.o.localScr(), backCam: this.backCam });
    this.paint(sl);
    this.applyVolumes();
  };
  Room.prototype.paint = function (sl) {
    var box = this.box, self = this;
    if (!box.querySelector('.r-top')) box.innerHTML = '<div class="r-top"><div class="r-side l"></div><div class="r-center"></div><div class="r-side r"></div></div><div class="r-div"><i></i></div><div class="r-bot"></div>';
    box.classList.add('fixed');
    var top = box.querySelector('.r-top'), bot = box.querySelector('.r-bot');
    var sideL = top.querySelector('.r-side.l'), sideR = top.querySelector('.r-side.r'), center = top.querySelector('.r-center');
    // 발표 자료(공유·사진·크게 보기)가 있으면: 가운데 크게, 멘토는 양옆에 작게(위아래로 쌓음)
    var ms = sl.mentors, half = Math.ceil(ms.length / 2), topList = ms.slice();
    var left = sl.feature ? ms.slice(0, half) : [], right = sl.feature ? ms.slice(half) : [], mid = sl.feature ? [sl.feature] : ms;
    if (sl.feature) topList.push(sl.feature);
    // 전체 방: 멘토 3명 이상이면 가로 2 × 세로 2로 크게(멘토·학생 영역을 나눠 보임)
    var allRoom = (this.view && this.view.myRoom) === 'all';
    box.classList.toggle('mode-all', allRoom); box.classList.toggle('mode-group', !allRoom);
    // 전체 방 멘토: PC는 가로 한 줄(4명이면 4칸), 좁은 칸(운영 화면 작은 방 등)만 2×2 (Ver.1.17)
    var mcols = sl.feature ? 1 : (allRoom && mid.length >= 3 && box.clientWidth < 900 ? 2 : Math.max(1, mid.length));
    top.style.setProperty('--mcols', mcols);
    top.style.setProperty('--mrows', sl.feature ? 1 : Math.max(1, Math.ceil(mid.length / mcols)));
    top.style.setProperty('--rows', Math.max(1, left.length, right.length));
    top.classList.toggle('has-feature', !!sl.feature);
    top.classList.toggle('one-side', !!sl.feature && !right.length);
    var n = sl.students.length, cols = n <= 4 ? Math.max(1, n) : n <= 14 ? Math.ceil(n / 2) : Math.ceil(n / 3);   // 학생 12명이면 가로 6 × 세로 2
    if (innerWidth < 700) cols = Math.min(cols, 3);
    bot.style.setProperty('--cols', cols);
    bot.style.setProperty('--rows', Math.max(1, Math.ceil(n / cols)));
    var all = {}, fl = bot.querySelector('.r-float');
    if (!fl) { fl = document.createElement('div'); fl.className = 'r-float'; bot.insertBefore(fl, bot.firstChild); }
    topList.concat(sl.students, sl.staff || []).forEach(function (it) { all[it.key] = 1; });
    var put = function (host, list) {
      list.forEach(function (it, i) {
        var c = box.querySelector('[data-k="' + CSS.escape(it.key) + '"]');
        if (!c) {
          c = document.createElement('div'); c.className = 'tile'; c.dataset.k = it.key;
          c.innerHTML = (it.kind === 'photo' ? '<img alt="">' : '<video autoplay playsinline' + (it.mine ? ' muted' : '') + '></video>') +
            '<div class="t-wait"></div><span class="t-label"></span><span class="t-badges"></span><span class="t-tools"></span>';
          c.onclick = function (e) { if (e.target.closest('.t-tools, .t-fs')) return; if (self.o.onTileClick && c._it.p) self.o.onTileClick(c._it, c); };
        }
        c._it = it;
        if (c.parentNode !== host) host.appendChild(c);
        c.style.order = i;
        if (self.o.tools) c.querySelector('.t-tools').innerHTML = it.p ? self.o.tools(it) : '';
        c.classList.toggle('mentor', it.role === 'mentor');
        c.classList.toggle('feature', !!it.feature);
        c.classList.toggle('absent', !it.p || (!it.p.live && !it.mine));
        c.classList.toggle('spot', !!it.spot);
        c.classList.toggle('pinned', self.pin === it.key);
        c.classList.toggle('talk', !!(it.p && it.p.talk));
        M.Speak.mark(c, it.kind === 'cam' && !!it.p && M.Speak.on(it.id));
        var vid = c.querySelector('video');
        if (vid) { UI.attach(vid, it.stream || null); vid.classList.toggle('mirror', !!it.mirror); vid.classList.toggle('portrait', !!it.portrait); }
        var img = c.querySelector('img');
        if (img && !img.src && it.photo) A.img(self.sess, it.photo).then(function (u) { img.src = u; }).catch(function () { c.querySelector('.t-wait').textContent = '사진을 불러오지 못했습니다'; });
        var wait = '';
        if (!it.p) wait = it.name;                                   // 아직 들어오지 않음: 검은 칸에 이름
        else if (it.kind === 'photo') wait = img && img.src ? '' : '사진 불러오는 중…';
        else if (!it.p.live && !it.mine) wait = it.name;
        else if (!it.stream) wait = '연결 중…';
        c.querySelector('.t-wait').textContent = wait;
        c.querySelector('.t-label').textContent = it.label;
        c.querySelector('.t-badges').innerHTML = it.p && it.p.hand && it.kind === 'cam' ? '<b class="hand">' + UI.ico('hand') + '</b>' : '';
        // 크게 보는 자료(화면 공유·사진): 「전체화면」 버튼(Ver.1.17)
        var fsb = c.querySelector('.t-fs');
        if (it.feature && it.p && (it.kind === 'scr' || it.kind === 'photo' || it.kind === 'cam')) {
          if (!fsb) { fsb = document.createElement('button'); fsb.type = 'button'; fsb.className = 't-fs'; fsb.onclick = function (e) { e.stopPropagation(); A.fullscreen(c); }; c.appendChild(fsb); }
          A.paintFs(fsb, c);
        } else if (fsb) fsb.remove();
      });
    };
    put(sideL, left); put(center, mid); put(sideR, right);
    put(bot, sl.students);
    put(fl, sl.staff || []);
    Array.from(box.querySelectorAll('.tile')).forEach(function (c) { if (!all[c.dataset.k]) c.remove(); });
  };

  A.Room = Room;

  /* 크게 보는 자료 전체화면(Ver.1.17): 브라우저 전체화면 → 안 되면(아이폰 등) 화면 가득 덮기 */
  function fsEl() { return document.fullscreenElement || document.webkitFullscreenElement || document.querySelector('.tile.fsx'); }
  A.paintFs = function (b, c) {
    var on = fsEl() === c;
    b.innerHTML = UI.ico(on ? 'x' : 'expand') + '<span>' + (on ? '전체화면 닫기' : '전체화면') + '</span>';
    b.title = on ? '전체화면 닫기(Esc)' : '공유 화면만 전체화면으로 크게 보기';
  };
  A.fullscreen = function (c) {
    var d = document, cur = fsEl();
    if (cur) {
      if (cur.classList.contains('fsx')) cur.classList.remove('fsx');
      else (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      return setTimeout(paintAllFs, 50);
    }
    var fake = function () { c.classList.add('fsx'); paintAllFs(); };
    try {
      if (c.requestFullscreen) c.requestFullscreen().then(paintAllFs).catch(fake);
      else if (c.webkitRequestFullscreen) { c.webkitRequestFullscreen(); setTimeout(function () { if (!fsEl()) fake(); else paintAllFs(); }, 300); }
      else fake();
    } catch (e) { fake(); }
  };
  function paintAllFs() { Array.from(document.querySelectorAll('.tile .t-fs')).forEach(function (b) { A.paintFs(b, b.parentNode); }); }
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) { document.addEventListener(ev, paintAllFs); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { var f = document.querySelector('.tile.fsx'); if (f) { f.classList.remove('fsx'); paintAllFs(); } } });

  /* ───────── 남은 시간·단계 표시 ───────── */
  A.timerText = function (v, now) {
    var n = A.nextMark(v, now);
    if (v.pend) { var s = Math.max(0, Math.ceil((v.pend.at - now) / 1000)); return { text: A.PH[v.pend.to] + '까지 ' + UI.mmss(s * 1000), soon: true, left: s * 1000, pend: true }; }
    if (!n) return null;
    return { text: n.label + '까지 ' + UI.mmss(Math.max(0, n.left)), left: n.left, soon: n.left <= 60000 && n.left > 0 };
  };

  window.Art = A;

  // 웹앱 주소를 아직 넣지 않았으면(설치 전) 안내만 보임
  if (!/^https?:\/\/[^\s]+$/.test(String(M.CFG.API || '')) || /여기에/.test(M.CFG.API)) {
    var cover = function () {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;inset:0;z-index:999;display:grid;place-items:center;background:#202226;color:#F3F1EC;font:600 17px/1.6 Pretendard,sans-serif;text-align:center;padding:24px';
      d.innerHTML = '<div><b style="font-size:22px">미술 온라인 멘토링 — 준비 중</b><br>설치(Apps Script 웹앱 주소 연결)가 끝나면 열립니다.</div>';
      document.body.appendChild(d);
    };
    if (document.body) cover(); else document.addEventListener('DOMContentLoaded', cover);
  }
})();
