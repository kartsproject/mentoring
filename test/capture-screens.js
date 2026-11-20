// 「화면 둘러보기」(screens/) 사진 찍기 — 시험용 가짜 서버 + 시연 조종판(가상 참가자) + 실제 운영·연구원 화면
//  무용: node test/mock-server.js & node test/mock-sfu.js & → node test/capture-screens.js
//  미술: CODE=a PORT=8081 node test/mock-server.js & → FIELD=a PORT=8081 node test/capture-screens.js
//  찍은 뒤: python3 test/screens-convert.py  (test/out/screens/*.png → screens/img/*.jpg)
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const FIELD = process.env.FIELD || 'b';
const BASE = 'http://localhost:' + (process.env.PORT || (FIELD === 'a' ? 8081 : 8080));
const SFU = 'http://localhost:' + (process.env.SFU_PORT || 8788);
const OUT = path.join(__dirname, 'out', 'screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function waitFor(page, fn, arg, ms = 30000, label = '') {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) {
    try { last = await page.evaluate(fn, arg); if (last) return last; } catch (e) { last = e.message; }
    await sleep(500);
  }
  throw new Error('timeout: ' + label + ' (' + JSON.stringify(last) + ')');
}
const F = n => path.join(OUT, FIELD + '-' + n + '.png');
const shot = async (p, n) => { await p.screenshot({ path: F(n) }); log('찍음', n); };

