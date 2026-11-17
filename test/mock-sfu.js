// 로컬 시험용 가짜 Cloudflare Realtime SFU
//  - Apps Script(가짜)가 보내는 SFU API 요청을 받아 두고
//  - 시험 브라우저 안의 「SFU 대역 페이지」(/host)가 가져가 실제 WebRTC로 처리한 뒤 답을 돌려줌
const http = require('http');
const PORT = Number(process.env.SFU_PORT || 8788);
let seq = 0;
const pending = new Map();   // id → { req, res }
const queue = [];            // 대역 페이지가 아직 안 가져간 요청
let waiter = null;           // 대역 페이지의 기다리는 요청
let calls = 0;

function hand() {
  if (!waiter || !queue.length) return;
  const w = waiter; waiter = null;
  const job = queue.shift();
  w.writeHead(200, { 'Content-Type': 'application/json' });
  w.end(JSON.stringify(job));
}

const HOST = `<!doctype html><meta charset="utf-8"><title>mock sfu</title><body>mock sfu host<script>
const S = {};   // sid → { pc, tracks: { name → track }, q }
const log = (...a) => console.log('[sfu]', ...a);
const gather = pc => new Promise(r => { if (pc.iceGatheringState === 'complete') return r(); const f = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', f); r(); } }; pc.addEventListener('icegatheringstatechange', f); setTimeout(r, 3000); });
async function handle(job) {
  const m = job.path.match(/^\\/v1\\/apps\\/[^/]+\\/sessions\\/(new|([^/]+)\\/(tracks\\/new|renegotiate|tracks\\/close|tracks\\/update))$/);
  if (!m) return [404, { errorCode: 'not_found' }];
  if (m[1] === 'new') {
    const sid = 's' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    S[sid] = { pc: new RTCPeerConnection({ bundlePolicy: 'max-bundle' }), tracks: {}, q: Promise.resolve() };
    return [201, { sessionId: sid }];
  }
  const s = S[m[2]]; if (!s) return [404, { errorCode: 'session_not_found' }];
  const run = s.q.then(() => op(s, m[3], job.body || {}));
  s.q = run.catch(() => {});
  return run;
}
async function op(s, kind, b) {
  const pc = s.pc;
  if (kind === 'tracks/new' && b.sessionDescription) {   // 올리기
    await pc.setRemoteDescription(b.sessionDescription);
    for (const t of b.tracks || []) {
      const tr = pc.getTransceivers().find(x => x.mid === String(t.mid));
      if (!tr) continue;
      tr.direction = 'recvonly';
      s.tracks[t.trackName] = tr.receiver.track;
    }
    const ans = await pc.createAnswer(); await pc.setLocalDescription(ans); await gather(pc);
    return [200, { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp }, tracks: (b.tracks || []).map(t => ({ mid: t.mid, trackName: t.trackName })) }];
  }
  if (kind === 'tracks/new') {   // 받기
    const out = [], added = [];
    for (const t of b.tracks || []) {
      const src = S[t.sessionId], track = src && src.tracks[t.trackName];
      if (!track) { out.push({ sessionId: t.sessionId, trackName: t.trackName, errorCode: 'not_found', errorDescription: 'track not found' }); continue; }
      const tr = pc.addTransceiver(track, { direction: 'sendonly' });
      added.push([t, tr]);
    }
    if (!added.length) return [200, { tracks: out }];
    const off = await pc.createOffer(); await pc.setLocalDescription(off); await gather(pc);
    added.forEach(([t, tr]) => out.push({ sessionId: t.sessionId, trackName: t.trackName, mid: tr.mid }));
    return [200, { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: pc.localDescription.sdp }, tracks: out }];
  }
  if (kind === 'tracks/update') { window.__upd = (window.__upd || 0) + 1; return [200, { requiresImmediateRenegotiation: false, tracks: (b.tracks || []).map(t => ({ mid: t.mid, trackName: t.trackName, sessionId: t.sessionId })) }]; }
  if (kind === 'renegotiate') { await pc.setRemoteDescription(b.sessionDescription); return [200, {}]; }
  if (kind === 'tracks/close') {
    if (b.sessionDescription) {
      await pc.setRemoteDescription(b.sessionDescription);
      const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
      return [200, { sessionDescription: { type: 'answer', sdp: pc.localDescription.sdp }, tracks: (b.tracks || []).map(t => ({ mid: t.mid })) }];
    }
    return [200, { tracks: b.tracks || [] }];
  }
  return [400, { errorCode: 'bad' }];
}
(async function loop() {
  for (;;) {
    let job;
    try { job = await (await fetch('/host/next')).json(); } catch (e) { await new Promise(r => setTimeout(r, 300)); continue; }
    if (!job || !job.id) continue;
    handle(job).catch(e => [500, { errorCode: 'host', errorDescription: String(e) }]).then(([code, body]) => {
      fetch('/host/reply/' + job.id, { method: 'POST', body: JSON.stringify({ code, body }) });
      if (code >= 300) log(job.path, code, JSON.stringify(body));
    });
  }
})();
window.__sfuStats = () => Object.keys(S).map(k => ({ sid: k, state: S[k].pc.connectionState, tracks: Object.keys(S[k].tracks).length, send: S[k].pc.getTransceivers().filter(t => t.currentDirection === 'sendonly').length }));
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/host') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(HOST); }
  if (url.pathname === '/host/next') { if (waiter) { waiter.writeHead(200); waiter.end('{}'); } waiter = res; setTimeout(() => { if (waiter === res) { waiter = null; res.writeHead(200); res.end('{}'); } }, 20000); return hand(); }
  if (url.pathname === '/stats') { res.end(JSON.stringify({ calls, pending: pending.size })); return; }
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const m = url.pathname.match(/^\/host\/reply\/(\d+)$/);
    if (m) {
      const p = pending.get(Number(m[1])); pending.delete(Number(m[1]));
      res.end('ok');
      if (p) { const r = JSON.parse(body); p.res.writeHead(r.code, { 'Content-Type': 'application/json' }); p.res.end(JSON.stringify(r.body)); }
      return;
    }
    if (url.pathname.startsWith('/v1/apps/')) {
      calls++;
      if (!/^Bearer \S+/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('{"errorCode":"auth"}'); }
      const id = ++seq;
      pending.set(id, { res });
      queue.push({ id, method: req.method, path: url.pathname, body: body ? JSON.parse(body) : null });
      return hand();
    }
    res.writeHead(404); res.end();
  });
}).listen(PORT, () => console.log('mock sfu on', PORT));
