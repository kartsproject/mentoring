/* 화면 보기(Ver.2.27) — 운영 화면을 ?watch=1 로 열면
 * 학생·멘토에게 「지금 보이는 화면」을 실시간으로 보기만 합니다.
 *  - 이 창은 영상을 받기만 함(마이크·카메라·녹화 없음, 대기실에 내 칸 없음)
 *  - 학생 화면(index.html)·멘토 화면(m.html)을 ?mirror=1 로 띄우고, 그 페이지의 실제 그리기 코드에
 *    이 창이 받은 영상과 진행 상태를 넘겨 그대로 그리게 함(MeetWatchMirror)
 */
(function () {
  'use strict';
  var M = window.Meet, UI = M.UI, PREFIX = (M.CFG && M.CFG.PREFIX) || '';
  var esc = UI.esc;
  var api = null, sel = null, sound = false, frames = {}, el = null, lastList = '';
  var STU = { w: 390, h: 844 }, MEN = { w: 1440, h: 900 };

  function view() { return api && api.view(); }
  function stu(id) { var v = view(); return v && (v.students || []).filter(function (s) { return s.id === id; })[0]; }

  /* 거울 페이지가 부르는 것 */
  var cache = {};
  window.MeetWatchMirror = {
    now: function () { return api.sess.now(); },
    room: function () { return api.sess.r; },
    target: function () { return sel && sel.k === 's' ? { id: sel.id, name: (stu(sel.id) || {}).name || '' } : null; },
    rt: function () { return api.wr.rt || {}; },
    link: function (kind, peer) {
      var L = api.viewLink(peer);
      return L ? { state: 'connected', stream: L.stream, relay: false, kind: kind, peer: peer } : null;
    },
    // 그 사람 자신의 카메라·마이크(받은 영상): 멘토·진행 중 학생은 멘토링실 영상, 대기실 학생은 대기실 화상
    local: function (id) {
      var v = view(), L = (id === 'M' || (v && v.cur && v.cur.id === id)) ? api.viewLink(id) : null;
      var tr = [];
      if (L) tr = L.stream.getTracks();
      else { var r = (api.wr.rt || {})[id] || {}; if (r.cam) tr.push(r.cam); if (r.mic) tr.push(r.mic); }
      var sig = tr.map(function (t) { return t.id; }).join();
      var c = cache[id];
      if (c && c.sig === sig) return c.s;
      var s = new MediaStream(tr);
      cache[id] = { sig: sig, s: s };
      return s;
    },
    me: function (id) {
      var v = view() || {}, s = stu(id) || {}, se = v.session || {};
      return { no: s.no || 0, wait: s.wait || '', time: s.time || '', end: s.end || '', date: se.date || '', mentor: se.mentor || '' };
    },
    // 운영진이 받는 진행 상태로 그 학생이 받는 것과 같은 상태를 만듦(서버 view_ 의 학생용과 같은 계산)
    studentView: function (id) {
      var v = view(); if (!v) return null;
      var list = v.students || [], cur = v.cur, me = stu(id) || {};
      var waiting = list.filter(function (s) { return !s.done && !(cur && cur.id === s.id) && !s.zoom; });
      var ahead = 0, found = false;
      for (var i = 0; i < waiting.length; i++) { if (waiting[i].id === id) { found = true; break; } ahead++; }
      var nx = waiting.filter(function (s) { return s.live; })[0];
      var se = v.session || {};
      return {
        seq: v.seq, me: id, called: !!(cur && cur.id === id), cur: cur && cur.id === id ? cur : null,
        busy: !!cur, curNo: cur ? cur.no : 0, isNext: !!(nx && nx.id === id), ahead: found ? ahead : 0,
        myNo: me.no || 0, myWait: me.wait || '', myTime: me.time || '', myEnd: me.end || '',
        date: se.date, mentor: se.mentor, online: v.online, mentorLive: v.mentorLive, host: v.host,
        done: !!me.done, test: me.test || null, zoomUrl: me.zoom ? v.zoomUrl : '',
        room: cur && cur.id === id ? (v.stage || []).map(function (m) { return { id: m.id, name: m.name, role: m.role, mic: m.mic, n: '' }; }) : [],
        wr: v.wr || [], wallMute: v.wallMute || null, wmuteAt: 0, ringAt: 0
      };
    },
    info: function (id) { var s = stu(id); return s && s.info || null; },
    mentorView: function () { return view(); }
  };

  /* 화면 */
  function css() {
    var s = document.createElement('style');
    s.textContent =
      '#watch{position:fixed;inset:0;z-index:3000;background:#000;color:#F5F5F7;display:grid;grid-template-rows:auto 1fr;font-family:inherit;word-break:keep-all}' +
      '#watch .wh{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid rgba(255,255,255,.12)}' +
      '#watch .wh h1{margin:0;font-size:17px;font-weight:700;letter-spacing:-.02em}#watch .wh h1 small{display:block;font-size:12px;font-weight:500;color:#A1A1A6}' +
      '#watch .mk{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#2997FF,#A970FF 60%,#FF6482);display:grid;place-items:center;font-weight:800}' +
      '#watch .sp{flex:1}#watch .live{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:#30D158;font-weight:600}' +
      '#watch .live::before{content:"";width:8px;height:8px;border-radius:50%;background:#30D158;animation:wpl 1.6s ease-in-out infinite}@keyframes wpl{50%{opacity:.35}}' +
      '#watch .snd{display:grid;grid-template-columns:1fr 1fr;padding:3px;border-radius:980px;background:#1D1D1F;border:1px solid rgba(255,255,255,.12);position:relative}' +
      '#watch .snd::before{content:"";position:absolute;top:3px;bottom:3px;left:3px;width:calc(50% - 3px);border-radius:980px;background:linear-gradient(100deg,#2997FF,#A970FF);transition:transform .35s cubic-bezier(.28,.11,.32,1)}' +
      '#watch .snd.on::before{transform:translateX(100%)}#watch .snd button{position:relative;border:0;background:none;color:rgba(235,235,245,.6);padding:7px 14px;border-radius:980px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}' +
      '#watch .snd:not(.on) [data-v="0"],#watch .snd.on [data-v="1"]{color:#fff}' +
      '#watch .out{border:0;border-radius:980px;padding:8px 16px;background:rgba(255,255,255,.1);color:#F5F5F7;font:inherit;font-size:13px;font-weight:600;cursor:pointer}' +
      '#watch .wb{display:grid;grid-template-columns:270px minmax(0,1fr);min-height:0}' +
      '#watch aside{border-right:1px solid rgba(255,255,255,.12);overflow:auto;padding:14px 12px 30px;background:#0b0b0c}' +
      '#watch aside h3{margin:16px 8px 6px;font-size:12px;font-weight:600;color:#6E6E73}#watch aside h3:first-child{margin-top:2px}' +
      '#watch .it{width:100%;display:grid;grid-template-columns:34px 1fr;gap:10px;align-items:center;text-align:left;border:0;background:transparent;color:#F5F5F7;padding:8px 10px;border-radius:12px;cursor:pointer;font:inherit}' +
      '#watch .it:hover{background:#161617}#watch .it.sel{background:#1D1D1F;box-shadow:inset 0 0 0 1.5px #2997FF}' +
      '#watch .it:disabled{opacity:.35;cursor:default;background:transparent}' +
      '#watch .it i{font-style:normal;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#2C2C2E;font-size:12.5px;font-weight:700;color:#A1A1A6}' +
      '#watch .it.cur i{background:linear-gradient(135deg,#2997FF,#A970FF);color:#fff}#watch .it.men i{background:#3a2a55;color:#D9C4FF}' +
      '#watch .it b{display:block;font-size:14px;font-weight:600}#watch .it small{display:block;font-size:12px;color:#A1A1A6}' +
      '#watch .it.cur small{color:#BFA8FF}' +
      '#watch .st{position:relative;display:grid;grid-template-rows:auto 1fr;min-width:0;min-height:0;padding:16px 24px 24px}' +
      '#watch .cap{display:flex;align-items:baseline;gap:10px;margin:0 0 12px}#watch .cap b{font-size:18px;font-weight:700}#watch .cap span{color:#A1A1A6;font-size:13px}' +
      '#watch .box{position:relative;min-height:0;display:grid;place-items:center}' +
      '#watch .dev{position:relative;background:#2a2a2d;box-shadow:inset 0 0 0 1.5px #3a3a3e,0 40px 80px -30px rgba(0,0,0,.9);overflow:hidden}' +
      '#watch .dev.ph{border-radius:44px;padding:12px}#watch .dev.pc{border-radius:14px;padding:10px}' +
      '#watch .dev .sc{position:relative;overflow:hidden;background:#000}#watch .dev.ph .sc{border-radius:34px}#watch .dev.pc .sc{border-radius:6px}' +
      '#watch .dev iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;pointer-events:none;background:#000}' +
      '#watch .none{color:#6E6E73;text-align:center;font-size:14px}' +
      '@media (max-width:860px){#watch .wb{grid-template-columns:1fr;grid-template-rows:auto 1fr}#watch aside{border-right:0;border-bottom:1px solid rgba(255,255,255,.12);display:flex;gap:6px;overflow-x:auto;padding:10px}#watch aside h3{display:none}#watch .it{width:auto;flex:none}}' +
      '@media (prefers-reduced-motion:reduce){#watch .live::before{animation:none}#watch .snd::before{transition:none}}';
    document.head.appendChild(s);
  }
  function build() {
    el = document.createElement('div'); el.id = 'watch';
    el.innerHTML =
      '<div class="wh"><span class="mk" aria-hidden="true">K</span><h1><small>무용분야 심화 멘토링 · ' + esc(api.label) + '</small>화면 보기</h1>' +
      '<span class="live">실시간</span><span class="sp"></span>' +
      '<div class="snd" role="group" aria-label="소리"><button type="button" data-v="0">소리 끔</button><button type="button" data-v="1">소리 켬</button></div>' +
      '<button class="out" type="button">나가기</button></div>' +
      '<div class="wb"><aside id="wl" aria-label="누구의 화면"></aside>' +
      '<div class="st"><div class="cap" id="wcap"></div><div class="box" id="wbox"><div class="none">왼쪽에서 보고 싶은 사람을 고르세요</div></div></div></div>';
    document.body.appendChild(el);
    el.querySelector('.out').onclick = function () { api.leave(); };
    el.querySelector('.snd').onclick = function (e) {
      var b = e.target.closest('[data-v]'); if (!b) return;
      sound = b.dataset.v === '1'; this.classList.toggle('on', sound); applySound();
    };
    el.querySelector('#wl').onclick = function (e) {
      var b = e.target.closest('[data-k]'); if (!b || b.disabled) return;
      pick({ k: b.dataset.k, id: b.dataset.id });
    };
    addEventListener('resize', fit);
  }
  function applySound() {
    if (!sound || !sel) return api.audio('off');
    var v = view(), inLive = sel.k === 'm' || (v && v.cur && v.cur.id === sel.id);
    api.audio(inLive ? 'm' : 'w');   // 멘토·진행 중 학생 = 멘토링실 소리, 대기실 학생 = 대기실 소리
  }
  function frame(k) {
    if (frames[k]) return frames[k];
    var f = document.createElement('iframe');
    f.src = (k === 's' ? 'index.html' : 'm.html') + '?mirror=1&v=' + Date.now();
    f.title = k === 's' ? '학생 화면' : '멘토 화면';
    f.setAttribute('tabindex', '-1');
    frames[k] = f;
    return f;
  }
  function pick(s) {
    sel = s;
    var box = el.querySelector('#wbox'), D = s.k === 's' ? STU : MEN;
    var dev = box.querySelector('.dev');
    if (!dev || dev.dataset.k !== s.k) {
      box.innerHTML = '<div class="dev ' + (s.k === 's' ? 'ph' : 'pc') + '" data-k="' + s.k + '"><div class="sc"></div></div>';
      var f = frame(s.k);
      f.style.width = D.w + 'px'; f.style.height = D.h + 'px';
      box.querySelector('.sc').appendChild(f);
    }
    fit(); paintList(); applySound();
  }
  function fit() {
    var box = el && el.querySelector('#wbox'), dev = box && box.querySelector('.dev');
    if (!dev) return;
    var D = dev.dataset.k === 's' ? STU : MEN, pad = dev.dataset.k === 's' ? 24 : 20;
    var sc = Math.min((box.clientWidth - pad - 8) / D.w, (box.clientHeight - pad - 8) / D.h, 1.2);
    var s = dev.querySelector('.sc'), f = s.querySelector('iframe');
    s.style.width = Math.round(D.w * sc) + 'px'; s.style.height = Math.round(D.h * sc) + 'px';
    f.style.transform = 'scale(' + sc + ')';
  }
  function paintList() {
    var v = view(); if (!v || !el) return;
    var cur = v.cur, list = v.students || [];
    var item = function (k, id, ini, name, sub, cls, dis) {
      return '<button type="button" class="it ' + (cls || '') + (sel && sel.k === k && sel.id === id ? ' sel' : '') + '" data-k="' + k + '" data-id="' + esc(id) + '"' + (dis ? ' disabled' : '') + '>' +
        '<i>' + esc(ini) + '</i><span><b>' + esc(name) + '</b><small>' + esc(sub) + '</small></span></button>';
    };
    var h = '<h3>멘토</h3>' + item('m', 'M', '멘토', '멘토 ' + (v.mentorName || ''), v.mentorLive ? (cur ? '멘토링 중' : '학생 기다리는 중') : '접속 전', 'men', !v.mentorLive);
    if (cur) {
      var c = stu(cur.id) || cur;
      h += '<h3>멘토링 중</h3>' + item('s', cur.id, c.no || '·', PREFIX + cur.name, '멘토링실', 'cur', !cur.live);
    }
    var wait = list.filter(function (s) { return s.live && !s.done && !(cur && cur.id === s.id); });
    h += '<h3>대기실 (' + wait.length + ')</h3>' + (wait.map(function (s) { return item('s', s.id, s.no || '·', PREFIX + s.name, s.zoom ? 'ZOOM 안내' : '대기실', '', false); }).join('') || '<div class="none" style="padding:8px">대기실에 학생이 없습니다</div>');
    var off = list.filter(function (s) { return !s.live && !s.done && !(cur && cur.id === s.id); });
    var done = list.filter(function (s) { return s.done; });
    if (off.length) h += '<h3>접속 전 (' + off.length + ')</h3>' + off.map(function (s) { return item('s', s.id, s.no || '·', PREFIX + s.name, '접속 전', '', true); }).join('');
    if (done.length) h += '<h3>마침 (' + done.length + ')</h3>' + done.map(function (s) { return item('s', s.id, s.no || '·', PREFIX + s.name, '멘토링 마침', '', true); }).join('');
    if (h !== lastList) { lastList = h; el.querySelector('#wl').innerHTML = h; }
    // 고른 사람이 나가거나 끝나면: 진행 중 학생 → 멘토 순으로 다시 고름
    var cap = el.querySelector('#wcap');
    if (sel && sel.k === 's') {
      var st = stu(sel.id);
      if (!st || (!st.live && !(cur && cur.id === sel.id))) { cap.innerHTML = '<b>' + esc(PREFIX + (st ? st.name : '')) + '</b><span>접속이 끊겼습니다 — 다른 사람을 고르세요</span>'; }
      else cap.innerHTML = '<b>' + esc(PREFIX + st.name) + ' 학생 화면</b><span>' + (cur && cur.id === st.id ? '멘토링 중 · ' : '대기실 · ') + '이 학생에게 지금 보이는 화면(실시간, 보기만)</span>';
    } else if (sel && sel.k === 'm') cap.innerHTML = '<b>멘토 ' + esc(v.mentorName || '') + ' 화면</b><span>멘토에게 지금 보이는 화면(실시간, 보기만)</span>';
  }
  function autoPick() {
    var v = view(); if (!v || sel) return;
    if (v.cur && v.cur.live) pick({ k: 's', id: v.cur.id });
    else if (v.mentorLive) pick({ k: 'm', id: 'M' });
  }

  window.MeetWatch = {
    start: function (a) {
      api = a;
      document.body.classList.add('watch');
      css(); build();
      api.audio('off');
      var lastMode = '';
      setInterval(function () {
        autoPick(); paintList();
        // 고른 학생이 멘토링실로 가거나 대기실로 돌아오면 듣는 소리도 따라감
        var v = view(), mode = !sound || !sel ? 'off' : (sel.k === 'm' || (v && v.cur && v.cur.id === sel.id)) ? 'm' : 'w';
        if (mode !== lastMode) { lastMode = mode; applySound(); }
      }, 1000);
    }
  };
})();
