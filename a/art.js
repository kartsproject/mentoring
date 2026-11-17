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
  A.PH = { ready: '시작 전', all1: '전체 멘토링', group: '조별 멘토링', all2: '전체 마무리', end: '마침' };
  A.roleName = function (r) { return { student: '학생', mentor: '멘토', ops: '운영', research: '연구원' }[r] || ''; };

  // 단계 경계 시각(회차 시트) → 다음 경계까지 남은 시간
  A.nextMark = function (v, now) {
    var s = v.sess || {}, d = s.date;
    var t = function (hm) { if (!d || !hm) return 0; var x = new Date(d + 'T' + hm + ':00+09:00').getTime(); return isNaN(x) ? 0 : x; };
    var order = [['all1', t(s.all1)], ['group', t(s.group)], ['all2', t(s.all2)], ['end', t(s.end)]].filter(function (x) { return x[1]; });
    var label = { all1: '전체 멘토링 시작', group: '조별 멘토링 시작', all2: '전체 마무리', end: '마침' };
    var cur = v.phase, idx = ['ready', 'all1', 'group', 'all2', 'end'].indexOf(cur);
    var next = order.filter(function (x) { return ['ready', 'all1', 'group', 'all2', 'end'].indexOf(x[0]) > idx; })[0];
    if (!next) return null;
    return { to: next[0], at: next[1], left: next[1] - now, label: label[next[0]] };
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

  /* ───────── 방: 받기·배치 ───────── */
  function Room(o) {
    var self = this;
    this.o = o; this.sess = o.sess; this.box = o.box;
    this.streams = {};     // id → { cam: MediaStream, scr: MediaStream, mic: MediaStream }
    this.audios = {};      // key → <audio>
    this.pin = null;       // 내 화면에서만 크게(클릭)
    this.listen = null;    // 운영진: 소리를 들을 방(null이면 내 방)
    this.sfu = new window.ArtSFU(o.sess, {
      onTrack: function (key, track) { self.track(key, track); },
      onState: function (st) { if (o.onSfuState) o.onSfuState(st); },
      onPub: function (tr) { self.sess.op('pub', { sfu: self.sfu.sid, tr: tr }).catch(function () {}); }
    });
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
    var me = v.me, list = [];
    (v.people || []).forEach(function (p) {
      if (p.id === me || !p.live || !p.sfu || !p.tr) return;
      var w = wantFn(p);   // { cam: 'h'|'l'|false, mic: bool, scr: bool }
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

  // 화면 배치: big(크게 1개) + strip(작은 칸들) 또는 grid(같은 크기)
  Room.prototype.render = function (v) {
    this.view = v;
    var self = this, me = v.me, room = v.myRoom;
    var here = (v.people || []).filter(function (p) {
      return p.room === room && (p.role === 'student' || p.role === 'mentor') && (p.live || p.id === me);
    });
    here.sort(function (a, b) { return (a.role === 'mentor' ? 0 : 1) - (b.role === 'mentor' ? 0 : 1) || a.name.localeCompare(b.name, 'ko'); });
    var items = [];
    here.forEach(function (p) {
      var mine = p.id === me, st = self.streams[p.id] || {};
      items.push({ key: p.id + '|cam', id: p.id, kind: 'cam', p: p, label: (p.role === 'mentor' ? '멘토 ' : '') + p.name + (mine ? ' (나)' : ''),
                   stream: mine ? self.o.localCam() : st.cam, mirror: mine && !self.o.backCam, mine: mine });
      var scr = mine ? self.o.localScr && self.o.localScr() : st.scr;
      if (p.tr && p.tr.scr || (mine && scr)) items.push({ key: p.id + '|scr', id: p.id, kind: 'scr', p: p, label: p.name + ' 화면 공유', stream: scr, mine: mine });
      if (p.photo) items.push({ key: p.id + '|photo|' + p.photo.f, id: p.id, kind: 'photo', p: p, label: p.name + ' 작품 사진', photo: p.photo.f });
    });
    // 무엇을 크게: 내가 누른 것 > 멘토가 지정한 것 > 화면 공유 > (전체 단계) 멘토
    var spot = v.spot && v.spot[room], big = null;
    var find = function (id, kind) { return items.filter(function (it) { return it.id === id && it.kind === kind; })[0]; };
    if (this.pin) big = items.filter(function (it) { return it.key === self.pin; })[0] || null;
    if (!big && spot) big = find(spot.id, spot.kind) || null;
    if (!big) big = items.filter(function (it) { return it.kind === 'scr'; })[0] || null;
    var mainList;
    if (big) mainList = [big];
    else if (room === 'all' && items.some(function (it) { return it.p.role === 'mentor'; })) mainList = items.filter(function (it) { return it.p.role === 'mentor' && it.kind === 'cam'; });
    else mainList = items.slice();
    var rest = items.filter(function (it) { return mainList.indexOf(it) < 0; });
    this.paint(mainList, rest, spot);
    this.applyVolumes();
  };
  Room.prototype.paint = function (main, rest, spot) {
    var box = this.box, self = this;
    if (!box.querySelector('.r-main')) box.innerHTML = '<div class="r-main"></div><div class="r-strip"></div>';
    var mainEl = box.querySelector('.r-main'), stripEl = box.querySelector('.r-strip');
    box.classList.toggle('has-strip', rest.length > 0);
    mainEl.className = 'r-main n' + Math.min(main.length, 9) + (main.length === 1 && (main[0].kind !== 'cam') ? ' doc' : '');
    var put = function (host, list, small) {
      var keep = {};
      list.forEach(function (it, i) {
        keep[it.key] = 1;
        var c = box.querySelector('[data-k="' + CSS.escape(it.key) + '"]');
        if (!c) {
          c = document.createElement('div'); c.className = 'tile'; c.dataset.k = it.key;
          c.innerHTML = (it.kind === 'photo' ? '<img alt="">' : '<video autoplay playsinline' + (it.mine ? ' muted' : '') + '></video>') +
            '<div class="t-wait"></div><span class="t-label"></span><span class="t-badges"></span><span class="t-tools"></span>';
          c.onclick = function (e) { if (e.target.closest('.t-tools')) return; if (self.o.onTileClick) self.o.onTileClick(c._it, c); };
        }
        c._it = it;
        if (c.parentNode !== host) host.appendChild(c);
        if (self.o.tools) c.querySelector('.t-tools').innerHTML = self.o.tools(it);
        c.style.order = i;
        c.classList.toggle('small', !!small);
        c.classList.toggle('mentor', it.p.role === 'mentor');
        c.classList.toggle('spot', !!spot && spot.id === it.id && spot.kind === it.kind);
        c.classList.toggle('pinned', self.pin === it.key);
        c.classList.toggle('talk', !!(it.p && it.p.talk));
        var vid = c.querySelector('video');
        if (vid) { UI.attach(vid, it.stream || null); vid.classList.toggle('mirror', !!it.mirror); }
        var img = c.querySelector('img');
        if (img && !img.src) A.img(self.sess, it.photo).then(function (u) { img.src = u; }).catch(function () { c.querySelector('.t-wait').textContent = '사진을 불러오지 못했습니다'; });
        var waiting = it.kind === 'photo' ? !img.src : !it.stream;
        c.querySelector('.t-wait').textContent = waiting ? (it.kind === 'photo' ? '사진 불러오는 중…' : !it.p.live ? '연결 끊김' : '연결 중…') : '';
        c.querySelector('.t-label').textContent = it.label;
        c.querySelector('.t-badges').innerHTML = (it.p.hand && it.kind === 'cam' ? '<b class="hand">' + UI.ico('hand') + '</b>' : '') +
          (it.kind === 'cam' && it.p.role === 'mentor' ? '' : '');
      });
      Array.from(host.children).forEach(function (c) { if (!all[c.dataset.k]) c.remove(); });
    };
    var all = {}; main.concat(rest).forEach(function (it) { all[it.key] = 1; });
    put(mainEl, main, false);
    put(stripEl, rest, true);
    Array.from(box.querySelectorAll('.tile')).forEach(function (c) { if (!all[c.dataset.k]) c.remove(); });
  };

  A.Room = Room;

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
