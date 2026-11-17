/**
 * K예술영재 미술 온라인 멘토링 — 관문(Apps Script)  Ver.1.3
 *
 * 하는 일
 *  - 입장(학생: 이름+생년월일, 멘토·운영진·연구원: 코드+이름), 회차는 날짜로 자동
 *  - 진행 단계(시작 전 → 전체 ⇄ 분반(여러 번 가능) → 마침)와 조 배정·공지·손들기·크게 보기 보관
 *  - Cloudflare Realtime SFU(영상 중계) 연결 요청을 앱 비밀키로 대신 보냄(비밀키는 브라우저에 가지 않음)
 *  - 작품 사진: 드라이브에 저장하고, 로그인한 사람에게만 보내 줌(공개 링크 없음)
 *  - 시트 「명단」「멘토」「회차」 읽기, 「기록」「관찰 메모」 남기기
 *
 * 스크립트 속성 [프로젝트 설정 > 스크립트 속성]
 *  MENTOR_CODE        멘토 접속 코드
 *  OPS_CODE           운영진 접속 코드
 *  RESEARCH_CODE      연구원 접속 코드
 *  CF_SFU_APP_ID      Cloudflare Realtime SFU App ID
 *  CF_SFU_APP_TOKEN   Cloudflare Realtime SFU API Token
 *  CF_TURN_KEY_ID     (선택) Cloudflare TURN 키 ID — 무용과 같은 값
 *  CF_TURN_API_TOKEN  (선택) Cloudflare TURN API 토큰 — 무용과 같은 값
 *
 * 처음 한 번 / 코드를 바꾼 뒤: 편집기 상단에서 setup 선택 → 실행(시트 탭·머리글을 맞춤, 드라이브 권한 허용)
 * 배포: 배포 > 새 배포 > 웹 앱 / 실행: 나 / 액세스: 모든 사용자
 * 수정 후: 배포 > 배포 관리 > 연필 > 버전 '새 버전' > 배포 (새 배포 금지: 주소가 바뀜)
 */

var TTL = 21600;
var SEEN_LIVE_MS = 12000;
var TZ = 'Asia/Seoul';
var SFU_BASE = 'https://rtc.live.cloudflare.com/v1/apps/';
var PHOTO_DIR = 'K예술영재_미술멘토링_작품사진';
var PHASES = ['ready', 'all', 'group', 'end'];

var ROSTER_HEAD = ['회차', '이름', '생년월일', '조', '학생 연락처', '보호자 연락처'];
var MENTOR_HEAD = ['회차', '멘토', '조'];
var SESS_HEAD = ['회차', '날짜', '시작', '마침'];
var SESS_HEAD_OLD = ['회차', '날짜', '전체1 시작', '분반 시작', '전체2 시작', '마침'];

