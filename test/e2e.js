// 헤드리스 크롬 4창(운영·멘토·학생 2)으로 실제 연결·녹화 흐름 시험
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:' + (process.env.PORT || 8080);
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(page, fn, arg, ms = 30000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await page.evaluate(fn, arg)) return true; } catch (e) {}
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  const mk = async (name, vp) => {
    const c = await browser.newContext({ viewport: vp || { width: 1400, height: 900 }, acceptDownloads: true, permissions: ['camera', 'microphone'] });
    const p = await c.newPage();
    p.on('console', m => { if (m.type() === 'error') console.log(`[${name} console]`, m.text()); });
    p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message));
    return p;
  };
  const ops = await mk('ops'), mentor = await mk('mentor'), sA = await mk('stuA', { width: 420, height: 860 }), sB = await mk('stuB', { width: 420, height: 860 });

  // 운영진
  await ops.goto(BASE + '/ops.html?r=test');
  await ops.fill('#g-name', '운영A'); await ops.fill('#g-code', 'o1234'); await ops.click('#g-btn');
  await ops.waitForSelector('#s-main:not(.hide)');
  await ops.click('label.switch:has(#sw-host)');
  log('ops in, host on');

  // 멘토
  await mentor.goto(BASE + '/mentor.html?r=test');
  await mentor.fill('#g-name', '정은영'); await mentor.fill('#g-code', 'm1234'); await mentor.click('#g-btn');
  await mentor.waitForSelector('#c-btn:not([disabled])', { timeout: 15000 });
  await mentor.click('#c-btn');
  log('mentor in');

  // 학생: 명단 밖 이름 거절 확인
  await sA.goto(BASE + '/?r=test');
  await sA.fill('#g-name', '없는학생'); await sA.check('#g-agree'); await sA.click('#g-btn');
  await sA.waitForFunction(() => document.querySelector('#g-err').textContent.includes('명단'));
  log('roster reject ok');
  await sA.fill('#g-name', '학생가'); await sA.click('#g-btn');
  await sA.waitForSelector('#c-btn:not([disabled])'); await sA.click('#c-btn');
  await sB.goto(BASE + '/?r=test');
  await sB.fill('#g-name', '학생나'); await sB.check('#g-agree'); await sB.click('#g-btn');
  await sB.waitForSelector('#c-btn:not([disabled])'); await sB.click('#c-btn');
  log('students in waiting room');

  // 연결 점검 결과
  await waitFor(sA, () => document.querySelector('#w-test').textContent.includes('완료'), null, 40000, 'test A');
  await waitFor(sB, () => document.querySelector('#w-test').textContent.includes('완료'), null, 40000, 'test B');
  log('connection tests done (both)');
  // 운영 화면: 멘토 영상
  await waitFor(ops, () => { const v = document.querySelector('#v-M'); return v.videoWidth > 0; }, null, 30000, 'ops sees mentor');
  log('ops sees mentor video');
  await ops.screenshot({ path: path.join(OUT, '1_ops_waiting.png') });
  await sA.screenshot({ path: path.join(OUT, '1_student_waiting.png') });

  // 학생가 시작
  const dl1 = ops.waitForEvent('download', { timeout: 90000 });
  await ops.click('#b-next');
  const t0 = Date.now();
  await waitFor(sA, () => { const v = document.querySelector('#l-remote'); return !document.querySelector('#s-live').classList.contains('hide') && v.videoWidth > 0; }, null, 40000, 'student sees mentor');
  log('student A sees mentor after', Date.now() - t0, 'ms');
  await waitFor(mentor, () => document.querySelector('#v-remote').videoWidth > 0, null, 30000, 'mentor sees student');
  log('mentor sees student A after', Date.now() - t0, 'ms');
  await waitFor(ops, () => document.querySelector('#v-S').videoWidth > 0, null, 30000, 'ops sees student');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide'), null, 20000, 'recording');
  log('ops sees both & recording after', Date.now() - t0, 'ms');
  await sleep(8000);
  await ops.screenshot({ path: path.join(OUT, '2_ops_live.png') });
  await mentor.screenshot({ path: path.join(OUT, '2_mentor_live.png') });
  await sA.screenshot({ path: path.join(OUT, '2_student_live.png') });

  // 다음 학생 → A 녹화 저장
  await ops.click('#b-next');
  const d1 = await dl1;
  const f1 = path.join(OUT, d1.suggestedFilename());
  await d1.saveAs(f1);
  log('saved', d1.suggestedFilename(), fs.statSync(f1).size, 'bytes');
  await waitFor(sA, () => !document.querySelector('#s-done').classList.contains('hide'), null, 20000, 'A done');
  await waitFor(sB, () => document.querySelector('#l-remote').videoWidth > 0, null, 40000, 'B sees mentor');
  log('student B live');
  const dl2 = ops.waitForEvent('download', { timeout: 60000 });
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide'), null, 20000, 'recording B');
  await sleep(5000);

  // 종료(두 번 눌러 확인)
  await ops.click('#b-end'); await ops.click('#b-end');
  const d2 = await dl2;
  const f2 = path.join(OUT, d2.suggestedFilename()); await d2.saveAs(f2);
  log('saved', d2.suggestedFilename(), fs.statSync(f2).size, 'bytes');
  await waitFor(mentor, () => !document.querySelector('#o-idle').classList.contains('hide'), null, 15000, 'mentor idle');
  log('mentor back to idle');

  // ZOOM 전환
  await ops.fill('#z-url', 'https://zoom.us/j/123'); await ops.click('#b-zoom');
  await sleep(1500);
  await ops.click('button[data-a="zoom"][data-id="S_학생가"]');
  await waitFor(sA, () => !document.querySelector('#z-card').classList.contains('hide'), null, 15000, 'zoom card');
  log('zoom card shown to A');
  await sA.screenshot({ path: path.join(OUT, '3_student_zoom.png') });

  // 학생 새로고침 후 재시작 시나리오
  await ops.click('button[data-a="zoom"][data-id="S_학생가"]');
  await sB.reload();
  await sB.fill('#g-name', '학생나'); await sB.check('#g-agree'); await sB.click('#g-btn');
  await sB.waitForSelector('#c-btn:not([disabled])'); await sB.click('#c-btn');
  await ops.click('button[data-a="call"][data-id="S_학생나"]');
  const t1 = Date.now();
  await waitFor(sB, () => document.querySelector('#l-remote').videoWidth > 0, null, 40000, 'B re-live');
  log('B reconnected after reload, live in', Date.now() - t1, 'ms');
  await ops.click('#b-end'); await ops.click('#b-end');
  await sleep(3000);

  console.log(JSON.stringify(await (await fetch(BASE + '/__stats')).json()).slice(0, 1500));
  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
