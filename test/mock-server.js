// 로컬 시험용: Code.gs를 그대로 Node에서 돌리는 가짜 Apps Script + 정적 파일 서버
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8080);
const LAT = Number(process.env.LAT || 400); // 평균 지연(ms) — Apps Script 흉내

// ── Apps Script 흉내 ──
const cacheStore = new Map();
const CacheService = { getScriptCache: () => ({
  get: k => { const v = cacheStore.get(k); if (!v) return null; if (v.exp < Date.now()) { cacheStore.delete(k); return null; } return v.v; },
  put: (k, v, ttl) => { cacheStore.set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }); },
  remove: k => cacheStore.delete(k),
  removeAll: ks => ks.forEach(k => cacheStore.delete(k)),
  getAll: keys => { const o = {}; keys.forEach(k => { const v = cacheStore.get(k); if (v && v.exp > Date.now()) o[k] = v.v; }); return o; }
}) };
const props = { MENTOR_CODE: 'm1234', OPS_CODE: 'o1234', RESEARCH_CODE: 'r1234' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) };
const sheets = {};
function mkSheet(name) {
  const rows = [];
  const sh = { name, rows,
    appendRow: r => rows.push(r.map(x => x instanceof Date ? x.toISOString() : x)),
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    setFrozenRows: () => {},
    clearContents: () => { rows.length = 0; },
    getRange: (r, c, nr, nc) => {
      if (typeof r === 'string') return { setNumberFormat() { return this; } };
      nr = nr || 1; nc = nc || 1;
      const read = () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (rows[r - 1 + i] || [])[c - 1 + j] ?? ''));
      return {
        getDisplayValues: () => read().map(row => row.map(v => String(v))),
        getValues: () => read(),
        setValues: vals => vals.forEach((row, i) => { rows[r - 1 + i] = rows[r - 1 + i] || []; row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; }); }),
        setNumberFormat() { return this; }
      };
    }
  };
  return sh;
}
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(n)) };
const SpreadsheetApp = { getActiveSpreadsheet: () => ss };
const ContentService = { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) };
const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
const CODE = process.env.CODE || 'b';   // b: 무용, a: 미술
const fmt = (d, f) => { const k = new Date(d.getTime() + 9 * 3600e3).toISOString(); const m = { yyyy: k.slice(0, 4), yy: k.slice(2, 4), MM: k.slice(5, 7), dd: k.slice(8, 10), HH: k.slice(11, 13), mm: k.slice(14, 16), ss: k.slice(17, 19) }; return f.replace(/yyyy|yy|MM|dd|HH|mm|ss/g, x => m[x]); };
const Utilities = { getUuid: () => crypto.randomUUID(),
  formatDate: (d, tz, f) => fmt(d, f || 'yyyy-MM-dd'),
  base64Decode: s => Array.from(Buffer.from(s, 'base64')),
  base64Encode: b => Buffer.from(b).toString('base64'),
  newBlob: (bytes, type, name) => ({ bytes: Buffer.from(bytes), type, name, getBytes: function () { return Array.from(this.bytes); } }) };
// 드라이브 흉내(작품 사진)
const drive = { folders: [], files: {} };
function mkFolder(name, parent) {
  const f = { name, parent, getName: () => name, getParents: () => ({ next: () => parent, hasNext: () => !!parent }),
    getFoldersByName: n => { const l = drive.folders.filter(x => x.parent === f && x.name === n); return { hasNext: () => l.length > 0, next: () => l.shift() }; },
    createFolder: n => { const x = mkFolder(n, f); drive.folders.push(x); return x; },
    createFile: blob => { const id = 'f' + crypto.randomBytes(8).toString('hex'); const file = { getId: () => id, getName: () => blob.name, getBlob: () => blob, getParents: () => ({ next: () => f }) }; drive.files[id] = file; return file; } };
  return f;
}
const driveRoot = mkFolder('내 드라이브', null);
const DriveApp = { getFoldersByName: n => driveRoot.getFoldersByName(n), createFolder: n => driveRoot.createFolder(n),
  getFileById: id => { if (!drive.files[id]) throw new Error('no file'); return drive.files[id]; } };
