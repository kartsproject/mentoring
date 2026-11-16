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
  getAll: keys => { const o = {}; keys.forEach(k => { const v = cacheStore.get(k); if (v && v.exp > Date.now()) o[k] = v.v; }); return o; }
}) };
const props = { MENTOR_CODE: 'm1234', OPS_CODE: 'o1234' };
const PropertiesService = { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) };
const sheets = {};
function mkSheet(name) {
  const rows = [];
  return { name, rows,
    appendRow: r => rows.push(r.map(x => x instanceof Date ? x.toISOString() : x)),
    getLastRow: () => rows.length,
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({ getDisplayValues: () => rows.slice(r - 1, r - 1 + nr).map(row => Array.from({ length: nc }, (_, i) => String(row[c - 1 + i] ?? ''))) })
  };
}
const ss = { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mkSheet(n)) };
const SpreadsheetApp = { getActiveSpreadsheet: () => ss };
const ContentService = { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) };
const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
const Utilities = { getUuid: () => crypto.randomUUID() };
const Logger = { log: (...a) => console.log('[gs]', ...a) };
const UrlFetchApp = { fetch: () => { throw new Error('no network in test'); } };

const ctx = vm.createContext({ CacheService, PropertiesService, SpreadsheetApp, ContentService, LockService, Utilities, Logger, UrlFetchApp, JSON, Date, Math, String, Number, Array, Object, Error, encodeURIComponent });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8'), ctx);
ctx.setup();
const ro = sheets['명단'];
ro.appendRow(['test', 2, '10:10', '학생가']);
ro.appendRow(['test', 3, '10:20', '학생나']);
ro.appendRow(['3', 1, '17:30', '홍길동']);

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
  if (url.pathname === '/__stats') { res.end(JSON.stringify({ calls, log: (sheets['기록'] || { rows: [] }).rows })); return; }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
  let data = fs.readFileSync(f);
  if (p === '/config.js') data = Buffer.from(String(data).replace(/API: '[^']*'/, `API: 'http://localhost:${PORT}/api'`));
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  res.end(data);
}).listen(PORT, () => console.log('mock on', PORT));
