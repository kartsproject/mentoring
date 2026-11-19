/**
 * K예술영재 무용 온라인 멘토링 — 관문(Apps Script)  Ver.2.3
 *
 * 하는 일
 *  - 멘토·학생·운영진·연구원 브라우저가 서로 영상 연결 정보를 주고받도록 중계(영상은 브라우저끼리 직접 연결)
 *  - 회차별 진행 상태(현재 학생, 완료, ZOOM 전환, 화면 등장) 보관
 *  - 대기실: 학생 본인 확인(이름+생년월일), 대기실 채팅, 상단 고정 공지
 *  - Cloudflare TURN 임시 접속증 발급(스크립트 속성에 키가 있을 때만)
 *  - 대기실 화상(Ver.2.2): Cloudflare Realtime SFU 연결 요청을 앱 비밀키로 대신 보냄(비밀키는 브라우저에 가지 않음)
 *  - 시트 「명단」「회차」 읽기, 「기록」「채팅」 남기기
 *
 * 비밀값은 코드에 넣지 않습니다. [프로젝트 설정 > 스크립트 속성]에 넣습니다.
 *  MENTOR_CODE        멘토 접속 코드
 *  OPS_CODE           운영진 접속 코드
 *  RESEARCH_CODE      연구원 접속 코드
 *  CF_TURN_KEY_ID     (선택) Cloudflare TURN 키 ID
 *  CF_TURN_API_TOKEN  (선택) Cloudflare TURN API 토큰
 *  CF_SFU_APP_ID      대기실 화상용 Cloudflare Realtime SFU App ID (미술과 같은 값 사용 가능)
 *  CF_SFU_APP_TOKEN   대기실 화상용 Cloudflare Realtime SFU API Token (미술과 같은 값 사용 가능)
 *
 * 처음 한 번 / 코드를 바꾼 뒤: 편집기 상단에서 setup 선택 → 실행 (시트 탭·머리글을 맞춤, 기존 내용은 유지)
 * 배포: 배포 > 새 배포 > 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 * 수정 후: 배포 > 배포 관리 > 연필 > 버전 '새 버전' > 배포 (새 배포 금지: 주소가 바뀜)
 */

var TTL = 21600;           // 캐시 보관 6시간(최대값)
var SEEN_LIVE_MS = 12000;  // 이 시간 안에 신호가 있으면 '접속 중'
var MB_MAX = 60;           // 메시지함 최대 개수
var STAGE_MAX = 3;         // 멘토링 전 화면에 함께 등장할 수 있는 연구원·운영진 수
var CHAT_MAX = 300;        // 회차별 채팅 보관 개수(화면용, 전체 기록은 시트 「채팅」)
var BC_MAX = 10;           // 상단 고정 공지 보관 개수
var SLOT_MIN = 10;         // 1인 멘토링 시간(분) — 「멘토링 시간」에 끝 시각이 없을 때 사용
var TZ = 'Asia/Seoul';
var SFU_BASE = 'https://rtc.live.cloudflare.com/v1/apps/';

var ROSTER_HEAD = ['회차', '순서', '이름', '생년월일', '대기실 접속', '멘토링 시간', '학생 연락처', '보호자 연락처'];
var SESS_HEAD = ['회차', '날짜', '멘토', '휴식(몇 번째 학생 뒤)'];

/* ───────────── 진입점 ───────────── */
function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents || '{}'); }
  catch (err) { return out_({ ok: false, error: 'bad_json' }); }
  return out_(handle_(req));
}

function doGet(e) {
  if (e && e.parameter && e.parameter.p) {
    try { return out_(handle_(JSON.parse(e.parameter.p))); }
    catch (err) { return out_({ ok: false, error: 'bad_json' }); }
  }
  return out_({ ok: true, service: 'karts-meet', ver: 2, now: Date.now() });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  try {
    var r = String(req.r || '');
    if (req.a === 'join' && (!r || r === 'auto')) r = 'auto';   // 회차를 비우면 날짜에 맞춰 자동
    else if (!/^[\w-]{1,20}$/.test(r)) return { ok: false, error: 'bad_room' };
    switch (req.a) {
      case 'join': return join_(r, req);
      case 'poll': return poll_(r, req);
      case 'send': return send_(r, req);
      case 'op':   return op_(r, req);
      case 'chat': return chat_(r, req);
      case 'ice':  auth_(r, req); return { ok: true, ice: iceServers_() };
      case 'sfu':  return sfu_(r, req);
      case 'wr':   return wr_(r, req);
      default: return { ok: false, error: 'bad_action' };
    }
  } catch (err) {
    var msg = String(err && err.message || err);
    if (msg === 'auth') return { ok: false, error: 'auth' };
    if (msg === 'forbidden') return { ok: false, error: 'forbidden' };
    return { ok: false, error: 'server', detail: msg };
  }
}

/* ───────────── 저장소(캐시) ───────────── */
var C_ = null;
function cache_() { return C_ || (C_ = CacheService.getScriptCache()); }
function cget_(k) { var v = cache_().get(k); return v ? JSON.parse(v) : null; }
function cput_(k, v) { cache_().put(k, JSON.stringify(v), TTL); }
function props_() { return PropertiesService.getScriptProperties(); }