// 실제 카메라 대신 사람 모양 가상 영상(운영·연구원·입장 화면용)
function fakeCam(o) {
  if (window.parent !== window) return;
  const draw = (c, t) => {
    const x = c.getContext('2d'), W = c.width, H = c.height, h = o.hue;
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, `hsl(${h},22%,28%)`); g.addColorStop(1, `hsl(${h},26%,15%)`);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const cx = W * .5 + Math.sin(t / 1600) * W * .012, by = H * .58;
    x.fillStyle = `hsl(${h},45%,50%)`; x.beginPath(); x.ellipse(cx, by + H * .36, W * .24, H * .4, 0, Math.PI, 0); x.fill();
    x.fillStyle = `hsl(${(h + 25) % 360},18%,72%)`; x.fillRect(cx - W * .03, by - H * .09, W * .06, H * .1);
    x.beginPath(); x.ellipse(cx, by - H * .2, W * .085, H * .145, 0, 0, 7); x.fill();
    x.fillStyle = `hsl(${h},20%,16%)`; x.beginPath(); x.ellipse(cx, by - H * .27, W * .09, H * .085, 0, Math.PI, 0); x.fill();
  };
  const md = navigator.mediaDevices; if (!md) return;
  let cv = null, ac = null;
  md.getUserMedia = async (c) => {
    c = c || {};
    if (!cv) { cv = document.createElement('canvas'); cv.width = 640; cv.height = 480; setInterval(() => draw(cv, performance.now()), 80); draw(cv, 0); }
    const tr = [];
    if (c.video) tr.push(cv.captureStream(12).getVideoTracks()[0]);
    if (c.audio) { ac = ac || new AudioContext(); const d = ac.createMediaStreamDestination(); tr.push(d.stream.getAudioTracks()[0]); }
    return new MediaStream(tr);
  };
  md.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'c', groupId: 'g', label: '카메라' }, { kind: 'audioinput', deviceId: 'm', groupId: 'g', label: '마이크' }];
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'] });
  const mk = async (name, vp, dsf, hue) => {
    const c = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf || 1, permissions: ['camera', 'microphone'] });
    if (hue != null) await c.addInitScript(fakeCam, { hue });
    const p = await c.newPage();
    p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message));
    return p;
  };
  // 시연 조종판의 가상 참가자 화면을 실제 크기로 크게 띄워 찍기
  const botShot = async (demo, id, n, wait = 4000) => {
    await demo.evaluate(id => { const b = window.__demo.BOTS().find(x => x.id === id); b.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }, id);
    await sleep(wait);
    await demo.evaluate(() => { const e = document.querySelector('.bot.big'); e.style.setProperty('--bs', '1'); const s = e.querySelector('.scr'); s.style.borderRadius = '0'; s.style.outline = 'none'; s.style.boxShadow = 'none'; });
    await sleep(600);
    const r = await demo.evaluate(() => { const b = document.querySelector('.bot.big .scr').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; });
    await demo.screenshot({ path: F(n), clip: r, timeout: 60000 });
    await demo.evaluate(() => { const s = document.querySelector('.bot.big .scr'); if (s) s.removeAttribute('style'); });
    await demo.keyboard.press('Escape');
    log('찍음', n);
  };
  const bots = p => p.evaluate(() => window.__demo.BOTS().map(b => ({ id: b.id, name: b.name, st: b.status })));
  let fail = null;
  try {
    const host = await mk('sfu', { width: 800, height: 600 }); await host.goto(SFU + '/host');

    // ① 학생 입장·장치 확인(리허설 회차, 휴대폰)
    { const s = await mk('stu', { width: 390, height: 844 }, 2, 200);
      await s.goto(BASE + '/' + FIELD + '/?r=test'); await sleep(1200);
      await shot(s, 'stu-1-gate');
      await s.fill('#g-name', '학생가'); await s.fill('#g-birth', '20140101'); await s.check('#g-agree'); await s.click('#g-btn');
      await s.waitForSelector('#c-btn:not([disabled])', { timeout: 20000 }); await sleep(1500);
      await shot(s, 'stu-2-check');
      await s.context().close(); }

    // ② 시연 시작
    const demo = await mk('demo', { width: 1400, height: 1000 }, 2);
    await demo.goto(BASE + '/demo/?slot=2&lead=1');
    if (FIELD === 'a') await demo.click('.fpill [data-f="a"]');
    await demo.fill('#code', 'o1234'); if (FIELD === 'a') await demo.uncheck('#auto'); await demo.click('#b-start');
    await waitFor(demo, () => document.body.classList.contains('run'), null, 15000, 'start');

    // ③ 운영진(녹화 PC)·연구원
    const ops = await mk('ops', { width: 1600, height: 950 }, 1, 28);
    if (FIELD === 'a') await ops.addInitScript(() => { window.__testFps = 1; });
    await ops.goto(BASE + '/' + FIELD + '/o.html?r=demo');
    await ops.fill('#g-name', '서하준'); await ops.fill('#g-code', 'o1234'); await ops.click('#g-btn');
    await ops.waitForSelector('#s-main:not(.hide)', { timeout: 20000 });
    if (FIELD === 'a') await ops.evaluate(() => { window.MEET_CONFIG.REC_FPS = 12; });
    await ops.evaluate(async () => window.__setRecDir(await navigator.storage.getDirectory()));
    await sleep(1500);
    const res = await mk('res', { width: 1600, height: 950 }, 1, 150);
    await res.goto(BASE + '/' + FIELD + '/o.html?r=demo');
    await res.click('.seg label:nth-child(2)');
    await res.fill('#g-name', '문가온'); await res.fill('#g-code', 'r1234'); await res.click('#g-btn');
    await res.waitForSelector('#s-main:not(.hide)', { timeout: 20000 });
    log('운영진·연구원 입장');
    const recShot = async (n) => {
      const d = await ops.evaluate((f) => {
        if (f === 'b') { const r = window.__rec(); return r && r.canvas ? [['main', r.canvas.toDataURL('image/png')]] : []; }
        return Object.entries(window.__recs() || {}).map(([k, x]) => [k, x.r.canvas.toDataURL('image/png')]);
      }, FIELD);
      d.forEach(([k, u]) => { fs.writeFileSync(F(n + (d.length > 1 ? '-' + k : '')), Buffer.from(u.split(',')[1], 'base64')); log('찍음(녹화)', n, k); });
    };

    if (FIELD === 'b') {
      await waitFor(demo, () => window.__demo.BOTS().filter(b => b.status === '대기실').length >= 7, null, 200000, 'wait room');
      await waitFor(ops, () => [...document.querySelectorAll('#w-grid .wt video')].filter(v => v.videoWidth > 0).length >= 6, null, 60000, 'ops videos');
      await sleep(4000);
      await shot(ops, 'ops-1-wait');
      await ops.click('#w-grid .wt[data-id="S_박지우"] [data-tel]').catch(() => {});
      await sleep(800); await shot(ops, 'ops-2-phone');
      await ops.click('#w-grid .wt[data-id="S_박지우"] [data-tel]').catch(() => {});
      await shot(res, 'res-1-wait');
      await botShot(demo, 's2', 'stu-3-wait');
      await botShot(demo, 'm1', 'men-1-wait');
      // 첫 학생 시작
      await waitFor(demo, () => window.__demo.BOTS().some(b => b.status === '멘토링 중'), null, 180000, 'live');
      await waitFor(demo, () => { const m = window.__demo.BOTS()[0]; const v = m.win && m.win.document.querySelector('#v-remote'); return v && v.videoWidth > 0; }, null, 40000, 'mentor video');
      await sleep(6000);
      await shot(ops, 'ops-3-live');
      await recShot('rec-1-live');
      // 연구원 멘토링 참여 + 마이크 켜기
      await res.click('#b-join'); await sleep(6000);
      await res.click('#b-smic').catch(() => {}); await sleep(5000);
      await shot(res, 'res-2-join');
      const cur = await demo.evaluate(() => window.__demo.BOTS().find(b => b.status === '멘토링 중').id);
      await botShot(demo, cur, 'stu-4-live', 12000);
      await botShot(demo, 'm1', 'men-2-live', 5000);
      await shot(ops, 'ops-4-research');
      await recShot('rec-2-research');
      // 멘토링 마침 화면
      await waitFor(demo, (c) => window.__demo.BOTS().find(b => b.id === c).status === '멘토링 마침', cur, 180000, 'end');
      await botShot(demo, cur, 'stu-5-end', 800);
    } else {
      await waitFor(demo, () => window.__demo.BOTS().filter(b => /접속/.test(b.status)).length >= 18, null, 120000, 'in');
      await sleep(3000);
      await botShot(demo, 's1', 'stu-3-ready');
      await demo.evaluate(n => { if ((window.__demo.S.artStep || 0) < n) window.__demo.artGo(n); }, 1);
      await waitFor(demo, () => window.__demo.S.view && window.__demo.S.view.phase === 'all', null, 20000, 'all');
      await waitFor(ops, () => [...document.querySelectorAll('.tile video')].filter(v => v.videoWidth > 0).length >= 14, null, 60000, 'ops tiles');
      await waitFor(demo, () => window.__demo.BOTS().some(b => b.id === 'm1' && b.talking), null, 30000, 'm1 talk');
      await sleep(3000);
      await shot(ops, 'ops-1-all'); await shot(res, 'res-1-all');
      await recShot('rec-1-all');
      await botShot(demo, 's1', 'stu-4-all');
      await botShot(demo, 'm1', 'men-1-all');
      await demo.evaluate(n => { if ((window.__demo.S.artStep || 0) < n) window.__demo.artGo(n); }, 2);
      await waitFor(demo, () => window.__demo.S.view && window.__demo.S.view.phase === 'group', null, 30000, 'group').catch(async e => { console.log('dbg', JSON.stringify(await demo.evaluate(() => [window.__demo.S.artStep, window.__demo.S.lastOp, window.__demo.S.view && window.__demo.S.view.phase]))); throw e; });
      await waitFor(demo, () => window.__demo.BOTS().filter(b => b.kind === 'stu' && /조/.test(b.status)).length >= 12, null, 40000, 'groups');
      await demo.evaluate(() => { const B = window.__demo.BOTS(); window.__demo.photo(B.find(b => b.id === 's1')); window.__demo.hand(B.find(b => b.id === 's5'), true); });
      await sleep(12000);
      await waitFor(ops, () => [...document.querySelectorAll('.tile video')].filter(v => v.videoWidth > 0).length >= 10, null, 60000, 'ops group tiles');
      await shot(ops, 'ops-2-group'); await shot(res, 'res-2-group');
      await recShot('rec-2-group');
      await botShot(demo, 's1', 'stu-5-group', 5000);
      await botShot(demo, 'm1', 'men-2-group', 5000);
      await demo.evaluate(n => { if ((window.__demo.S.artStep || 0) < n) window.__demo.artGo(n); }, 3);
      await waitFor(demo, () => window.__demo.S.view && window.__demo.S.view.phase === 'all', null, 30000, 'all2');
      await sleep(8000);
      await demo.evaluate(n => { if ((window.__demo.S.artStep || 0) < n) window.__demo.artGo(n); }, 4);
      await waitFor(demo, () => window.__demo.BOTS().find(b => b.id === 's2').status === '멘토링 마침', null, 30000, 'closeall');
      await botShot(demo, 's2', 'stu-6-end', 800);
      await sleep(1500); await shot(ops, 'ops-3-end');
    }
    log((await bots(demo)).filter(b => /확인/.test(b.st)).length ? '확인 필요 있음' : '참가자 이상 없음');
  } catch (e) { fail = e; console.log('FAIL', e.message); }
  await browser.close();
  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(fail ? 1 : 0);
})();