const Logger = { log: (...a) => console.log('[gs]', ...a) };
// SFU 요청은 가짜 SFU(test/mock-sfu.js)로 — Apps Script처럼 동기로 기다림
const { execFileSync } = require('child_process');
const SFU_PORT = Number(process.env.SFU_PORT || 8788);
let sfuCalls = 0;
const UrlFetchApp = { fetch: (url, o) => {
  if (!/^https:\/\/rtc\.live\.cloudflare\.com\/v1\/apps\//.test(url)) throw new Error('no network in test');
  sfuCalls++;
  const u = url.replace('https://rtc.live.cloudflare.com', 'http://127.0.0.1:' + SFU_PORT);
  const args = ['-s', '--noproxy', '*', '-m', '25', '-X', String(o.method || 'get').toUpperCase(), '-H', 'Content-Type: application/json', '-w', '\n%{http_code}'];
  Object.entries(o.headers || {}).forEach(([k, v]) => args.push('-H', k + ': ' + v));
  if (o.payload) args.push('--data-binary', '@-');
  args.push(u);
  const outp = execFileSync('curl', args, { input: o.payload || '', encoding: 'utf8' });
  const i = outp.lastIndexOf('\n'), text = outp.slice(0, i), code = Number(outp.slice(i + 1));
  return { getResponseCode: () => code, getContentText: () => text };
} };

const ctx = vm.createContext({ CacheService, PropertiesService, SpreadsheetApp, ContentService, LockService, Utilities, Logger, UrlFetchApp, DriveApp, JSON, Date, Math, String, Number, Array, Object, Error, encodeURIComponent });
vm.runInContext(fs.readFileSync(path.join(ROOT, CODE + '/apps-script/Code.gs'), 'utf8'), ctx);
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const hm = m => { const d = new Date(Date.now() + 9 * 3600e3 + m * 60000); return d.toISOString().slice(11, 16); };
if (CODE === 'a') {
  // 예전(Ver.1.0) 6칸 회차 탭 → setup이 4칸으로 바꾸는지
  sheets['회차'] = mkSheet('회차');
  sheets['회차'].appendRow(['회차', '날짜', '전체1 시작', '분반 시작', '전체2 시작', '마침']);
  sheets['회차'].appendRow(['2', '2026-11-21', '10:00', '11:00', '', '12:00']);
  ctx.setup();
  console.log('[migrate] 회차:', JSON.stringify(sheets['회차'].rows));
  props.CF_SFU_APP_ID = 'testapp'; props.CF_SFU_APP_TOKEN = 'testtoken';   // setup의 SFU 시험 연결은 건너뜀
  const ro = sheets['명단'];
  ro.rows.length = 1;
  [['test', '학생가', '20140101', 'A', '010-1111-2222', '010-3333-4444'], ['test', '학생나', '20150202', 'A', '', ''], ['test', '학생다', '20160303', 'B', '010-5555-6666', ''], ['test', '학생라', '20160404', 'B', '', ''], ['test', '학생마', '', 'B', '', '']].forEach(r => ro.appendRow(r));
  sheets['멘토'].rows.length = 1;
  [['test', '멘토일', 'A'], ['test', '멘토이', 'B'], ['test', '멘토삼', 'C'], ['test', '멘토사', 'D']].forEach(r => sheets['멘토'].appendRow(r));
  sheets['회차'].rows.length = 1;
  sheets['회차'].appendRow(['test', today, hm(-5), hm(70)]);
  sheets['회차'].appendRow(['2', '2026-11-21', '10:00', '12:00']);
  ctx.cache_().remove('data');
} else {
// 예전 4칸 명단에서 옮겨 담기까지 시험
sheets['명단'] = mkSheet('명단');
sheets['명단'].appendRow(['회차', '순서', '시작', '이름']);
sheets['명단'].appendRow(['test', 1, '', '리허설학생']);
ctx.setup();
const ro = sheets['명단'];
ro.appendRow(['test', 2, '학생가', '20140101', hm(-12), hm(-2) + ' – ' + hm(8), '010-1111-2222', '010-3333-4444']);
ro.appendRow(['test', 3, '학생나', '20150202', hm(-2), hm(8) + ' – ' + hm(18), '010-5555-6666', '']);
ro.appendRow(['test', 4, '학생다', '20160303', hm(8), hm(18) + ' – ' + hm(28), '', '010-7777-8888']);
ro.appendRow(['3', 1, '홍길동', '20140505', '17:20', '17:30 – 17:40', '', '']);
sheets['회차'].rows.forEach(r => { if (r[0] === 'test') { r[1] = today; r[3] = 2; } });
ctx.cache_().removeAll(['ro|all', 'se|all']);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
let calls = 0;
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      calls++;
      const out = ctx.doPost({ postData: { contents: body } });
      const delay = LAT * (0.5 + Math.random());
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(out.s); }, delay);
    });
    return;
  }
  if (url.pathname === '/__stats') { res.end(JSON.stringify({ calls, log: (sheets['기록'] || { rows: [] }).rows, chat: (sheets['채팅'] || { rows: [] }).rows, roster: sheets['명단'].rows, memo: (sheets['관찰 메모'] || { rows: [] }).rows, sfuCalls, photos: Object.keys(drive.files).length })); return; }
  let p = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  let data = fs.readFileSync(f);
  if (p.endsWith('/config.js')) data = Buffer.from(String(data).replace(/API: '[^']*'/, `API: 'http://localhost:${PORT}/api'`));
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(data);
}).listen(PORT, () => console.log('mock on', PORT));