function blankState_() {
  return { parts: {}, cur: null, host: null, zoomUrl: '', zoom: {}, done: {}, test: {}, stage: {}, seq: 0 };
}
function getState_(r) { var s = cget_('st|' + r) || blankState_(); s.stage = s.stage || {}; return s; }
function isStaff_(role) { return role === 'ops' || role === 'research'; }
function putState_(r, s) { s.seq = (s.seq || 0) + 1; cput_('st|' + r, s); }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function token_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }

function auth_(r, req) {
  var id = String(req.id || '');
  var tok = cache_().get('tk|' + r + '|' + id);
  if (!id || !tok || tok !== String(req.tok || '')) throw new Error('auth');
  return id;
}

/* ───────────── 시트: 명단·회차 ───────────── */
function normName_(s) { return String(s || '').replace(/\s+/g, '').replace(/^(발레|무용)_/, ''); }
function digits_(s) { return String(s || '').replace(/\D/g, ''); }
function hm_(s) { var m = String(s || '').match(/(\d{1,2}):(\d{2})/g); return m || []; }
function addMin_(hm, m) {
  var p = String(hm).split(':'), t = Number(p[0]) * 60 + Number(p[1]) + m;
  return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
}
function roomOf_(v) { return String(v || '').replace(/회차/, '').trim(); }

function ss_() { try { return SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return null; } }

// 머리글 이름으로 열을 찾음(열 순서가 바뀌어도 동작)
function colMap_(head) {
  var find = function (keys) {
    for (var i = 0; i < head.length; i++) {
      var h = String(head[i]).replace(/\s+/g, '');
      for (var k = 0; k < keys.length; k++) if (h.indexOf(keys[k]) >= 0) return i;
    }
    return -1;
  };
  return {
    room: find(['회차']), no: find(['순서', '번호']), name: find(['이름', '성명']),
    birth: find(['생년월일', '생일']), wait: find(['대기']), time: find(['멘토링', '시작', '시간']),
    sPhone: find(['학생연락처', '학생전화', '학생휴대폰']), pPhone: find(['보호자'])
  };
}

function rosterAll_() {
  var hit = cget_('ro|all');
  if (hit) return hit;
  var all = {};
  var ss = ss_(), sh = ss && ss.getSheetByName('명단');
  if (sh && sh.getLastRow() > 1) {
    var vals = sh.getRange(1, 1, sh.getLastRow(), Math.max(4, sh.getLastColumn())).getDisplayValues();
    var c = colMap_(vals[0]);
    for (var i = 1; i < vals.length; i++) {
      var row = vals[i], get = function (k) { return c[k] >= 0 ? String(row[c[k]]).trim() : ''; };
      var r = roomOf_(get('room')), name = normName_(get('name'));
      if (!r || !name) continue;
      var t = hm_(get('time')), w = hm_(get('wait'));
      var start = t[0] || '', end = t[1] || (start ? addMin_(start, SLOT_MIN) : '');
      (all[r] = all[r] || []).push({
        no: Number(get('no')) || 0, name: name, birth: digits_(get('birth')),
        wait: w[0] || (start ? addMin_(start, -10) : ''), time: start, end: end,
        sPhone: get('sPhone'), pPhone: get('pPhone')
      });
    }
    Object.keys(all).forEach(function (k) { all[k].sort(function (a, b) { return a.no - b.no; }); });
  }
  cache_().put('ro|all', JSON.stringify(all), 60);
  return all;
}
function roster_(r) { return rosterAll_()[r] || []; }

function sessions_() {
  var hit = cget_('se|all');
  if (hit) return hit;
  var out = {};
  var ss = ss_(), sh = ss && ss.getSheetByName('회차');
  if (sh && sh.getLastRow() > 1) {
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
    vals.forEach(function (v) {
      var r = roomOf_(v[0]);
      if (!r) return;
      var d = v[1] instanceof Date ? Utilities.formatDate(v[1], TZ, 'yyyy-MM-dd') : String(v[1] || '').trim().replace(/\./g, '-');
      out[r] = { r: r, date: d, mentor: String(v[2] || '').trim(), brk: Number(v[3]) || 0 };
    });
  }
  Object.keys(rosterAll_()).forEach(function (r) { if (!out[r]) out[r] = { r: r, date: '', mentor: '', brk: 0 }; });
  cache_().put('se|all', JSON.stringify(out), 60);
  return out;
}

function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

// 날짜로 회차 고르기(리허설 test 제외): 오늘 → 가장 가까운 앞으로의 회차 → 가장 최근 회차
function autoRoom_() {
  var se = sessions_(), td = today_();
  var list = Object.keys(se).filter(function (k) { return k !== 'test' && se[k].date; })
    .map(function (k) { return se[k]; });
  var today = list.filter(function (x) { return x.date === td; })[0];
  if (today) return today.r;
  var up = list.filter(function (x) { return x.date > td; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; })[0];
  if (up) return up.r;
  var past = list.sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
  return past ? past.r : '';
}

