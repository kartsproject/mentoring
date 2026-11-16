/**
 * K예술영재 무용 온라인 멘토링 — 연결 관문(시그널링) Apps Script
 *
 * 하는 일
 *  - 멘토·학생·운영진 브라우저가 서로 영상 연결 정보를 주고받도록 중계(실제 영상은 브라우저끼리 직접 연결)
 *  - 회차별 진행 상태(현재 학생, 완료, 공지, ZOOM 전환) 보관
 *  - Cloudflare TURN 임시 접속증 발급(스크립트 속성에 키가 있을 때만)
 *  - 명단(시트 「명단」) 확인, 진행 기록(시트 「기록」) 남김
 *
 * 비밀값은 코드에 넣지 않습니다. [프로젝트 설정 > 스크립트 속성]에 넣습니다.
 *  MENTOR_CODE        멘토 접속 코드
 *  OPS_CODE           운영진 접속 코드
 *  RESEARCH_CODE      연구원 접속 코드
 *  CF_TURN_KEY_ID     (선택) Cloudflare TURN 키 ID
 *  CF_TURN_API_TOKEN  (선택) Cloudflare TURN API 토큰
 *
 * 처음 한 번: 편집기 상단에서 setup 선택 → 실행 → 권한 허용
 * 배포: 배포 > 새 배포 > 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 * 수정 후: 배포 > 배포 관리 > 연필 > 버전 '새 버전' > 배포 (새 배포 금지: 주소가 바뀜)
 */

var TTL = 21600;           // 캐시 보관 6시간(최대값)
var SEEN_LIVE_MS = 12000;  // 이 시간 안에 신호가 있으면 '접속 중'
var MB_MAX = 60;           // 메시지함 최대 개수
var STAGE_MAX = 3;         // 멘토링 전 화면에 함께 등장할 수 있는 연구원·운영진 수

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
  return out_({ ok: true, service: 'karts-meet', now: Date.now() });
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handle_(req) {
  try {
    var r = String(req.r || '');
    if (!/^[\w-]{1,20}$/.test(r)) return { ok: false, error: 'bad_room' };
    switch (req.a) {
      case 'join': return join_(r, req);
      case 'poll': return poll_(r, req);
      case 'send': return send_(r, req);
      case 'op':   return op_(r, req);
      case 'ice':  auth_(r, req); return { ok: true, ice: iceServers_() };
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
  return { parts: {}, cur: null, host: null, notice: null, zoomUrl: '', zoom: {}, done: {}, test: {}, stage: {}, seq: 0 };
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

/* ───────────── 명단 ───────────── */
function normName_(s) { return String(s || '').replace(/\s+/g, '').replace(/^(발레|무용)_/, ''); }

function roster_(r) {
  var key = 'ro|' + r;
  var hit = cget_(key);
  if (hit) return hit;
  var list = [];
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss && ss.getSheetByName('명단');
    if (sh && sh.getLastRow() > 1) {
      var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getDisplayValues();
      rows.forEach(function (row) {
        if (String(row[0]).replace(/회차/, '').trim() === r && row[3]) {
          list.push({ no: Number(row[1]) || 0, time: String(row[2]).trim(), name: normName_(row[3]) });
        }
      });
      list.sort(function (a, b) { return a.no - b.no; });
    }
  } catch (err) { /* 시트 없음: 명단 없이 운영 */ }
  cache_().put(key, JSON.stringify(list), 60);
  return list;
}

/* ───────────── 기록 ───────────── */
function log_(r, kind, name, text) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;
    var sh = ss.getSheetByName('기록') || ss.insertSheet('기록');
    if (sh.getLastRow() === 0) sh.appendRow(['시각', '회차', '구분', '이름', '내용']);
    sh.appendRow([new Date(), r, kind, name || '', text || '']);
  } catch (err) { /* 기록 실패는 진행에 영향 없음 */ }
}

