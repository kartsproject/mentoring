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
const Utilities = { getUuid: () => crypto.randomUUID(),
  formatDate: (d, tz, f) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10) };
const Logger = { log: (...a) => console.log('[gs]', ...a) };
const UrlFetchApp = { fetch: () => { throw new Error('no network in test'); } };

const ctx = vm.createContext({ CacheService, PropertiesService, SpreadsheetApp, ContentService, LockService, Utilities, Logger, UrlFetchApp, JSON, Date, Math, String, Number, Array, Object, Error, encodeURIComponent });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'b/apps-script/Code.gs'), 'utf8'), ctx);
// 예전 4칸 명단에서 옮겨 담기까지 시험
sheets['명단'] = mkSheet('명단');
sheets['명단'].appendRow(['회차', '순서', '시작', '이름']);
sheets['명단'].appendRow(['test', 1, '', '리허설학생']);
ctx.setup();
const ro = sheets['명단'];
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const hm = m => { const d = new Date(Date.now() + 9 * 3600e3 + m * 60000); return d.toISOString().slice(11, 16); };
ro.appendRow(['test', 2, '학생가', '20140101', hm(-12), hm(-2) + ' – ' + hm(8), '010-1111-2222', '010-3333-4444']);
ro.appendRow(['test', 3, '학생나', '20150202', hm(-2), hm(8) + ' – ' + hm(18), '010-5555-6666', '']);
ro.appendRow(['test', 4, '학생다', '20160303', hm(8), hm(18) + ' – ' + hm(28), '', '010-7777-8888']);
ro.appendRow(['3', 1, '홍길동', '20140505', '17:20', '17:30 – 17:40', '', '']);
sheets['회차'].rows.forEach(r => { if (r[0] === 'test') { r[1] = today; r[3] = 2; } });
ctx.cache_().removeAll(['ro|all', 'se|all']);

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
  if (url.pathname === '/__stats') { res.end(JSON.stringify({ calls, log: (sheets['기록'] || { rows: [] }).rows, chat: (sheets['채팅'] || { rows: [] }).rows, roster: sheets['명단'].rows })); return; }
  let p = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  let data = fs.readFileSync(f);
  if (p.endsWith('/config.js')) data = Buffer.from(String(data).replace(/API: '[^']*'/, `API: 'http://localhost:${PORT}/api'`));
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(data);
}).listen(PORT, () => console.log('mock on', PORT));