/* ───────────── 기록 ───────────── */
function log_(r, kind, name, text) {
  try {
    var ss = ss_();
    if (!ss) return;
    var sh = ss.getSheetByName('기록') || ss.insertSheet('기록');
    if (sh.getLastRow() === 0) sh.appendRow(['시각', '회차', '구분', '이름', '내용']);
    sh.appendRow([new Date(), r, kind, name || '', text || '']);
  } catch (err) { /* 기록 실패는 진행에 영향 없음 */ }
}
function chatLog_(r, kind, name, text) {
  try {
    var ss = ss_();
    if (!ss) return;
    var sh = ss.getSheetByName('채팅') || ss.insertSheet('채팅');
    if (sh.getLastRow() === 0) sh.appendRow(['시각', '회차', '구분', '이름', '내용']);
    sh.appendRow([new Date(), r, kind, name || '', text || '']);
  } catch (err) {}
}

/* ───────────── join ───────────── */
function join_(r, req) {
  var role = String(req.role || '');
  var name = String(req.name || '').trim().slice(0, 30);
  var p = props_();
  var id, me = null;
  if (r === 'auto' && role !== 'student') { r = autoRoom_(); if (!r) return { ok: false, error: 'no_session' }; }

  if (role === 'mentor') {
    if (String(req.code || '') !== String(p.getProperty('MENTOR_CODE') || '__none__')) return { ok: false, error: 'code' };
    id = 'M';
    name = name || '멘토';
  } else if (role === 'ops' || role === 'research') {
    var codeKey = role === 'ops' ? 'OPS_CODE' : 'RESEARCH_CODE';
    if (String(req.code || '') !== String(p.getProperty(codeKey) || '__none__')) return { ok: false, error: 'code' };
    if (!name) return { ok: false, error: 'name' };
    // 같은 사람이 녹화 창 + 대기실 창을 함께 열 수 있도록 창 종류별로 구분
    id = (role === 'ops' ? 'O_' : 'R_') + normName_(name).slice(0, 12) + (req.panel ? '~p' : '');
  } else if (role === 'student') {
    var nm = normName_(name), birth = digits_(req.birth);
    if (!nm) return { ok: false, error: 'name' };
    var all = rosterAll_(), cands = [];
    Object.keys(all).forEach(function (k) {
      if (r !== 'auto' && k !== r) return;
      all[k].forEach(function (x) { if (x.name === nm) cands.push({ r: k, x: x }); });
    });
    if (!cands.length) {
      if (r !== 'auto' && !roster_(r).length) { me = { no: 0, test: true }; }   // 명단이 없는 회차(시험): 이름만으로 입장
      else return { ok: false, error: 'not_in_roster' };
    } else {
      // 생년월일 확인(명단에 있을 때만): 8자리 또는 6자리(YYMMDD)
      var okB = cands.filter(function (c) {
        if (!c.x.birth) return true;
        return birth && (birth === c.x.birth || (birth.length === 6 && c.x.birth.slice(-6) === birth));
      });
      if (!okB.length) return { ok: false, error: 'birth' };
      // 여러 회차에 있으면: 오늘 → 가장 가까운 앞으로의 회차 → 가장 최근 회차
      var se = sessions_(), td = today_();
      var rank = function (c) { var d = (se[c.r] || {}).date || ''; return d === td ? 0 : d > td ? 1 : 2; };
      okB.sort(function (a, b) {
        var ka = rank(a), kb = rank(b);
        if (ka !== kb) return ka - kb;
        var da = (se[a.r] || {}).date || '', db = (se[b.r] || {}).date || '';
        return ka === 2 ? (da < db ? 1 : -1) : (da < db ? -1 : 1);
      });
      var pick = okB[0];
      r = pick.r;
      var s0 = se[r] || {};
      me = { no: pick.x.no, wait: pick.x.wait, time: pick.x.time, end: pick.x.end, date: s0.date || '', mentor: s0.mentor || '', test: r === 'test' };
    }
    if (r === 'auto') return { ok: false, error: 'not_in_roster' };
    id = 'S_' + nm;
    name = nm;
  } else {
    return { ok: false, error: 'bad_role' };
  }

  var tok = token_(), pid = '';
  var res = withLock_(function () {
    var s = getState_(r);
    var isNew = !s.parts[id], old = s.parts[id] || {};
    s.n = s.n || 0;
    s.parts[id] = { role: role, name: name, joinedAt: old.joinedAt || Date.now(), panel: !!req.panel, pid: old.pid || ('p' + (++s.n)) };
    pid = s.parts[id].pid;
    putState_(r, s);
    cache_().put('tk|' + r + '|' + id, tok, TTL);
    return { isNew: isNew };
  });
  cput_('sn|' + r + '|' + id, { t: Date.now(), info: {} });
  log_(r, '입장', name, role + (req.panel ? '(대기실 창)' : '') + (res.isNew ? '' : ' (재접속)'));
  return { ok: true, id: id, tok: tok, pid: pid, name: name, role: role, r: r, me: me, ice: iceServers_(), now: Date.now() };
}