/* ───────────── join ───────────── */
function join_(r, req) {
  var role = String(req.role || '');
  var name = String(req.name || '').trim().slice(0, 30);
  var p = props_();
  var id;

  if (role === 'mentor') {
    if (String(req.code || '') !== String(p.getProperty('MENTOR_CODE') || '__none__')) return { ok: false, error: 'code' };
    id = 'M';
    name = name || '멘토';
  } else if (role === 'ops') {
    if (String(req.code || '') !== String(p.getProperty('OPS_CODE') || '__none__')) return { ok: false, error: 'code' };
    if (!name) return { ok: false, error: 'name' };
    id = 'O_' + normName_(name).slice(0, 12);
  } else if (role === 'research') {
    if (String(req.code || '') !== String(p.getProperty('RESEARCH_CODE') || '__none__')) return { ok: false, error: 'code' };
    if (!name) return { ok: false, error: 'name' };
    id = 'R_' + normName_(name).slice(0, 12);
  } else if (role === 'student') {
    var nm = normName_(name);
    if (!nm) return { ok: false, error: 'name' };
    var ro = roster_(r);
    if (ro.length && !ro.some(function (x) { return x.name === nm; })) return { ok: false, error: 'not_in_roster' };
    id = 'S_' + nm;
    name = nm;
  } else {
    return { ok: false, error: 'bad_role' };
  }

  var tok = token_();
  var res = withLock_(function () {
    var s = getState_(r);
    var isNew = !s.parts[id];
    s.parts[id] = { role: role, name: name, joinedAt: (s.parts[id] && s.parts[id].joinedAt) || Date.now() };
    putState_(r, s);
    cache_().put('tk|' + r + '|' + id, tok, TTL);
    return { isNew: isNew };
  });
  cput_('sn|' + r + '|' + id, { t: Date.now(), info: {} });
  log_(r, '입장', name, role + (res.isNew ? '' : ' (재접속)'));
  return { ok: true, id: id, tok: tok, name: name, role: role, ice: iceServers_(), now: Date.now() };
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
  return { ok: true, now: now, msgs: msgs, view: view_(r, s, id, role, now) };
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
  var ops = Object.keys(s.parts).filter(function (i) { return isStaff_(s.parts[i].role) && live(i); });
  // 멘토링 전 화면 등장(연구원·운영진): 접속 중인 사람만
  var stage = s.cur ? [] : Object.keys(s.stage).filter(function (i) { return s.parts[i] && live(i); })
    .sort(function (a, b) { return s.stage[a] - s.stage[b]; })
    .map(function (i) { return { id: i, name: s.parts[i].name, role: s.parts[i].role, info: seen[i] ? seen[i].info : null }; });
  var cur = s.cur ? { id: s.cur.id, name: s.cur.name, no: s.cur.no, at: s.cur.at, live: live(s.cur.id) } : null;

  // 학생 목록(명단 순서 → 명단 밖 접속자)
  var students = [];
  var ro = roster_(r);
  var byName = {};
  Object.keys(s.parts).forEach(function (i) { if (s.parts[i].role === 'student') byName[s.parts[i].name] = i; });
  ro.forEach(function (x) {
    var i = 'S_' + x.name;
    students.push({ id: i, name: x.name, no: x.no, time: x.time, joined: !!byName[x.name] });
    delete byName[x.name];
  });
  Object.keys(byName).forEach(function (nm) {
    students.push({ id: byName[nm], name: nm, no: 0, time: '', joined: true });
  });
  students.forEach(function (st) {
    var sn = seen[st.id];
    st.live = live(st.id);
    st.info = sn ? sn.info : null;
    st.done = s.done[st.id] || 0;
    st.test = s.test[st.id] || null;
    st.zoom = !!s.zoom[st.id];
  });
  // 다음 차례: 끝나지 않았고 진행 중이 아닌 학생 중 접속해 있는 첫 학생(미리 연결 대상)
  var waiting = students.filter(function (st) { return !st.done && !(cur && cur.id === st.id) && !st.zoom; });
  var nx = waiting.filter(function (st) { return st.live; })[0] || null;
  var next = nx ? { id: nx.id, name: nx.name, no: nx.no, time: nx.time, info: nx.info } : null;

  if (role === 'student') {
    var me = null, ahead = 0;
    for (var k = 0; k < waiting.length; k++) { if (waiting[k].id === id) { me = waiting[k]; break; } ahead++; }
    var mine = students.filter(function (st) { return st.id === id; })[0] || {};
    return {
      seq: s.seq,
      me: id,
      called: !!(s.cur && s.cur.id === id),
      cur: (s.cur && s.cur.id === id) ? cur : null,
      busy: !!s.cur,                    // 다른 학생 멘토링 진행 중
      isNext: !!(next && next.id === id),
      ahead: me ? ahead : 0,            // 내 앞에 남은 학생 수(진행 중 제외)
      myNo: mine.no || 0,
      myTime: mine.time || '',
      mentorLive: live('M'),
      host: s.host && live(s.host) ? s.host : null,
      done: !!s.done[id],
      test: s.test[id] || null,
      zoomUrl: s.zoom[id] ? s.zoomUrl : '',
      notice: s.notice && (!s.notice.to || s.notice.to === id) ? s.notice : null
    };
  }

  var base = { seq: s.seq, me: id, cur: cur, next: next, mentorLive: live('M'), mentorInfo: seen.M ? seen.M.info : null, ops: ops, students: students, stage: stage };
  if (role === 'mentor') return base;

  // 운영진·연구원
  base.host = s.host && live(s.host) ? s.host : null;
  base.hostName = base.host && s.parts[base.host] ? s.parts[base.host].name : '';
  base.notice = s.notice;
  base.zoomUrl = s.zoomUrl;
  base.opsList = ops.map(function (i) { return { id: i, name: s.parts[i].name, role: s.parts[i].role, info: seen[i] ? seen[i].info : null }; });
  base.myRole = role;
  base.mentorName = s.parts.M ? s.parts.M.name : '';
  return base;
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
      case 'notice':
        s.notice = req.text ? { text: String(req.text).slice(0, 300), to: req.to || '', at: now } : null;
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
      case 'reset':
        var parts = s.parts;
        s = blankState_();
        s.parts = parts;
        log_(r, '초기화', '', '');
        break;
      default:
        return { ok: false, error: 'bad_cmd' };
    }
    putState_(r, s);
    return { ok: true };
  });
  return result;
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

