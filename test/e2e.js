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
  const ops = await mk('ops'), mentor = await mk('mentor'), res = await mk('research'), sA = await mk('stuA', { width: 420, height: 860 }), sB = await mk('stuB', { width: 420, height: 860 });

  // 운영진
  await ops.goto(BASE + '/ops.html?r=test');
  await ops.fill('#g-name', '운영A'); await ops.fill('#g-code', 'o1234'); await ops.click('#g-btn');
  await ops.waitForSelector('#s-main:not(.hide)');
  await ops.click('label.switch:has(#sw-host)');
  await sleep(1500);
  // 자동 저장: 시험에서는 폴더 선택 창 대신 브라우저 내부 저장소(OPFS)를 저장 폴더로 지정
  await ops.evaluate(async () => window.__setRecDir(await navigator.storage.getDirectory()));
  log('ops in, host on, auto-save folder set');

  // 멘토
  await mentor.goto(BASE + '/mentor.html?r=test');
  await mentor.fill('#g-name', '정은영'); await mentor.fill('#g-code', 'm1234'); await mentor.click('#g-btn');
  await mentor.waitForSelector('#c-btn:not([disabled])', { timeout: 15000 });
  await mentor.click('#c-btn');
  log('mentor in');
  await mentor.evaluate(() => { window.Meet.CFG.SLOT_MIN = 1.05; window.Meet.CFG.FEEDBACK_MIN = 0.5; });

  // 연구원 입장 → 화면 등장 → 멘토가 연구원을 봄
  await res.goto(BASE + '/ops.html?r=test');
  await res.click('.seg label:nth-child(2)');
  await res.fill('#g-name', '연구원A'); await res.fill('#g-code', 'r1234'); await res.click('#g-btn');
  await res.waitForSelector('#s-main:not(.hide)');
  if (await res.isVisible('#p-rec')) throw new Error('research should not see recording panel');
  await res.click('#b-stage');
  await waitFor(res, () => !document.querySelector('#st-ctrls').classList.contains('hide'), null, 15000, 'research stage ctrls');
  // 스페이스를 누르는 동안만 마이크
  const micState = () => res.evaluate(() => document.querySelector('#h-talk').textContent);
  const m0 = await micState();
  await res.keyboard.down('Space'); await sleep(300); const m1 = await micState();
  await res.keyboard.up('Space'); await sleep(300); const m2 = await micState();
  if (!/스페이스/.test(m0) || !/말하는 중/.test(m1) || /말하는 중/.test(m2)) throw new Error('PTT failed: ' + [m0, m1, m2].join(' / '));
  log('push-to-talk ok:', m0, '→', m1, '→', m2);
  await waitFor(mentor, () => { const v = document.querySelector('#g-stage video'); return v && v.videoWidth > 0; }, null, 30000, 'mentor sees researcher');
  log('mentor sees researcher on stage');
  await waitFor(res, () => document.querySelector('#v-M').videoWidth > 0, null, 30000, 'research sees mentor');
  // 운영진도 등장 → 멘토 화면 2명
  await ops.click('#b-stage');
  await waitFor(mentor, () => [...document.querySelectorAll('#g-stage video')].filter(v => v.videoWidth > 0).length === 2, null, 30000, 'mentor sees 2 on stage');
  await waitFor(ops, () => [...document.querySelectorAll('#g-stage video')].filter(v => v.videoWidth > 0).length === 2, null, 30000, 'ops sees stage grid');
  log('stage: mentor sees researcher + ops');
  await mentor.screenshot({ path: path.join(OUT, '0_mentor_stage.png') });
  await ops.screenshot({ path: path.join(OUT, '0_ops_stage.png') });
  // 시험 PC(2코어) 부하를 줄이기 위해 연구원·운영 화면 등장 종료 후 연구원 창 닫기
  await ops.click('#b-stage'); await res.click('#b-stage'); await sleep(1500); await res.close();
  await waitFor(mentor, () => !document.querySelector('#g-stage .gcell'), null, 20000, 'stage cleared');
  log('stage left; mentor stage empty');

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
  // 다음 차례(학생가) 미리 연결 확인
  await waitFor(sA, () => document.querySelector('#w-warm').textContent.includes('준비 완료'), null, 30000, 'A warm');
  log('student A prewarmed with mentor');
  await waitFor(ops, () => document.querySelector('#v-N').videoWidth > 0, null, 30000, 'ops next preview');
  log('ops sees next-student preview');
  await ops.screenshot({ path: path.join(OUT, '1_ops_waiting.png') });
  await sA.screenshot({ path: path.join(OUT, '1_student_waiting.png') });

  // 학생가 시작
  const t0 = Date.now();
  await ops.click('#b-next');
  await waitFor(sA, () => { const v = document.querySelector('#l-remote'); return !document.querySelector('#s-live').classList.contains('hide') && v.videoWidth > 0; }, null, 40000, 'student sees mentor');
  log('student A sees mentor after', Date.now() - t0, 'ms');
  await waitFor(mentor, () => document.querySelector('#v-remote').videoWidth > 0, null, 30000, 'mentor sees student');
  log('mentor sees student A after', Date.now() - t0, 'ms');
  await waitFor(ops, () => document.querySelector('#v-S').videoWidth > 0, null, 30000, 'ops sees student');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide'), null, 20000, 'recording');
  log('ops sees both & recording after', Date.now() - t0, 'ms');
  await waitFor(mentor, () => !document.querySelector('#bt').classList.contains('hide'), null, 5000, 'big timer');
  log('mentor big timer:', await mentor.evaluate(() => document.querySelector('#bt').textContent));
  await waitFor(mentor, () => !document.querySelector('#a1').classList.contains('hide') && document.querySelector('#bt').classList.contains('last'), null, 15000, '1-min warning');
  await mentor.screenshot({ path: path.join(OUT, '2c_mentor_last_minute.png') });
  log('mentor 1-minute warning shown');
  await waitFor(sB, () => document.querySelector('#w-warm').textContent.includes('준비 완료'), null, 30000, 'B warm');
  log('student B prewarmed during A session');
  await sB.evaluate(() => { /* 대기 중 카메라·마이크를 꺼 둔 상황 */ document.querySelector('#w-self').srcObject.getTracks().forEach(t => t.enabled = false); });
  await sleep(8000);
  await ops.screenshot({ path: path.join(OUT, '2_ops_live.png') });
  await mentor.screenshot({ path: path.join(OUT, '2_mentor_live.png') });
  await sA.screenshot({ path: path.join(OUT, '2_student_live.png') });

  // 다음 학생 → A 녹화 저장
  await ops.screenshot({ path: path.join(OUT, '2b_ops_before_next.png') });
  await ops.click('#b-next', { timeout: 8000 }).catch(async e => { console.log('click issue:', e.message.split('\n').slice(-3).join(' | ')); await ops.click('#b-next', { force: true }); });
  const tB = Date.now();
  const opfs = () => ops.evaluate(async () => { const d = await navigator.storage.getDirectory(); const out = []; for await (const [n, h] of d.entries()) { const f = await h.getFile(); out.push(n + ' ' + f.size); } return out; });
  await waitFor(ops, () => [...document.querySelectorAll('#rec-files li')].some(li => li.textContent.includes('자동 저장')), null, 30000, 'auto-saved A');
  log('auto-saved files:', JSON.stringify(await opfs()));
  await waitFor(sA, () => !document.querySelector('#s-done').classList.contains('hide'), null, 20000, 'A done');
  await waitFor(sB, () => document.querySelector('#l-remote').videoWidth > 0, null, 40000, 'B sees mentor');
  log('student B sees mentor after switch', Date.now() - tB, 'ms');
  const onB = await sB.evaluate(() => document.querySelector('#l-self').srcObject.getTracks().map(t => t.kind + ':' + t.enabled).join(','));
  if (/false/.test(onB)) throw new Error('student tracks not auto-enabled: ' + onB);
  log('student B camera/mic auto-on:', onB);
  await waitFor(mentor, () => { const v = document.querySelector('#v-remote'); return v.videoWidth > 0 && document.querySelector('#t-who').textContent.includes('학생나'); }, null, 20000, 'mentor B');
  log('mentor sees B after', Date.now() - tB, 'ms');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide'), null, 20000, 'recording B');
  await sleep(5000);

  // 종료(두 번 눌러 확인)
  await ops.click('#b-end'); await ops.click('#b-end');
  const tE = Date.now();
  await waitFor(mentor, () => !document.querySelector('#o-idle').classList.contains('hide'), null, 15000, 'mentor idle fast');
  log('END: mentor idle after', Date.now() - tE, 'ms');
  await waitFor(sB, () => !document.querySelector('#s-done').classList.contains('hide'), null, 15000, 'B done fast');
  log('END: student done screen after', Date.now() - tE, 'ms');
  await waitFor(ops, () => [...document.querySelectorAll('#rec-files li')].filter(li => li.textContent.includes('자동 저장')).length >= 2, null, 30000, 'auto-saved B');
  const files = await opfs();
  log('auto-saved files:', JSON.stringify(files));
  // 저장된 파일 하나를 꺼내 실제 영상인지 확인
  const b64 = await ops.evaluate(async () => { const d = await navigator.storage.getDirectory(); for await (const [n, h] of d.entries()) { if (/학생가/.test(n)) { const buf = new Uint8Array(await (await h.getFile()).arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return [n, btoa(s)]; } } return null; });
  fs.writeFileSync(path.join(OUT, b64[0]), Buffer.from(b64[1], 'base64'));
  await ops.screenshot({ path: path.join(OUT, '3_ops_files.png') });
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