/* ───────────── poll ───────────── */
function poll_(r, req) {
  var id = auth_(r, req);
  var now = Date.now();
  cput_('sn|' + r + '|' + id, { t: now, info: req.info || {} });

  // 메시지함: 비어 있으면 잠금 없이 통과
  var msgs = [];
  var mbKey = 'mb|' + r + '|' + id;
  if (cache_().get(mbKey)) {
    msgs = withLock_(function () {
      var m = cget_(mbKey) || [];
      cache_().remove(mbKey);
      return m;
    });
  }

  var s = getState_(r);
  var role = (s.parts[id] && s.parts[id].role) || '';
  var out = { ok: true, now: now, msgs: msgs, view: view_(r, s, id, role, now) };
  if (role !== 'mentor') out.chat = chatView_(r, role, req.since, req.gv);
  return out;
}

function seenMap_(r, s) {
  var ids = Object.keys(s.parts);
  var keys = ids.map(function (i) { return 'sn|' + r + '|' + i; });
  var got = keys.length ? cache_().getAll(keys) : {};
  var out = {};
  ids.forEach(function (i, k) { var v = got[keys[k]]; out[i] = v ? JSON.parse(v) : null; });
  return out;
}

function view_(r, s, id, role, now) {
  var seen = seenMap_(r, s);
  var live = function (i) { return !!(seen[i] && now - seen[i].t < SEEN_LIVE_MS); };
  // 영상을 받는 운영진·연구원(대기실 창은 영상을 받지 않음)
  var ops = Object.keys(s.parts).filter(function (i) { return isStaff_(s.parts[i].role) && !s.parts[i].panel && live(i); });
  var stage = s.cur ? [] : Object.keys(s.stage).filter(function (i) { return s.parts[i] && live(i); })
    .sort(function (a, b) { return s.stage[a] - s.stage[b]; })
    .map(function (i) { return { id: i, name: s.parts[i].name, role: s.parts[i].role, info: seen[i] ? seen[i].info : null }; });
  var cur = s.cur ? { id: s.cur.id, name: s.cur.name, no: s.cur.no, at: s.cur.at, live: live(s.cur.id) } : null;
  var se = sessions_()[r] || { r: r, date: '', mentor: '', brk: 0 };

  // 학생 목록(명단 순서 → 명단 밖 접속자)
  var students = [];
  var ro = roster_(r);
  var byName = {};
  Object.keys(s.parts).forEach(function (i) { if (s.parts[i].role === 'student') byName[s.parts[i].name] = i; });
  ro.forEach(function (x) {
    students.push({ id: 'S_' + x.name, name: x.name, no: x.no, wait: x.wait, time: x.time, end: x.end,
                    sPhone: x.sPhone, pPhone: x.pPhone, joined: !!byName[x.name] });
    delete byName[x.name];
  });
  Object.keys(byName).forEach(function (nm) {
    students.push({ id: byName[nm], name: nm, no: 0, wait: '', time: '', end: '', joined: true, extra: true });
  });
  students.forEach(function (st) {
    var sn = seen[st.id];
    st.live = live(st.id);
    st.seenAt = sn ? sn.t : 0;
    st.info = sn ? sn.info : null;
    st.done = s.done[st.id] || 0;
    st.test = s.test[st.id] || null;
    st.zoom = !!s.zoom[st.id];
  });
  var waiting = students.filter(function (st) { return !st.done && !(cur && cur.id === st.id) && !st.zoom; });
  var nx = waiting.filter(function (st) { return st.live; })[0] || null;
  var next = nx ? { id: nx.id, name: nx.name, no: nx.no, time: nx.time, info: nx.info } : null;
  var online = students.filter(function (st) { return st.live; }).length;

  // 대기실 화상: 영상을 올린 사람(학생은 멘토링 중·완료·ZOOM이 아닐 때만)
  var wr = Object.keys(s.parts).filter(function (i) {
    var p = s.parts[i];
    if (!p.wr || !p.wr.sfu || !live(i)) return false;
    if (p.role === 'student') return !(s.cur && s.cur.id === i) && !s.done[i] && !s.zoom[i];
    return isStaff_(p.role);
  }).map(function (i) {
    var p = s.parts[i], sn = seen[i];
    return { id: i, pid: p.pid, name: p.name, role: p.role, sfu: p.wr.sfu, tr: p.wr.tr || {}, talk: !!(sn && sn.info && sn.info.wtalk), at: p.wr.at || 0,
             mic: p.role === 'student' ? !(sn && sn.info && sn.info.mic === false) : !!(sn && sn.info && sn.info.wtalk) };
  });

  if (role === 'student') {
    var me = null, ahead = 0;
    for (var k = 0; k < waiting.length; k++) { if (waiting[k].id === id) { me = waiting[k]; break; } ahead++; }
    var mine = students.filter(function (st) { return st.id === id; })[0] || {};
    return {
      seq: s.seq, me: id,
      called: !!(s.cur && s.cur.id === id),
      cur: (s.cur && s.cur.id === id) ? cur : null,
      busy: !!s.cur,
      curNo: s.cur ? s.cur.no : 0,
      isNext: !!(next && next.id === id),
      ahead: me ? ahead : 0,
      myNo: mine.no || 0, myWait: mine.wait || '', myTime: mine.time || '', myEnd: mine.end || '',
      date: se.date, mentor: se.mentor, online: online,
      mentorLive: live('M'),
      host: s.host && live(s.host) ? s.host : null,
      done: !!s.done[id],
      test: s.test[id] || null,
      zoomUrl: s.zoom[id] ? s.zoomUrl : '',
      wr: wr, wmuteAt: (s.parts[id] && s.parts[id].wmuteAt) || 0, ringAt: (s.parts[id] && s.parts[id].ringAt) || 0
    };
  }

  var base = { seq: s.seq, me: id, cur: cur, next: next, mentorLive: live('M'), mentorInfo: seen.M ? seen.M.info : null,
               ops: ops, students: students.map(function (st) {
                 if (role === 'mentor') { var c = {}; for (var key in st) if (key !== 'sPhone' && key !== 'pPhone') c[key] = st[key]; return c; }
                 return st;
               }), stage: stage, session: se, online: online };
  if (role === 'mentor') return base;

  // 운영진·연구원
  base.wr = wr;
  base.host = s.host && live(s.host) ? s.host : null;
  base.hostName = base.host && s.parts[base.host] ? s.parts[base.host].name : '';
  base.zoomUrl = s.zoomUrl;
  base.opsList = Object.keys(s.parts).filter(function (i) { return isStaff_(s.parts[i].role) && live(i); })
    .map(function (i) { return { id: i, name: s.parts[i].name, role: s.parts[i].role, panel: !!s.parts[i].panel, info: seen[i] ? seen[i].info : null }; });
  base.myRole = role;
  base.mentorName = s.parts.M ? s.parts.M.name : '';
  var all = sessions_();
  base.sessions = Object.keys(all).map(function (k) { return all[k]; })
    .sort(function (a, b) { return (a.r === 'test') - (b.r === 'test') || (Number(a.r) || 0) - (Number(b.r) || 0); });
  return base;
}

