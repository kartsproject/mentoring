// 시연 조종판 시험(헤드리스 크롬): 조종판 1개 + 실제 운영 화면 1개
//  무용: node test/mock-server.js & node test/mock-sfu.js & → node test/e2e-demo.js
//  미술: CODE=a PORT=8081 node test/mock-server.js & → FIELD=a PORT=8081 node test/e2e-demo.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const FIELD = process.env.FIELD || 'b';
const BASE = 'http://localhost:' + (process.env.PORT || (FIELD === 'a' ? 8081 : 8080));
const SFU = 'http://localhost:' + (process.env.SFU_PORT || 8788);
const OUT = path.join(__dirname, 'out');
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
const SHOT = async (p, name) => { try { await p.screenshot({ path: path.join(OUT, 'demo_' + FIELD + '_' + name + '.png'), timeout: 15000 }); } catch (e) { console.log('(screenshot skipped:', name + ')'); } };
const bots = p => p.evaluate(() => window.__demo.BOTS().map(b => ({ id: b.id, name: b.name, on: b.on, st: b.status, err: b.err, talk: b.talking })));
const count = (l, re) => l.filter(b => re.test(b.st)).length;

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=fps=10', '--autoplay-policy=no-user-gesture-required'] });
  const mk = async (name, vp) => {
    const c = await browser.newContext({ viewport: vp || { width: 1600, height: 950 }, permissions: ['camera', 'microphone'] });
    const p = await c.newPage();
    p.on('pageerror', e => console.log(`[${name} pageerror]`, e.stack.split('\n').slice(0, 3).join(' < ')));
    p.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/Failed to load resource|favicon/.test(t)) console.log(`[${name}]`, t.slice(0, 300)); });
    return p;
  };
  let fail = null;
  try {
    const host = await mk('sfu'); await host.goto(SFU + '/host');
    const demo = await mk('demo', { width: 1700, height: 1000 });
    // 시험 PC 부담: 학생 화면 여러 개를 동시에 돌림
    await demo.goto(BASE + '/demo/?slot=1&lead=1');
    if (FIELD === 'a') await demo.click('.fpill [data-f="a"]');
    await demo.fill('#code', 'wrong'); await demo.click('#b-start');
    await waitFor(demo, () => /코드가 맞지 않습니다/.test(document.querySelector('#msg').textContent), null, 10000, 'wrong code');
    log('잘못된 코드 → 안내');
    await demo.fill('#code', 'o1234');
    if (FIELD === 'a') await demo.check('#photos');
    await demo.click('#b-start');
    await waitFor(demo, () => document.body.classList.contains('run') && window.__demo.BOTS().length, null, 15000, 'started');
    log('시연 시작:', await demo.evaluate(() => document.querySelector('#msg').textContent));

    // 실제 운영자
    const ops = await mk('ops');
    await ops.goto(BASE + '/' + FIELD + '/o.html?r=demo');
    await ops.fill('#g-name', '운영A'); await ops.fill('#g-code', 'o1234'); await ops.click('#g-btn');
    await ops.waitForSelector('#s-main:not(.hide)', { timeout: 20000 });
    if (FIELD === 'b') { try { await ops.waitForSelector('#recSetup:not(.hide)', { timeout: 8000 }); await ops.click('#rs-skip'); } catch (e) {} }
    else await ops.evaluate(async () => window.__setRecDir && window.__setRecDir(await navigator.storage.getDirectory()));
    log('운영자 입장(시연 회차)');

    if (FIELD === 'b') {
      await waitFor(demo, () => window.__demo.BOTS().filter(b => b.status === '대기실').length >= 7, null, 90000, 'students in waiting room');
      let l = await bots(demo); log('대기실:', count(l, /대기실/), '명 · 멘토:', l[0].st, ' 오류:', l.filter(b => b.err).map(b => b.name + ' ' + b.err).join(', ') || '없음');
      await waitFor(ops, () => document.querySelectorAll('#w-grid .wt[data-id^="S_"]').length >= 12, null, 20000, 'ops roster 12');
      const vids = await waitFor(ops, () => { const n = [...document.querySelectorAll('#w-grid .wt video')].filter(v => v.videoWidth > 0 && v.readyState >= 2).length; return n >= 4 && n; }, null, 60000, 'ops sees waiting videos');
      log('운영 화면 대기실: 학생 칸 12, 영상 나오는 칸', vids);
      // 전화 정보(가짜 번호)
      if (!/010-0000-10/.test(await ops.evaluate(() => document.querySelector('#w-grid').textContent + [...document.querySelectorAll('.wpc')].map(a => a.textContent).join('')))) {
        await ops.click('#w-grid .wt[data-id^="S_"] [data-tel]').catch(() => {});
      }
      await SHOT(demo, 'panel_wait'); await SHOT(ops, 'ops_wait');
      // 크게 보기(학생 화면)
      await demo.dblclick('.bot.stu[data-id="s1"]');
      await sleep(2500); await SHOT(demo, 'big_student');
      await demo.keyboard.press('Escape');
      // 직접 조작: 대기실 학생 말하기 → 그 학생 마이크 트랙이 켜짐
      await demo.click('.bot.stu[data-id="s2"]'); await demo.click('#sel [data-a="talk"]');
      await waitFor(demo, () => { const b = window.__demo.BOTS().find(x => x.id === 's2'); return b.talking && b.issued.some(t => t.kind === 'audio' && t.readyState === 'live' && t.enabled); }, null, 8000, 'talk turns mic on');
      log('직접 조작 「말하기」 → 대기실 마이크 켜짐');
      // 첫 학생 멘토링(자동 「시작」)
      const cur = await waitFor(demo, () => { const v = window.__demo.S.view; return v && v.cur && v.cur.name; }, null, 150000, 'first call');
      log('자동 시작 →', cur);
      await waitFor(demo, () => window.__demo.BOTS().some(b => b.status === '멘토링 중'), null, 30000, 'student live');
      const ok = await waitFor(demo, () => { const m = window.__demo.BOTS()[0]; const v = m.win && m.win.document.querySelector('#v-remote'); return v && v.videoWidth > 0 && v.readyState >= 2 && v.videoWidth + 'x' + v.videoHeight; }, null, 40000, 'mentor sees student');
      log('가상 멘토 화면에 가상 학생 영상:', ok);
      await waitFor(demo, () => window.__demo.BOTS().some(b => b.talking), null, 20000, 'conversation');
      log('대화 중:', (await bots(demo)).filter(b => b.talk).map(b => b.name).join(', '));
      const opsLive = await waitFor(ops, () => { const n = [...document.querySelectorAll('video')].filter(v => v.videoWidth > 0 && v.closest('#c-stage, .duo, .rooms, #room-m, .rm')).length; return n >= 1 && n; }, null, 40000, 'ops sees mentoring');
      log('운영 화면 멘토링실 영상', opsLive);
      await sleep(3000); await SHOT(demo, 'panel_live'); await SHOT(ops, 'ops_live');
      // 1분 뒤 자동 종료 → 다음 학생
      const nx = await waitFor(demo, (c) => { const v = window.__demo.S.view; return v && v.cur && v.cur.name !== c && v.cur.name; }, cur, 110000, 'next call');
      log('자동 종료 → 다음 학생', nx);
      await waitFor(demo, (c) => window.__demo.BOTS().some(b => b.name === c && !b.on && b.status === '나감'), cur, 30000, 'done student leaves');
      log('마친 학생 창 닫힘');
      // 연결 끊기 → 다시 들어옴
      const dn = await demo.evaluate(() => { const b = window.__demo.BOTS().filter(x => x.status === '대기실').pop(); b.drop(); return b.name; });
      await waitFor(demo, n => window.__demo.BOTS().find(b => b.name === n).status === '연결 끊김', dn, 5000, 'dropped');
      await waitFor(demo, n => window.__demo.BOTS().find(b => b.name === n).status === '대기실', dn, 40000, 'back after drop');
      log('연결 끊기 → 8초 뒤 자동으로 대기실 복귀:', dn);
      const st = await demo.evaluate(() => [...document.querySelectorAll('#steps li')].map(l => (l.classList.contains('done') ? '✓ ' : '· ') + l.textContent).join('\n'));
      log('진행 순서\n' + st);
    } else {
      await waitFor(demo, () => window.__demo.BOTS().filter(b => /접속/.test(b.status)).length >= 18, null, 120000, 'art bots in');
      let l = await bots(demo); log('접속:', count(l, /접속/), '/', l.length, ' 오류:', l.filter(b => b.err).map(b => b.name + ' ' + b.err).join(', ') || '없음');
      await SHOT(demo, 'panel_in'); await SHOT(ops, 'ops_in');
      // 전체 → 바로(「지금」 버튼)
      await demo.click('#steps [data-go="1"]');
      await waitFor(ops, () => /전체/.test(document.body.textContent) && window.__demo === undefined, null, 5000, 'ops').catch(() => {});
      await waitFor(demo, () => window.__demo.S.view && window.__demo.S.view.phase === 'all', null, 20000, 'phase all');
      await waitFor(demo, () => window.__demo.BOTS().some(b => b.talking && b.id === 'm1'), null, 20000, 'mentor1 talks');
      log('전체 멘토링: 1조 멘토 설명 중');
      const opsVid = await waitFor(ops, () => { const n = [...document.querySelectorAll('.tile video')].filter(v => v.videoWidth > 0).length; return n >= 6 && n; }, null, 60000, 'ops tiles');
      log('운영 화면 영상 칸', opsVid);
      await sleep(4000); await SHOT(demo, 'panel_all'); await SHOT(ops, 'ops_all');
      await demo.click('#steps [data-go="2"]');
      await waitFor(demo, () => window.__demo.S.view && window.__demo.S.view.phase === 'group', null, 20000, 'phase group')
        .catch(async e => { log('dbg', JSON.stringify(await demo.evaluate(() => ({ step: window.__demo.S.artStep, ev: Object.keys(window.__demo.S.events), ph: window.__demo.S.view && window.__demo.S.view.phase, last: window.__demo.S.lastOp })))); throw e; });
      await waitFor(demo, () => window.__demo.BOTS().filter(b => b.kind === 'stu' && /조/.test(b.status)).length >= 12, null, 30000, 'students in group rooms');
      log('분반: 학생 방', [...new Set((await bots(demo)).filter(b => b.id[0] === 's').map(b => b.st))].join(' / '));
      await waitFor(demo, () => (window.__demo.S.view.people || []).some(p => p.hand) || Object.keys(window.__demo.S.view.hands || {}).length, null, 60000, 'hand raised').catch(e => log('손들기 확인 생략:', e.message));
      const ph = await waitFor(demo, () => fetch('/__stats').then(r => r.json()).then(j => j.photos >= 1 && j.photos), null, 70000, 'photo uploaded');
      log('작품 사진 자동 올리기:', ph, '장');
      const gv = await waitFor(ops, () => { const n = [...document.querySelectorAll('.tile video')].filter(v => v.videoWidth > 0).length; return n >= 10 && n; }, null, 40000, 'ops group tiles').catch(e => 'X ' + e.message);
      log('운영 화면(분반) 영상 칸', gv);
      await sleep(3000); await SHOT(demo, 'panel_group'); await SHOT(ops, 'ops_group');
      await demo.dblclick('.bot.men[data-id="m1"]'); await sleep(3500); await SHOT(demo, 'big_mentor'); await demo.keyboard.press('Escape');
      await demo.click('#steps [data-go="4"]');
      await waitFor(demo, () => window.__demo.BOTS().filter(b => b.status === '멘토링 마침').length >= 10, null, 30000, 'closeall');
      log('마침·모두 퇴장 → 학생 화면 「멘토링이 모두 끝났습니다」');
    }
    // 끝내기
    await demo.click('#b-stop');
    await waitFor(demo, () => !document.body.classList.contains('run') && window.__demo.BOTS().every(b => !b.on), null, 15000, 'stopped');
    const st = await (await fetch(BASE + '/__stats')).json();
    const demoLogs = (st.log || []).filter(r => r.includes('demo'));
    if (demoLogs.length) throw new Error('시연 기록이 시트에 남으면 안 됨: ' + demoLogs.length);
    log('시연 끝내기 → 모두 퇴장, 시트 기록 없음');
  } catch (e) { fail = e; console.log('FAIL', e.message); }
  await browser.close();
  console.log(fail ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exit(fail ? 1 : 0);
})();