/* ───────────── 진입점 ───────────── */
function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents || '{}'); }
  catch (err) { return out_({ ok: false, error: 'bad_json' }); }
  return out_(handle_(req));
}
function doGet() { return out_({ ok: true, service: 'karts-art', ver: 1, now: Date.now() }); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function handle_(req) {
  try {
    var r = String(req.r || '');
    if (req.a === 'join' && (!r || r === 'auto')) r = 'auto';
    else if (!/^[\w-]{1,20}$/.test(r)) return { ok: false, error: 'bad_room' };
    switch (req.a) {
      case 'join':  return join_(r, req);
      case 'poll':  return poll_(r, req);
      case 'op':    return op_(r, req);
      case 'sfu':   return sfu_(r, req);
      case 'photo': return photo_(r, req);
      case 'img':   return img_(r, req);
      default: return { ok: false, error: 'bad_action' };
    }
  } catch (err) {
    var msg = String(err && err.message || err);
    if (msg === 'auth' || msg === 'forbidden') return { ok: false, error: msg };
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
  return { parts: {}, n: 0, phase: 'ready', phaseAt: Date.now(), pend: null, assign: {}, mgroup: {}, spot: {}, hands: {}, notice: null, recorder: null, rounds: { all: 0, group: 0 }, seq: 0 };
}
function getState_(r) {
  var s = cget_('st|' + r) || blankState_();
  if (s.phase === 'all1' || s.phase === 'all2') s.phase = 'all';   // 예전(Ver.1.0) 단계 이름
  s.rounds = s.rounds || { all: 0, group: 0 };
  return s;
}
function putState_(r, s) { s.seq = (s.seq || 0) + 1; cput_('st|' + r, s); }
function withLock_(fn) { var l = LockService.getScriptLock(); l.waitLock(15000); try { return fn(); } finally { l.releaseLock(); } }
function token_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
function auth_(r, req) {
  var id = String(req.id || ''), tok = cache_().get('tk|' + r + '|' + id);
  if (!id || !tok || tok !== String(req.tok || '')) throw new Error('auth');
  return id;
}
function isStaff_(role) { return role === 'ops' || role === 'research'; }

/* ───────────── 시트 ───────────── */
function normName_(s) { return String(s || '').replace(/\s+/g, '').replace(/^(미술)_/, ''); }
function digits_(s) { return String(s || '').replace(/\D/g, ''); }
function roomOf_(v) { return String(v || '').replace(/회차/, '').trim(); }
function hm_(s) { var m = String(s || '').match(/(\d{1,2}):(\d{2})/); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : ''; }
// 조: 'A' 'A조' 'a' → 1, 'B' → 2 … 또는 숫자 '1' '1조' → 1
function grp_(v) {
  var t = String(v || '').trim().toUpperCase(), m = t.match(/^([A-I])/);
  if (m) return m[1].charCodeAt(0) - 64;
  var n = Number(t.replace(/\D/g, '')); return n > 0 && n < 10 ? n : 0;
}
function ss_() { try { return SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return null; } }
function sheetRows_(name, withHead) {
  var ss = ss_(), sh = ss && ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return withHead ? { head: [], rows: [] } : [];
  var all = sh.getRange(1, 1, sh.getLastRow(), Math.max(1, sh.getLastColumn())).getDisplayValues();
  return withHead ? { head: all[0], rows: all.slice(1) } : all.slice(1);
}
// 명단·멘토·회차를 한 번에 읽어 1분 보관
function data_() {
  var hit = cget_('data');
  if (hit) return hit;
  var d = { roster: {}, mentors: {}, sess: {} };
  sheetRows_('명단').forEach(function (v) {
    var r = roomOf_(v[0]), nm = normName_(v[1]);
    if (!r || !nm) return;
    (d.roster[r] = d.roster[r] || []).push({ name: nm, birth: digits_(v[2]), g: grp_(v[3]), sPhone: String(v[4] || '').trim(), pPhone: String(v[5] || '').trim() });
  });
  sheetRows_('멘토').forEach(function (v) {
    var r = roomOf_(v[0]), nm = normName_(v[1]);
    if (!r || !nm) return;
    (d.mentors[r] = d.mentors[r] || []).push({ name: nm, g: grp_(v[2]) });
  });
  // 회차: 머리글로 열 찾기 — 「시작」(또는 예전 「전체1 시작」)과 「마침」만 씀
  var se = sheetRows_('회차', true), H = se.head.map(function (h) { return String(h).replace(/\s/g, ''); });
  var cStart = H.indexOf('시작') >= 0 ? H.indexOf('시작') : H.indexOf('전체1시작') >= 0 ? H.indexOf('전체1시작') : 2;
  var cEnd = H.indexOf('마침') >= 0 ? H.indexOf('마침') : 3;
  se.rows.forEach(function (v) {
    var r = roomOf_(v[0]);
    if (!r) return;
    d.sess[r] = { r: r, date: String(v[1] || '').trim().replace(/\./g, '-'), start: hm_(v[cStart]), end: hm_(v[cEnd]) };
  });
  cache_().put('data', JSON.stringify(d), 60);
  return d;
}
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function autoRoom_() {
  var se = data_().sess, td = today_();
  var list = Object.keys(se).filter(function (k) { return k !== 'test' && se[k].date; }).map(function (k) { return se[k]; });
  var t = list.filter(function (x) { return x.date === td; })[0]; if (t) return t.r;
  var up = list.filter(function (x) { return x.date > td; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; })[0]; if (up) return up.r;
  var past = list.sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
  return past ? past.r : '';
}
function log_(r, kind, name, text) {
  try {
    var ss = ss_(); if (!ss) return;
    var sh = ss.getSheetByName('기록') || ss.insertSheet('기록');
    if (sh.getLastRow() === 0) sh.appendRow(['시각', '회차', '구분', '이름', '내용']);
    sh.appendRow([new Date(), r, kind, name || '', text || '']);
  } catch (e) {}
}

/* ───────────── 입장 ───────────── */
function join_(r, req) {
  var role = String(req.role || ''), name = normName_(String(req.name || '').slice(0, 30)), p = props_();
  if (r === 'auto') { r = autoRoom_(); if (!r) return { ok: false, error: 'no_session' }; }
  var me = null, id;
  if (role === 'student') {
    if (!name) return { ok: false, error: 'name' };
    var ro = data_().roster[r] || [];
    var x = ro.filter(function (y) { return y.name === name; })[0];
    if (!x && ro.length) return { ok: false, error: 'not_in_roster' };
    if (x && x.birth) { var b = digits_(req.birth); if (!(b === x.birth || (b.length === 6 && x.birth.slice(-6) === b))) return { ok: false, error: 'birth' }; }
    id = 'S_' + name;
    me = { g: x ? x.g : 0, test: !ro.length };
  } else if (role === 'mentor' || role === 'ops' || role === 'research') {
    var key = role === 'mentor' ? 'MENTOR_CODE' : role === 'ops' ? 'OPS_CODE' : 'RESEARCH_CODE';
    if (String(req.code || '') !== String(p.getProperty(key) || '__none__')) return { ok: false, error: 'code' };
    if (!name) return { ok: false, error: 'name' };
    id = (role === 'mentor' ? 'M_' : role === 'ops' ? 'O_' : 'R_') + name.slice(0, 12);
  } else return { ok: false, error: 'bad_role' };

  var tok = token_(), pid = '';
  withLock_(function () {
    var s = getState_(r);
    var old = s.parts[id];
    pid = old ? old.pid : 'p' + (++s.n);
    s.parts[id] = { role: role, name: name, pid: pid, sfu: old ? old.sfu : '', tr: old ? old.tr : {}, visit: old ? old.visit : undefined, joinedAt: old ? old.joinedAt : Date.now() };
    putState_(r, s);
    cache_().put('tk|' + r + '|' + id, tok, TTL);
  });
  cput_('sn|' + r + '|' + id, { t: Date.now(), info: {} });
  log_(r, '입장', name, role);
  return { ok: true, id: id, tok: tok, pid: pid, name: name, role: role, r: r, me: me, ice: iceServers_(), now: Date.now() };
}

/* ───────────── 상태 보기 ───────────── */
function seenMap_(r, s) {
  var ids = Object.keys(s.parts), keys = ids.map(function (i) { return 'sn|' + r + '|' + i; });
  var got = keys.length ? cache_().getAll(keys) : {}, out = {};
  ids.forEach(function (i, k) { out[i] = got[keys[k]] ? JSON.parse(got[keys[k]]) : null; });
  return out;
}
// 예약된 단계 전환이 때가 되면 적용
function applyPending_(r) {
  var s = getState_(r);
  if (!s.pend || Date.now() < s.pend.at) return s;
  return withLock_(function () {
    var s2 = getState_(r);
    if (s2.pend && Date.now() >= s2.pend.at) { setPhase_(r, s2, s2.pend.to, s2.pend.by); putState_(r, s2); }
    return s2;
  });
}
function setPhase_(r, s, to, by) {
  s.phase = to; s.phaseAt = Date.now(); s.pend = null; s.spot = {}; s.hands = {};
  if (to !== 'end') s.closed = 0;   // 다시 시작하면 「모두 퇴장」 풀림
  if (to === 'all' || to === 'group') s.rounds[to] = (s.rounds[to] || 0) + 1;   // 전체 n번째·분반 n번째(녹화 파일 이름)
  log_(r, '단계', by || '', { ready: '시작 전', all: '전체', group: '분반', end: '마침' }[to] + (s.rounds[to] ? ' ' + s.rounds[to] : ''));
}
// 누가 어느 방에 있는지: 'all' 또는 'g1'..'g9'
function roomFor_(r, s, id) {
  var p = s.parts[id]; if (!p) return 'all';
  if (s.phase !== 'group') return 'all';
  if (p.role === 'student') { var g = s.assign[id] || defaultGroup_(r, p.name); return g ? 'g' + g : 'all'; }
  if (p.role === 'mentor') { var mg = s.mgroup[id] || mentorGroup_(r, p.name); return mg ? 'g' + mg : 'all'; }
  return p.visit || 'all';
}
function defaultGroup_(r, name) { var x = (data_().roster[r] || []).filter(function (y) { return y.name === name; })[0]; return x ? x.g : 0; }
function mentorGroup_(r, name) { var x = (data_().mentors[r] || []).filter(function (y) { return y.name === name; })[0]; return x ? x.g : 0; }

function view_(r, s, id, now) {
  var seen = seenMap_(r, s), me = s.parts[id] || {}, staff = isStaff_(me.role), d = data_();
  var live = function (i) { return !!(seen[i] && now - seen[i].t < SEEN_LIVE_MS); };
  var people = Object.keys(s.parts).map(function (i) {
    var p = s.parts[i];
    var o = { id: i, pid: p.pid, role: p.role, name: p.name, live: live(i), room: roomFor_(r, s, i), sfu: p.sfu, tr: p.tr,
              hand: s.hands[i] || 0, photo: p.photo || null, scrAt: p.scrAt || 0, muteAt: p.muteAt || 0, talk: !!(seen[i] && seen[i].info && seen[i].info.talk) };
    if (staff && seen[i]) o.info = seen[i].info;
    return o;
  });
  // 명단의 학생·멘토(화면 자리 고정: 들어오지 않은 사람은 빈 칸에 이름) — 연락처는 운영진·연구원만
  var roster = (d.roster[r] || []).map(function (x) {
    var sid = 'S_' + x.name, o = { id: sid, name: x.name, g: s.assign[sid] || x.g, g0: x.g, joined: !!s.parts[sid], live: live(sid) };
    if (staff) { o.sPhone = x.sPhone; o.pPhone = x.pPhone; }
    return o;
  });
  var mroster = (d.mentors[r] || []).map(function (m) {
    var mid = 'M_' + m.name.slice(0, 12);
    return { id: mid, name: m.name, g: s.mgroup[mid] || m.g, live: live(mid) };
  });
  var groups = {};
  (d.mentors[r] || []).forEach(function (m) { if (m.g) groups[m.g] = groups[m.g] || []; });
  (d.roster[r] || []).forEach(function (x) { if (x.g) groups[x.g] = groups[x.g] || []; });
  Object.keys(s.assign).forEach(function (k) { if (s.assign[k]) groups[s.assign[k]] = groups[s.assign[k]] || []; });
  Object.keys(s.mgroup).forEach(function (k) { if (s.mgroup[k]) groups[s.mgroup[k]] = groups[s.mgroup[k]] || []; });
  var mentorsOf = {};
  people.forEach(function (p) { if (p.role === 'mentor') { var g = s.mgroup[p.id] || mentorGroup_(r, p.name); if (g) (mentorsOf[g] = mentorsOf[g] || []).push(p.name); } });
  (d.mentors[r] || []).forEach(function (m) { if (m.g && !(mentorsOf[m.g] || []).length) mentorsOf[m.g] = [m.name]; });
  var v = {
    seq: s.seq, me: id, myRoom: roomFor_(r, s, id), myGroup: me.role === 'student' ? (s.assign[id] || defaultGroup_(r, me.name)) : me.role === 'mentor' ? (s.mgroup[id] || mentorGroup_(r, me.name)) : 0, phase: s.phase, phaseAt: s.phaseAt, pend: s.pend, round: s.rounds[s.phase] || 0,
    sess: d.sess[r] || { r: r }, people: people, spot: s.spot, notice: s.notice,
    groups: Object.keys(groups).map(Number).sort(), mentorsOf: mentorsOf,
    recorder: s.recorder && live(s.recorder) ? s.recorder : null,
    closed: s.closed || 0
  };
  v.roster = roster; v.mroster = mroster;
  return v;
}

function poll_(r, req) {
  var id = auth_(r, req), now = Date.now();
  cput_('sn|' + r + '|' + id, { t: now, info: req.info || {} });
  var s = applyPending_(r);
  if (!s.parts[id]) throw new Error('auth');
  return { ok: true, now: now, msgs: [], view: view_(r, s, id, now) };
}

/* ───────────── 진행 명령 ───────────── */
function op_(r, req) {
  var id = auth_(r, req), cmd = String(req.cmd || ''), who = '';
  var res = withLock_(function () {
    var s = getState_(r), me = s.parts[id];
    if (!me) throw new Error('auth');
    who = me.name;
    var role = me.role, staff = isStaff_(role), ops = role === 'ops', now = Date.now();
    var need = function (ok) { if (!ok) throw new Error('forbidden'); };
    switch (cmd) {
      case 'pub':   // 내가 올린 영상·소리 이름 등록(SFU 세션)
        me.sfu = String(req.sfu || '').slice(0, 64);
        var oldScr = me.tr && me.tr.scr;
        me.tr = {};
        ['cam', 'mic', 'scr'].forEach(function (k) { if (req.tr && req.tr[k]) me.tr[k] = String(req.tr[k]).slice(0, 64); });
        if (me.tr.scr && me.tr.scr !== oldScr) me.scrAt = now;   // 화면 공유 시작 시각(가장 최근 것을 크게)
        break;
      case 'phase':   // 단계 바꾸기(바로 또는 n초 뒤)
        need(ops);
        var to = String(req.to || '');
        if (to === 'all1' || to === 'all2') to = 'all';
        if (PHASES.indexOf(to) < 0) return { ok: false, error: 'bad_phase' };
        if (to === s.phase) return { ok: true, same: true };
        var delay = Math.max(0, Math.min(600, Number(req.delay) || 0)) * 1000;
        if (delay) s.pend = { to: to, at: now + delay, by: who }; else setPhase_(r, s, to, who);
        break;
      case 'unpend': need(ops); s.pend = null; break;
      case 'assign':   // 학생 조 옮기기
        need(ops);
        var g = grp_(req.g); s.assign[String(req.sid)] = g;
        log_(r, '조 이동', String(req.sid).replace(/^S_/, ''), g ? g + '조' : '전체');
        break;
      case 'mgroup': need(ops); s.mgroup[String(req.mid)] = grp_(req.g); break;
      case 'notice':
        need(staff || role === 'mentor');
        var text = String(req.text || '').trim().slice(0, 200);
        s.notice = text ? { text: text, to: String(req.to || 'all'), at: now, by: who } : null;
        if (text) log_(r, '공지', who, text);
        break;
      case 'spot':   // 크게 보기(방별): 멘토는 자기 방만
        need(role === 'mentor' || ops);
        var room = role === 'mentor' ? roomFor_(r, s, id) : String(req.room || 'all');
        if (req.target) s.spot[room] = { id: String(req.target), kind: String(req.kind || 'cam'), at: now }; else delete s.spot[room];
        break;
      case 'hand':
        if (req.on) s.hands[id] = now; else delete s.hands[req.sid && (role === 'mentor' || staff) ? String(req.sid) : id];
        break;
      case 'mute':   // 학생 마이크 끄기 요청
        need(role === 'mentor' || ops);
        var t = s.parts[String(req.sid)]; if (t) t.muteAt = now;
        break;
      case 'visit':  // 운영진·연구원: 어느 방을 보고 말할지
        need(staff);
        me.visit = /^(all|g\d)$/.test(String(req.room)) ? String(req.room) : 'all';
        break;
      case 'recorder': need(ops); s.recorder = req.on ? id : (s.recorder === id ? null : s.recorder); break;
      case 'unphoto':
        var tgt = req.sid && (role === 'mentor' || staff) ? String(req.sid) : id;
        if (s.parts[tgt]) delete s.parts[tgt].photo;
        break;
      case 'memo':
        need(staff);
        memo_(r, who, String(req.where || ''), String(req.text || '').slice(0, 500));
        return { ok: true };
      case 'closeall':   // 멘토링을 마치고 학생·멘토 모두 퇴장시키기
        need(ops);
        if (s.phase !== 'end') setPhase_(r, s, 'end', who);
        s.closed = now; s.notice = null;
        log_(r, '모두 퇴장', who, '');
        break;
      case 'reset': need(ops); var parts = s.parts, n = s.n; s = blankState_(); s.parts = parts; s.n = n; log_(r, '초기화', who, ''); break;
      default: return { ok: false, error: 'bad_cmd' };
    }
    putState_(r, s);
    return { ok: true };
  });
  return res;
}
function memo_(r, who, where, text) {
  if (!text) return;
  var ss = ss_(); if (!ss) return;
  var sh = ss.getSheetByName('관찰 메모') || ss.insertSheet('관찰 메모');
  if (sh.getLastRow() === 0) sh.appendRow(['시각', '회차', '단계·조', '연구원', '메모']);
  sh.appendRow([new Date(), r, where, who, text]);
}

/* ───────────── Cloudflare Realtime SFU 대행 ─────────────
 * 브라우저는 영상 연결 정보(SDP)만 보내고, 앱 비밀키는 여기서만 씀.
 *  op: new | push | pull | reneg | close
 */
function sfu_(r, req) {
  var id = auth_(r, req), p = props_();
  var app = p.getProperty('CF_SFU_APP_ID'), key = p.getProperty('CF_SFU_APP_TOKEN');
  if (!app || !key) return { ok: false, error: 'sfu_not_set' };
  var s = getState_(r), me = s.parts[id];
  if (!me) throw new Error('auth');
  var op = String(req.op || ''), sid = String(req.sid || '');
  if (op !== 'new' && !/^[\w-]{8,64}$/.test(sid)) return { ok: false, error: 'bad_sid' };
  var path, method = 'post', body = null;
  switch (op) {
    case 'new': path = '/sessions/new'; break;
    case 'push':   // 내 영상·소리 올리기
      path = '/sessions/' + sid + '/tracks/new';
      body = { sessionDescription: { type: 'offer', sdp: String(req.sdp || '') },
               tracks: (req.tracks || []).slice(0, 6).map(function (t) { return { location: 'local', mid: String(t.mid), trackName: String(t.trackName) }; }) };
      break;
    case 'pull':   // 다른 사람 영상·소리 받기
      path = '/sessions/' + sid + '/tracks/new';
      body = { tracks: (req.tracks || []).slice(0, 40).map(function (t) {
        var o = { location: 'remote', sessionId: String(t.sessionId), trackName: String(t.trackName) };
        // 화질층이 없거나 망이 부족하면 다음 화질로 자동 전환(영상 멈춤 방지)
        if (t.rid) o.simulcast = { preferredRid: String(t.rid), priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' };
        return o;
      }) };
      break;
    case 'update':   // 받는 영상의 화질만 바꾸기(다시 받지 않음)
      path = '/sessions/' + sid + '/tracks/update'; method = 'put';
      body = { tracks: (req.tracks || []).slice(0, 40).map(function (t) {
        return { location: 'remote', sessionId: String(t.sessionId), trackName: String(t.trackName), mid: String(t.mid),
                 simulcast: { preferredRid: String(t.rid), priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } };
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

/* ───────────── 작품 사진(드라이브 보관, 공개 링크 없음) ───────────── */
function photoFolder_(r) {
  var it = DriveApp.getFoldersByName(PHOTO_DIR), root = it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_DIR);
  var name = r === 'test' ? '리허설' : r + '회차', it2 = root.getFoldersByName(name);
  return it2.hasNext() ? it2.next() : root.createFolder(name);
}
function photo_(r, req) {
  var id = auth_(r, req);
  var data = String(req.data || '').replace(/^data:image\/\w+;base64,/, '');
  if (!data || data.length > 8000000) return { ok: false, error: 'size' };
  var s0 = getState_(r), me0 = s0.parts[id];
  if (!me0) throw new Error('auth');
  var stamp = Utilities.formatDate(new Date(), TZ, 'yyMMdd_HHmmss');
  var blob = Utilities.newBlob(Utilities.base64Decode(data), 'image/jpeg', stamp + '_' + me0.name + '.jpg');
  var file = photoFolder_(r).createFile(blob);
  withLock_(function () {
    var s = getState_(r), me = s.parts[id];
    if (me) { me.photo = { f: file.getId(), at: Date.now() }; putState_(r, s); }
  });
  log_(r, '작품 사진', me0.name, file.getName());
  return { ok: true, f: file.getId() };
}
function img_(r, req) {
  auth_(r, req);
  var f = String(req.f || '');
  if (!/^[\w-]{10,100}$/.test(f)) return { ok: false, error: 'bad_file' };
  var hit = cache_().get('img|' + f);
  if (hit) return { ok: true, data: hit };
  var file = DriveApp.getFileById(f);
  if (file.getParents().next().getParents().next().getName() !== PHOTO_DIR) return { ok: false, error: 'forbidden' };
  var b64 = Utilities.base64Encode(file.getBlob().getBytes());
  if (b64.length < 95000) cache_().put('img|' + f, b64, 3600);
  return { ok: true, data: b64 };
}

/* ───────────── ICE(STUN/TURN) ───────────── */
function iceServers_() {
  var base = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
  var p = props_(), keyId = p.getProperty('CF_TURN_KEY_ID'), apiTok = p.getProperty('CF_TURN_API_TOKEN');
  if (!keyId || !apiTok) return base;
  var hit = cget_('ice|cf'); if (hit) return hit;
  try {
    var res = UrlFetchApp.fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + apiTok },
      payload: JSON.stringify({ ttl: 43200 }), muteHttpExceptions: true });
    if (res.getResponseCode() >= 300) return base;
    var list = JSON.parse(res.getContentText()).iceServers;
    if (!Array.isArray(list)) list = list ? [list] : [];
    list = list.map(function (x) {
      var urls = [].concat(x.urls || []).filter(function (u) { return !/:53(\?|$)/.test(u); });
      var o = { urls: urls }; if (x.username) { o.username = x.username; o.credential = x.credential; } return o;
    }).filter(function (x) { return x.urls.length; });
    var all = base.concat(list);
    cache_().put('ice|cf', JSON.stringify(all), TTL);
    return all;
  } catch (e) { return base; }
}

/* ───────────── 처음 설정 ───────────── */
function setup() {
  var ss = ss_();
  if (ss) {
    var mk = function (name, head, rows) {
      var sh = ss.getSheetByName(name) || ss.insertSheet(name);
      if (sh.getLastRow() === 0) { sh.appendRow(head); (rows || []).forEach(function (x) { sh.appendRow(x); }); sh.setFrozenRows(1); }
      return sh;
    };
    var ro = mk('명단', ROSTER_HEAD, [['test', '리허설학생1', '', 'A', '', ''], ['test', '리허설학생2', '', 'B', '', '']]);
    ro.getRange('C:C').setNumberFormat('@'); ro.getRange('E:F').setNumberFormat('@');
    mk('멘토', MENTOR_HEAD, [['test', '리허설멘토1', 'A'], ['test', '리허설멘토2', 'B']]);
    var se = mk('회차', SESS_HEAD, [['test', '', '', '']]);
    // 예전(Ver.1.0) 6칸 머리글이면 4칸(회차·날짜·시작·마침)으로 바꿈 — 시작은 「전체1 시작」, 마침은 그대로 옮김
    var h0 = se.getRange(1, 1, 1, 6).getDisplayValues()[0].join('|');
    if (h0 === SESS_HEAD_OLD.join('|')) {
      var n0 = se.getLastRow();
      if (n0 > 1) {
        var old = se.getRange(2, 1, n0 - 1, 6).getDisplayValues();
        se.getRange(2, 1, n0 - 1, 6).setValues(old.map(function (x) { return [x[0], x[1], x[2], x[5], '', '']; }));
      }
      se.getRange(1, 1, 1, 6).setValues([SESS_HEAD.concat(['', ''])]);
      Logger.log('회차 탭을 새 형식(회차·날짜·시작·마침)으로 바꿨습니다');
    }
    se.getRange('B:D').setNumberFormat('@');
    mk('기록', ['시각', '회차', '구분', '이름', '내용']);
    mk('관찰 메모', ['시각', '회차', '단계·조', '연구원', '메모']);
  }
  photoFolder_('test');   // 드라이브 권한 확인 겸 사진 폴더 만들기
  var p = props_();
  if (!p.getProperty('MENTOR_CODE')) p.setProperty('MENTOR_CODE', 'mentor' + Math.floor(1000 + Math.random() * 9000));
  if (!p.getProperty('OPS_CODE')) p.setProperty('OPS_CODE', 'ops' + Math.floor(1000 + Math.random() * 9000));
  if (!p.getProperty('RESEARCH_CODE')) p.setProperty('RESEARCH_CODE', 'research' + Math.floor(1000 + Math.random() * 9000));
  cache_().remove('data');
  Logger.log('멘토 코드: ' + p.getProperty('MENTOR_CODE'));
  Logger.log('운영진 코드: ' + p.getProperty('OPS_CODE'));
  Logger.log('연구원 코드: ' + p.getProperty('RESEARCH_CODE'));
  Logger.log('SFU 설정: ' + (p.getProperty('CF_SFU_APP_ID') && p.getProperty('CF_SFU_APP_TOKEN') ? '있음' : '없음 — CF_SFU_APP_ID·CF_SFU_APP_TOKEN을 넣어 주세요'));
  if (p.getProperty('CF_SFU_APP_ID') && p.getProperty('CF_SFU_APP_TOKEN')) {
    var t = UrlFetchApp.fetch(SFU_BASE + encodeURIComponent(p.getProperty('CF_SFU_APP_ID')) + '/sessions/new', {
      method: 'post', headers: { Authorization: 'Bearer ' + p.getProperty('CF_SFU_APP_TOKEN') }, muteHttpExceptions: true });
    Logger.log('SFU 연결 시험: ' + (t.getResponseCode() < 300 ? '성공' : '실패 HTTP ' + t.getResponseCode() + ' ' + t.getContentText().slice(0, 200)));
  }
  Logger.log('TURN 설정: ' + (p.getProperty('CF_TURN_KEY_ID') ? '있음' : '없음(STUN만)'));
  var d = data_();
  Logger.log('명단: ' + Object.keys(d.roster).map(function (k) { return k + '회차 ' + d.roster[k].length + '명'; }).join(', '));
}
function resetTestRoom() { cache_().removeAll(['st|test', 'data']); Logger.log('test 회차 초기화 완료'); }