/* ───────────── 대기실 채팅·공지 ───────────── */
function chatState_(r) { return cget_('ch|' + r) || { gv: 1, last: 0, list: [] }; }
function bcState_(r) { return cget_('bc|' + r) || []; }

function chatView_(r, role, since, gv) {
  var ch = chatState_(r);
  var staff = role !== 'student';
  var full = Number(gv) !== ch.gv;
  var list = full ? ch.list : ch.list.filter(function (m) { return m.i > (Number(since) || 0); });
  if (!staff) list = list.map(function (m) { return { i: m.i, t: m.t, f: m.f, n: m.n, x: m.x }; });   // 학생에게는 운영진 이름을 보내지 않음
  return { gv: ch.gv, last: ch.last, full: full, list: list, bc: bcState_(r).map(function (b) { return staff ? b : { t: b.t, x: b.x }; }) };
}

function chat_(r, req) {
  var id = auth_(r, req);
  var text = String(req.text || '').trim().slice(0, 300);
  if (!text) return { ok: false, error: 'empty' };
  var who = null;
  var res = withLock_(function () {
    var s = getState_(r), me = s.parts[id];
    if (!me) throw new Error('auth');
    if (me.role === 'mentor') throw new Error('forbidden');
    who = me;
    var ch = chatState_(r);
    var m = { i: ++ch.last, t: Date.now(), x: text };
    if (me.role === 'student') { m.f = 's'; m.n = me.name; }
    else { m.f = 'o'; m.b = (me.role === 'research' ? '연구원 ' : '') + me.name; }
    ch.list.push(m);
    while (ch.list.length > CHAT_MAX) ch.list.shift();
    cput_('ch|' + r, ch);
    return { ok: true, i: m.i };
  });
  chatLog_(r, who.role === 'student' ? '학생' : who.role === 'research' ? '연구원' : '운영진', who.name, text);
  res.chat = chatView_(r, who.role, req.since, req.gv);
  return res;
}

/* ───────────── send ───────────── */
function send_(r, req) {
  var id = auth_(r, req);
  var list = Array.isArray(req.msgs) ? req.msgs : [];
  if (!list.length) return { ok: true };
  withLock_(function () {
    list.forEach(function (m) {
      var to = String(m.to || '');
      if (!to) return;
      var k = 'mb|' + r + '|' + to;
      var box = cget_(k) || [];
      var msg = m.msg || {};
      msg.from = id;
      box.push(msg);
      while (box.length > MB_MAX) box.shift();
      cput_(k, box);
    });
  });
  return { ok: true };
}