/* ───────────── 처음 설정 ───────────── */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) {
    var ro = ss.getSheetByName('명단') || ss.insertSheet('명단');
    if (ro.getLastRow() === 0) {
      ro.appendRow(['회차', '순서', '시작', '이름']);
      ro.appendRow(['test', 1, '', '리허설학생']);
      ro.setFrozenRows(1);
    }
    var lg = ss.getSheetByName('기록') || ss.insertSheet('기록');
    if (lg.getLastRow() === 0) { lg.appendRow(['시각', '회차', '구분', '이름', '내용']); lg.setFrozenRows(1); }
  }
  var p = props_();
  if (!p.getProperty('MENTOR_CODE')) p.setProperty('MENTOR_CODE', 'mentor' + Math.floor(1000 + Math.random() * 9000));
  if (!p.getProperty('OPS_CODE')) p.setProperty('OPS_CODE', 'ops' + Math.floor(1000 + Math.random() * 9000));
  if (!p.getProperty('RESEARCH_CODE')) p.setProperty('RESEARCH_CODE', 'research' + Math.floor(1000 + Math.random() * 9000));
  Logger.log('멘토 코드: ' + p.getProperty('MENTOR_CODE'));
  Logger.log('운영진 코드: ' + p.getProperty('OPS_CODE'));
  Logger.log('연구원 코드: ' + p.getProperty('RESEARCH_CODE'));
  Logger.log('TURN 설정: ' + (p.getProperty('CF_TURN_KEY_ID') ? '있음' : '없음(STUN만 사용)'));
  Logger.log('ICE 확인: ' + JSON.stringify(iceServers_()).slice(0, 300));
}

/** 리허설(test) 회차의 진행 상태를 비웁니다. 편집기에서 resetTestRoom 선택 → 실행 */
function resetTestRoom() {
  cache_().remove('st|test');
  Logger.log('test 회차 초기화 완료');
}