/* ───────────── 운영 명령 ───────────── */
function op_(r, req) {
  var id = auth_(r, req);
  var cmd = String(req.cmd || '');
  var name = '';
  var result = withLock_(function () {
    var s = getState_(r);
    var me = s.parts[id];
    if (!me || !isStaff_(me.role)) throw new Error('forbidden');
    if (me.role === 'research' && cmd !== 'stage') throw new Error('forbidden'); // 연구원은 화면 등장만
    name = me.name;
    var now = Date.now();
    switch (cmd) {
      case 'stage':
        if (req.on) {
          if (s.cur) return { ok: false, error: 'busy' };
          var seenNow = seenMap_(r, s);
          Object.keys(s.stage).forEach(function (i) {   // 나간 사람 정리
            if (i !== id && !(seenNow[i] && now - seenNow[i].t < SEEN_LIVE_MS)) delete s.stage[i];
          });
          if (!s.stage[id] && Object.keys(s.stage).length >= STAGE_MAX) return { ok: false, error: 'full' };
          s.stage[id] = s.stage[id] || now;
        } else delete s.stage[id];
        break;
      case 'call': {
        var sid = String(req.sid || '');
        var p = s.parts[sid];
        var ro = roster_(r);
        var nm = p ? p.name : sid.replace(/^S_/, '');
        if (s.cur && s.cur.id !== sid) s.done[s.cur.id] = now;
        var no = 0;
        ro.forEach(function (x) { if (x.name === nm) no = x.no; });
        var at = Number(req.at);                          // 운영 화면이 즉시 알린 시작 시각(타이머 일치)
        if (!(at && Math.abs(at - now) < 15000)) at = now;
        s.cur = { id: sid, name: nm, no: no, at: at };
        s.stage = {};   // 멘토링이 시작되면 연구원·운영진은 화면에서 내려감
        delete s.done[sid];
        delete s.zoom[sid];
        log_(r, '시작', nm, '');
        break;
      }
      case 'end':
        if (s.cur) { s.done[s.cur.id] = now; log_(r, '종료', s.cur.name, ''); }
        s.cur = null;
        break;
      case 'undone':
        delete s.done[String(req.sid || '')];
        break;
      case 'host':
        s.host = req.on ? id : (s.host === id ? null : s.host);
        break;
      case 'zoomurl':
        s.zoomUrl = String(req.url || '').slice(0, 500);
        break;
      case 'zoom':
        if (req.on) { s.zoom[String(req.sid)] = now; log_(r, 'ZOOM 전환', String(req.sid).replace(/^S_/, ''), ''); }
        else delete s.zoom[String(req.sid)];
        break;
      case 'test':
        s.test[String(req.sid)] = { ok: !!req.ok, relay: !!req.relay, at: now };
        log_(r, '연결점검', String(req.sid).replace(/^S_/, ''), req.ok ? (req.relay ? '성공(중계)' : '성공(직접)') : '실패');
        break;
      case 'untest':
        delete s.test[String(req.sid)];
        break;
      // 상단 고정 공지
      case 'bc': {
        var text = String(req.text || '').trim().slice(0, 300);
        if (!text) return { ok: false, error: 'empty' };
        var bc = bcState_(r);
        bc.push({ t: now, x: text, b: name });
        while (bc.length > BC_MAX) bc.shift();
        cput_('bc|' + r, bc);
        chatLog_(r, '공지', name, text);
        return { ok: true, bc: bc };
      }
      case 'bcclear':
        cput_('bc|' + r, []);
        return { ok: true, bc: [] };
      // 채팅 지우기: i가 있으면 그 메시지만, 없으면 전체
      case 'del': {
        var ch = chatState_(r), i = Number(req.i) || 0;
        if (i) ch.list = ch.list.filter(function (m) { return m.i !== i; });
        else ch.list = [];
        ch.gv++;
        cput_('ch|' + r, ch);
        chatLog_(r, '지움', name, i ? ('메시지 ' + i) : '전체');
        return { ok: true, chat: chatView_(r, 'ops', 0, -1) };
      }
      case 'reset': {
        var parts = s.parts, pn = s.n;
        s = blankState_();
        s.parts = parts; s.n = pn;
        var ch2 = chatState_(r); cput_('ch|' + r, { gv: ch2.gv + 1, last: ch2.last, list: [] });
        cput_('bc|' + r, []);
        log_(r, '초기화', name, '');
        break;
      }
      default:
        return { ok: false, error: 'bad_cmd' };
    }
    putState_(r, s);
    return { ok: true };
  });
  return result;
}

/* ───────────── 대기실 화상 ─────────────
 *  cmd pub : 내가 대기실에 올린 영상·소리 이름 등록(sfu 세션, tr {cam, mic}) — 비우면 대기실 화상에서 나감
 *  cmd mute: (운영진) 학생 마이크 끄기 요청
 *  cmd ring: (운영진) 학생 호출 — 학생 화면에 「띵동」 소리
 */
function wr_(r, req) {
  var id = auth_(r, req), cmd = String(req.cmd || '');
  return withLock_(function () {
    var s = getState_(r), me = s.parts[id];
    if (!me || me.role === 'mentor') throw new Error('forbidden');
    if (cmd === 'pub') {
      var sfu = String(req.sfu || '').slice(0, 64), tr = {};
      ['cam', 'mic'].forEach(function (k) { if (req.tr && req.tr[k]) tr[k] = String(req.tr[k]).slice(0, 64); });
      me.wr = sfu ? { sfu: sfu, tr: tr, at: (me.wr && me.wr.sfu === sfu && me.wr.at) || Date.now() } : null;
    } else if (cmd === 'mute' || cmd === 'ring') {
      if (me.role !== 'ops') throw new Error('forbidden');
      var t = s.parts[String(req.sid || '')];
      if (!t) return { ok: false, error: 'not_here' };
      if (cmd === 'mute') t.wmuteAt = Date.now();
      else { t.ringAt = Date.now(); log_(r, '학생 호출', t.name, me.name); }
    } else return { ok: false, error: 'bad_cmd' };
    putState_(r, s);
    return { ok: true };
  });
}

/* Cloudflare Realtime SFU 대행 — 브라우저는 연결 정보(SDP)만 보내고, 앱 비밀키는 여기서만 씀
 *  op: new | push | pull | update | reneg | close */
function sfu_(r, req) {
  var id = auth_(r, req), p = props_();
  var app = p.getProperty('CF_SFU_APP_ID'), key = p.getProperty('CF_SFU_APP_TOKEN');
  if (!app || !key) return { ok: false, error: 'sfu_not_set' };
  var s = getState_(r), me = s.parts[id];
  if (!me || me.role === 'mentor') throw new Error('forbidden');
  var op = String(req.op || ''), sid = String(req.sid || '');
  if (op !== 'new' && !/^[\w-]{8,64}$/.test(sid)) return { ok: false, error: 'bad_sid' };
  var path, method = 'post', body = null;
  var simul = function (rid) { return { preferredRid: String(rid), priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' }; };
  switch (op) {
    case 'new': path = '/sessions/new'; break;
    case 'push':
      path = '/sessions/' + sid + '/tracks/new';
      body = { sessionDescription: { type: 'offer', sdp: String(req.sdp || '') },
               tracks: (req.tracks || []).slice(0, 4).map(function (t) { return { location: 'local', mid: String(t.mid), trackName: String(t.trackName) }; }) };
      break;
    case 'pull':
      path = '/sessions/' + sid + '/tracks/new';
      body = { tracks: (req.tracks || []).slice(0, 40).map(function (t) {
        var o = { location: 'remote', sessionId: String(t.sessionId), trackName: String(t.trackName) };
        if (t.rid) o.simulcast = simul(t.rid);
        return o;
      }) };
      break;
    case 'update':
      path = '/sessions/' + sid + '/tracks/update'; method = 'put';
      body = { tracks: (req.tracks || []).slice(0, 40).map(function (t) {
        return { location: 'remote', sessionId: String(t.sessionId), trackName: String(t.trackName), mid: String(t.mid), simulcast: simul(t.rid) };
      }) };
      break;
    case 'reneg':
      path = '/sessions/' + sid + '/renegotiate'; method = 'put';
      body = { sessionDescription: { type: 'answer', sdp: String(req.sdp || '') } };
      break;
    case 'close':
      path = '/sessions/' + sid + '/tracks/close'; method = 'put';
      body = { tracks: (req.mids || []).slice(0, 40).map(function (m) { return { mid: String(m) }; }), force: false };
      if (req.sdp) body.sessionDescription = { type: 'offer', sdp: String(req.sdp) };
      break;
    default: return { ok: false, error: 'bad_op' };
  }
  var opt = { method: method, contentType: 'application/json', headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true };
  if (body) opt.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch(SFU_BASE + encodeURIComponent(app) + path, opt);
  var code = res.getResponseCode(), j = {};
  try { j = JSON.parse(res.getContentText() || '{}'); } catch (e) {}
  if (code >= 300 || j.errorCode) return { ok: false, error: 'sfu', code: code, detail: j.errorDescription || j.errorCode || ('HTTP ' + code) };
  return { ok: true, res: j };
}

/* ───────────── ICE(STUN/TURN) ───────────── */
function iceServers_() {
  var base = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  var p = props_();
  var keyId = p.getProperty('CF_TURN_KEY_ID');
  var apiTok = p.getProperty('CF_TURN_API_TOKEN');
  if (!keyId || !apiTok) return base;

  var hit = cget_('ice|cf');
  if (hit) return hit;
  try {
    var res = UrlFetchApp.fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + apiTok },
      payload: JSON.stringify({ ttl: 43200 }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) return base;
    var data = JSON.parse(res.getContentText());
    var list = data.iceServers;
    if (!Array.isArray(list)) list = list ? [list] : [];
    // 브라우저가 막는 53번 포트 주소는 뺌(연결 지연 원인)
    list = list.map(function (s) {
      var urls = [].concat(s.urls || []).filter(function (u) { return !/:53(\?|$)/.test(u); });
      var o = { urls: urls };
      if (s.username) { o.username = s.username; o.credential = s.credential; }
      return o;
    }).filter(function (s) { return s.urls.length; });
    var all = base.concat(list);
    cache_().put('ice|cf', JSON.stringify(all), TTL); // 12시간 유효 접속증을 6시간 재사용
    return all;
  } catch (err) {
    return base;
  }
}

/* ───────────── 처음 설정 / 시트 정리 ───────────── */
function setup() {
  var ss = ss_();
  if (ss) {
    // 「명단」: 예전 4칸(회차·순서·시작·이름)이면 새 머리글로 옮겨 담음
    var ro = ss.getSheetByName('명단') || ss.insertSheet('명단');
    if (ro.getLastRow() === 0) {
      ro.appendRow(ROSTER_HEAD);
      ro.appendRow(['test', 1, '리허설학생', '', '', '', '', '']);
    } else {
      var head = ro.getRange(1, 1, 1, Math.max(4, ro.getLastColumn())).getDisplayValues()[0];
      if (head.indexOf('생년월일') < 0) {
        var c = colMap_(head);
        var rows = ro.getLastRow() > 1 ? ro.getRange(2, 1, ro.getLastRow() - 1, Math.max(4, ro.getLastColumn())).getDisplayValues() : [];
        var moved = rows.map(function (v) {
          var g = function (k) { return c[k] >= 0 ? v[c[k]] : ''; };
          return [g('room'), g('no'), g('name'), '', g('wait'), g('time'), '', ''];
        });
        ro.clearContents();
        ro.getRange(1, 1, 1, ROSTER_HEAD.length).setValues([ROSTER_HEAD]);
        if (moved.length) ro.getRange(2, 1, moved.length, ROSTER_HEAD.length).setValues(moved);
      }
    }
    ro.setFrozenRows(1);
    ro.getRange('D:D').setNumberFormat('@');   // 생년월일 앞자리 0 보존
    ro.getRange('G:H').setNumberFormat('@');   // 전화번호 앞자리 0 보존

    var se = ss.getSheetByName('회차') || ss.insertSheet('회차');
    if (se.getLastRow() === 0) {
      se.getRange('B:B').setNumberFormat('@');
      se.appendRow(SESS_HEAD);
      se.appendRow(['1', '2026-10-25', '정은영', 5]);
      se.appendRow(['2', '2026-11-21', '정은영', 5]);
      se.appendRow(['3', '2026-12-06', '정은영', 5]);
      se.appendRow(['test', '', '', 0]);
      se.setFrozenRows(1);
    }
    ['기록', '채팅'].forEach(function (n) {
      var sh = ss.getSheetByName(n) || ss.insertSheet(n);
      if (sh.getLastRow() === 0) { sh.appendRow(['시각', '회차', '구분', '이름', '내용']); sh.setFrozenRows(1); }
    });
  }
  var p = props_();
  if (!p.getProperty('MENTOR_CODE')) p.setProperty('MENTOR_CODE', 'mentor' + Math.floor(1000 + Math.random() * 9000));
  if (!p.getProperty('OPS_CODE')) p.setProperty('OPS_CODE', 'ops' + Math.floor(1000 + Math.random() * 9000));
  if (!p.getProperty('RESEARCH_CODE')) p.setProperty('RESEARCH_CODE', 'research' + Math.floor(1000 + Math.random() * 9000));
  cache_().removeAll(['ro|all', 'se|all']);
  Logger.log('멘토 코드: ' + p.getProperty('MENTOR_CODE'));
  Logger.log('운영진 코드: ' + p.getProperty('OPS_CODE'));
  Logger.log('연구원 코드: ' + p.getProperty('RESEARCH_CODE'));
  Logger.log('TURN 설정: ' + (p.getProperty('CF_TURN_KEY_ID') ? '있음' : '없음(STUN만 사용)'));
  Logger.log('ICE 확인: ' + JSON.stringify(iceServers_()).slice(0, 300));
  var hasSfu = p.getProperty('CF_SFU_APP_ID') && p.getProperty('CF_SFU_APP_TOKEN');
  Logger.log('대기실 화상(SFU) 설정: ' + (hasSfu ? '있음' : '없음 — CF_SFU_APP_ID·CF_SFU_APP_TOKEN을 넣어 주세요(미술과 같은 값)'));
  if (hasSfu) {
    var t = UrlFetchApp.fetch(SFU_BASE + encodeURIComponent(p.getProperty('CF_SFU_APP_ID')) + '/sessions/new', {
      method: 'post', headers: { Authorization: 'Bearer ' + p.getProperty('CF_SFU_APP_TOKEN') }, muteHttpExceptions: true });
    Logger.log('SFU 연결 시험: ' + (t.getResponseCode() < 300 ? '성공' : '실패 HTTP ' + t.getResponseCode() + ' ' + t.getContentText().slice(0, 200)));
  }
  var all = rosterAll_();
  Logger.log('명단: ' + Object.keys(all).map(function (k) { return k + '회차 ' + all[k].length + '명'; }).join(', '));
}

/** 리허설(test) 회차의 진행 상태·채팅·공지를 비웁니다. 편집기에서 resetTestRoom 선택 → 실행 */
function resetTestRoom() {
  cache_().removeAll(['st|test', 'ch|test', 'bc|test']);
  Logger.log('test 회차 초기화 완료');
}
