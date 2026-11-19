// 헤드리스 크롬으로 전체 흐름 시험: 운영(녹화 창 + 대기실 창)·연구원·멘토·학생 2
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
const SHOT = async (p, name) => { if (process.env.SHOTS) try { await p.screenshot({ path: path.join(OUT, 's_' + name + '.png'), timeout: 10000 }); } catch (e) { console.log('(screenshot skipped:', name + ')'); } };
const text = (p, sel) => p.evaluate(s => (document.querySelector(s) || {}).textContent || '', sel);

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'].concat(process.env.FAKEVID ? ['--use-file-for-fake-video-capture=' + process.env.FAKEVID] : [])
  });
  const mk = async (name, vp) => {
    const c = await browser.newContext({ viewport: vp || { width: 1600, height: 950 }, acceptDownloads: true, permissions: ['camera', 'microphone'] });
    if (process.env.THEME) {   // 디자인 시안 비교용: 시안 CSS를 덧씌움(배포 코드와 무관)
      const css = fs.readFileSync(process.env.THEME, 'utf8');
      await c.addInitScript(css => { document.addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
        const cs = document.querySelector('#c-stage'); if (cs && !cs.querySelector('.rhd')) { const h = document.createElement('div'); h.className = 'rhd'; h.innerHTML = '<b>멘토링실</b><small>멘토 · 진행 중인 학생</small>'; cs.prepend(h); }
      }); }, css);
    }
    const p = await c.newPage(); (global.__pages = global.__pages || []).push(p);
    p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`[${name} console]`, m.text()); });
    return p;
  };
  global.__pages = [];
  // 대기실 화상용 가짜 SFU 대역 페이지(test/mock-sfu.js)
  const sfuHost = await mk('sfu');
  await sfuHost.goto('http://localhost:' + (process.env.SFU_PORT || 8788) + '/host');
  const ops = await mk('ops'), mentor = await mk('mentor'), res = await mk('research'), sA = await mk('stuA', { width: 420, height: 860 }), sB = await mk('stuB', { width: 420, height: 860 }), sC = await mk('stuC', { width: 1280, height: 800 });

  // 운영진(녹화 창)
  await ops.goto(BASE + '/b/o.html?r=test');
  await SHOT(ops, 'ops_gate');
  await ops.fill('#g-name', '운영A'); await ops.fill('#g-code', 'o1234'); await ops.click('#g-btn');   // 운영진은 모두 자동 녹화
  await ops.waitForSelector('#s-main:not(.hide)');
  await ops.waitForSelector('#recSetup:not(.hide)', { timeout: 10000 });
  await sleep(500); await SHOT(ops, 'ops_recsetup');
  await ops.evaluate(async () => window.__setRecDir(await navigator.storage.getDirectory()));   // 폴더 선택 창 대신(시험용)
  await waitFor(ops, () => document.querySelector('#recSetup').classList.contains('hide'), null, 10000, 'rec setup closed');
  await sleep(2500);
  if (await ops.evaluate(() => window.__rec().recording())) throw new Error('접속만으로 녹화되면 안 됨');
  log('접속 → 녹화 대기(자동 녹화 안 함):', (await ops.evaluate(() => document.querySelector('#rec-live').textContent)).slice(0, 30));
  await ops.click('.recb:visible');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide') && window.__rec().recording(), null, 10000, 'gap recording after 녹화 시작');
  await waitFor(ops, () => document.querySelector('#sw-host').checked, null, 30000, 'recorder took host');
  log('ops 운영A in: folder set → 「녹화 시작」 → 대기 녹화, host taken');
  // 다른 운영진: 저장 폴더 건너뛰기 → 이 PC는 녹화 안 함, 녹화 PC 안내
  const opsB = await mk('opsB');
  await opsB.goto(BASE + '/b/o.html?r=test');
  await opsB.fill('#g-name', '운영B'); await opsB.fill('#g-code', 'o1234'); await opsB.click('#g-btn');
  await opsB.waitForSelector('#recSetup:not(.hide)', { timeout: 15000 });
  await opsB.click('#rs-skip');
  await waitFor(opsB, () => document.querySelector('#recSetup').classList.contains('hide') && /이 PC는 녹화하지 않습니다/.test(document.querySelector('#rec-warn').textContent) && /운영A/.test(document.querySelector('#rec-warn').textContent), null, 15000, 'skip folder');
  if (await opsB.evaluate(() => window.__rec() && window.__rec().recording())) throw new Error('skipped PC should not record');
  log('운영B 저장 폴더 건너뛰기 →', await opsB.evaluate(() => document.querySelector('#rec-warn').textContent));
  await opsB.click('.recb:visible');
  await waitFor(opsB, () => !document.querySelector('#recSetup').classList.contains('hide'), null, 5000, 'rec setup again');
  await opsB.click('#rs-skip');
  await opsB.context().close();
  // 명단 카드·미접속 알림(학생가: 대기실 접속 시각 지남)
  await waitFor(ops, () => document.querySelectorAll('#w-grid .wt[data-id^="S_"]').length >= 4, null, 15000, 'roster tiles');
  // 대기실 접속 시각이 지난 미접속 학생 → 칸 테두리 빨강(예전 「미접속」 팝업 대신)
  await waitFor(ops, () => { const t = document.querySelector('#w-grid .wt[data-id="S_학생가"]'); return t && t.classList.contains('late') && t.classList.contains('info'); }, null, 15000, 'late tile');
  if (await ops.evaluate(() => !!document.querySelector('.al.absent'))) throw new Error('미접속 팝업은 없어야 함');
  log('학생가: 대기실 접속 시각 지남 → 빨간 테두리 정보 칸(팝업 없음)');
  await SHOT(ops, 'ops_popups');
  await sleep(2500);
  if (await ops.evaluate(() => { const a = document.querySelector('#alerts'); return !!(a && a.offsetParent) || !!document.querySelector('#alerts .al'); })) throw new Error('알림 팝업은 없어야 함');
  log('no popup alerts on ops screen');
  log('ops roster tiles:', await ops.evaluate(() => document.querySelectorAll('#w-grid .wt[data-id^="S_"]').length), '/ cards hidden:', await ops.evaluate(() => getComputedStyle(document.querySelector('#c-list')).display));
  if (!/010-1111-2222/.test(await text(ops, '#w-grid'))) throw new Error('phones not shown on not-connected tile');
  await SHOT(ops, 'ops_half');
  log('phones shown on cards');

  // 대기실 창 따로 띄우기(같은 로그인 이어받기)
  const [panel] = await Promise.all([ops.context().waitForEvent('page'), ops.click('#b-room')]);
  panel.on('pageerror', e => console.log('[panel pageerror]', e.message));
  await panel.waitForSelector('#s-main:not(.hide)', { timeout: 20000 });
  await waitFor(panel, () => document.querySelectorAll('#w-grid .wt[data-id^="S_"]').length >= 4 && document.body.classList.contains('pmode'), null, 15000, 'panel list');
  log('waiting-room panel window opened & auto-logged in:', await text(panel, '#h-title'));
  // 학생 정보 칸: 오른쪽 위 전화 아이콘 → 학생·보호자 번호 팝업(Ver.2.18.3)
  await panel.click('#w-grid .wt[data-id="S_학생가"] [data-tel]');
  await waitFor(panel, () => { const p = document.querySelector('#w-grid .wt[data-id="S_학생가"] .wtelpop'); return p && !p.hidden && /010-1111-2222/.test(p.textContent) && /010-3333-4444/.test(p.textContent); }, null, 5000, 'phone popup');
  await sleep(1500);
  if (await panel.evaluate(() => document.querySelector('#w-grid .wt[data-id="S_학생가"] .wtelpop').hidden)) throw new Error('전화 팝업이 다시 그리기로 닫히면 안 됨');
  await SHOT(panel, 'panel_phone');
  await panel.click('#w-grid .wt[data-id="S_학생가"] [data-tel]');
  log('정보 칸 전화 아이콘 → 학생·보호자 번호 팝업 → 다시 눌러 닫기');
  await waitFor(ops, () => document.body.classList.contains('split') && document.querySelector('#c-list').offsetParent === null && document.querySelector('#c-stage').getBoundingClientRect().width > innerWidth * 0.9, null, 5000, 'main window full-width video');
  log('main window: waiting room moved out → video uses full width:', await ops.evaluate(() => Math.round(document.querySelector('#c-stage').getBoundingClientRect().width) + '/' + innerWidth));

  // 멘토
  await mentor.goto(BASE + '/b/m.html?r=test');
  await SHOT(mentor, 'mentor_gate');
  await mentor.fill('#g-name', '정은영'); await mentor.fill('#g-code', 'm1234'); await mentor.click('#g-btn');
  await mentor.waitForSelector('#c-btn:not([disabled])', { timeout: 15000 });
  await mentor.click('#c-btn');
  log('mentor in');

  // 연구원: 화면 등장(스페이스로 말하기)
  await res.goto(BASE + '/b/o.html?r=test');
  await res.click('.seg label:nth-child(2)');
  await res.fill('#g-name', '연구원A'); await res.fill('#g-code', 'r1234'); await res.click('#g-btn');
  await res.waitForSelector('#s-main:not(.hide)');
  if (await res.isVisible('#b-rec') || await res.isVisible('#w-rec') || await res.isVisible('#chatForm')) throw new Error('research should not see recording/chat send');
  await sleep(1200); await SHOT(res, 'research_empty');
  if (await res.isVisible('#b-stage')) throw new Error('화면 등장 버튼은 없어야 함(멘토링실은 멘토·학생만)');
  if (!(await res.isVisible('#b-join'))) throw new Error('연구원: 멘토링실 들어가기 버튼');
  log('research: 큰 화면 등장 없음, 「멘토링실 들어가기」 버튼 있음');
  await res.close();

  // 학생 A: 이름+생년월일 → 유의사항 → 카메라 → 대기실
  // 학생 입장 시간: 멘토링 당일 첫 학생 시작 30분 전부터 — 3회차(12/6) 학생은 지금 들어올 수 없음
  {
    const sx = await mk('stuEarly', { width: 390, height: 760 });
    await sx.goto(BASE + '/b/');
    await sx.fill('#g-name', '홍길동'); await sx.fill('#g-birth', '20140505'); await sx.check('#g-agree'); await sx.click('#g-btn');
    await waitFor(sx, () => /멘토링 시간이 아닙니다/.test(document.querySelector('#g-err').textContent), null, 15000, 'not mentoring time');
    const msg = await text(sx, '#g-err');
    if (!/12월 6일\(일\)/.test(msg) || !/오후 5:00부터/.test(msg)) throw new Error('입장 시간 안내 문구: ' + msg);
    log('입장 시간 전 학생 →', msg);
    await SHOT(sx, 'stu_not_time');
    await sx.context().close();
  }
  async function studentIn(p, name, birth, wrongFirst) {
    await p.goto(BASE + '/b/');
    if (wrongFirst) await SHOT(p, 'stu_gate');
    if (wrongFirst) {
      await p.fill('#g-name', name); await p.fill('#g-birth', '20000101'); await p.check('#g-agree'); await p.click('#g-btn');
      await p.waitForFunction(() => document.querySelector('#g-err').textContent.includes('생년월일'));
      log('wrong birth rejected');
    }
    await p.fill('#g-name', name); await p.fill('#g-birth', birth); await p.check('#g-agree'); await p.click('#g-btn');
    if (await p.isVisible('#rules.on')) throw new Error('유의사항 카드가 나오면 안 됨');
    await p.waitForSelector('#c-btn:not([disabled])', { timeout: 15000 });
    if (wrongFirst) { await sleep(800); await SHOT(p, 'stu_check'); }
    await p.click('#c-btn');
    await p.waitForSelector('#room.on');
  }
  await studentIn(sA, '학생가', '20140101', true);
  await sA.screenshot({ path: path.join(OUT, '1_student_room.png') });
  log('student A in room:', (await text(sA, '#sched')).replace(/\s+/g, ' '));
  await studentIn(sB, '학생나', '150202');   // 6자리 생년월일도 허용
  log('student B in room (6-digit birth)');
  await studentIn(sC, '학생다', '20160303');

  // 대기실 화상: 학생끼리·운영진과 얼굴 보기(가짜 SFU)
  const vids = (p, sel) => p.evaluate(s => [...document.querySelectorAll(s + ' .wt')].map(t => t.querySelector('.wnm').textContent + ':' + (t.querySelector('video').videoWidth || 0)), sel);
  await waitFor(sA, () => [...document.querySelectorAll('#wgrid .wt')].filter(t => !t.classList.contains('me') && t.querySelector('video').videoWidth > 0).length >= 2, null, 60000, 'A sees B, C video');
  log('student A waiting-room video:', (await vids(sA, '#wgrid')).join(', '));
  await waitFor(panel, () => [...document.querySelectorAll('#w-grid .wt')].filter(t => t.querySelector('video').videoWidth > 0).length >= 3, null, 60000, 'panel sees 3 students');
  log('ops panel waiting-room video:', (await vids(panel, '#w-grid')).join(', '));
  const micA = await sA.evaluate(() => document.querySelector('#w-mic').textContent);
  if (!/켜짐/.test(micA)) throw new Error('student mic should be on in waiting room');
  await waitFor(sC, () => [...document.querySelectorAll('#wgrid .wz.top .wt.staff')].some(t => /운영진/.test(t.textContent)), null, 30000, 'staff on top (camera off)');
  log('student C: 위 운영진 칸(카메라 꺼도 이름 칸), 아래 학생:', await sC.evaluate(() => [...document.querySelectorAll('#wgrid .wz.bot .wt .wnm')].map(e => e.textContent).join(', ')));
  // 운영진 카메라 켜기 → 학생 화면에 「운영진 운영A」
  await panel.click('#w-camb');
  await waitFor(sC, () => [...document.querySelectorAll('#wgrid .wt.staff')].some(t => /운영진/.test(t.textContent) && t.querySelector('video').videoWidth > 0), null, 40000, 'student sees ops cam');
  log('ops camera on → student C sees staff tile');
  await SHOT(sC, 'stu_waitroom_wide'); await SHOT(sA, 'stu_waitroom_phone'); await SHOT(panel, 'panel_waitroom');
  // 운영진이 학생 C 마이크 끄기(두 번 누름)
  await panel.evaluate(() => { const t = [...document.querySelectorAll('#w-grid .wt')].find(t => /학생다/.test(t.textContent)); const b = t.querySelector('.wmute'); b.click(); b.click(); });
  await waitFor(sC, () => /꺼짐/.test(document.querySelector('#w-mic').textContent), null, 20000, 'student C muted by ops');
  log('ops muted student C → C mic:', await sC.evaluate(() => document.querySelector('#w-mic').textContent));
  await sC.click('#w-mic');
  await panel.click('#w-camb');
  // 스페이스바로 말하기(운영진)
  const staffMicOff = () => { const t = [...document.querySelectorAll('#wgrid .wz.top .wt.staff')].find(t => /운영/.test(t.textContent)); return t && !t.querySelector('.wmo').hidden; };
  await waitFor(sC, staffMicOff, null, 20000, 'staff mic off before space');
  await panel.keyboard.down('Space');
  await waitFor(panel, () => document.querySelector('#w-open').classList.contains('down'), null, 5000, 'ptt down by space');
  await waitFor(sC, () => !(() => { const t = [...document.querySelectorAll('#wgrid .wz.top .wt.staff')].find(t => /운영/.test(t.textContent)); return t && !t.querySelector('.wmo').hidden; })(), null, 20000, 'student sees staff talking (space)');
  await panel.keyboard.up('Space');
  await waitFor(sC, staffMicOff, null, 20000, 'staff mic off after space up');
  if (await panel.evaluate(() => document.querySelector('#w-camb').classList.contains('on'))) throw new Error('space should not press buttons');
  log('ops Space held → 대기실에 말하기, 떼면 끔');
  // 학생 마이크 모두 끄기·켜기
  await waitFor(panel, () => /모두 끄기/.test(document.querySelector('#w-mall').textContent), null, 10000, 'mall button');
  await panel.click('#w-mall');
  await waitFor(sC, () => /운영진이 꺼 둠/.test(document.querySelector('#w-mic').textContent), null, 20000, 'C all-muted');
  await waitFor(sA, () => /꺼짐|꺼 둠/.test(document.querySelector('#w-mic').innerHTML) && document.querySelector('#w-mic').classList.contains('off'), null, 20000, 'A all-muted');
  await sC.click('#w-mic');
  if (!(await sC.evaluate(() => document.querySelector('#w-mic').classList.contains('off')))) throw new Error('locked mic should stay off');
  await waitFor(panel, () => /모두 켜기/.test(document.querySelector('#w-mall').textContent), null, 10000, 'mall on state');
  await panel.click('#w-mall');
  await waitFor(sC, () => /켜짐/.test(document.querySelector('#w-mic').textContent), null, 20000, 'C unmuted');
  await waitFor(sA, () => !document.querySelector('#w-mic').classList.contains('off'), null, 20000, 'A unmuted');
  log('학생 마이크 모두 끄기 → A·C 꺼짐(학생이 켜지 못함) → 모두 켜기 → 다시 켜짐');
  const lay = await panel.evaluate(() => { const z = document.querySelector('#w-grid .wz.bot'), t = document.querySelector('#w-grid .wz.top'); return { cols: getComputedStyle(z).gridTemplateColumns.split(' ').length, topRows: new Set([...t.children].map(c => Math.round(c.getBoundingClientRect().top))).size }; });
  if (lay.cols !== Math.min(4, await panel.evaluate(() => document.querySelectorAll('#w-grid .wz.bot .wt').length)) || lay.topRows > 1) throw new Error('layout: ' + JSON.stringify(lay));
  log('대기실 배치: 학생 한 줄 ' + lay.cols + '명, 운영진 ' + lay.topRows + '줄');
  // 대기실 소리 켬 ↔ 멘토링실 소리 끔(대기실 창 → 녹화 창에도 반영)
  await panel.click('#apill button[data-s="w"]');
  await waitFor(ops, () => { const a = window.__audio(); return !a.mentoring && a.vM; }, null, 5000, 'mentoring muted when waiting on');
  if (!(await panel.evaluate(() => window.__audio().waiting))) throw new Error('waiting room sound should be on');
  await panel.click('#apill button[data-s="m"]');
  await waitFor(ops, () => { const a = window.__audio(); return a.mentoring && !a.vM; }, null, 5000, 'mentoring sound back');
  if (await panel.evaluate(() => window.__audio().waiting)) throw new Error('waiting room sound should be off');
  log('대기실 소리 켬 → 녹화 창 멘토링실 소리 꺼짐, 대기실 소리 끔 → 멘토링실 소리 켜짐');

  // 대기실 채팅·공지
  if (await sA.evaluate(() => { const c = document.querySelector('.chat'); return !!(c && c.offsetParent); })) throw new Error('채팅은 없어야 함');
  if (await panel.$('#bcForm') || await ops.$('#bcForm')) throw new Error('상단 고정 공지는 없어야 함');
  if (!(await sA.evaluate(() => document.querySelector('#bc').hidden))) throw new Error('학생 화면에 공지 칸이 보이면 안 됨');
  log('no chat, no pinned notice (Ver.2.18)');
  await sA.screenshot({ path: path.join(OUT, '2_student_chat.png') });

  // 연결 점검 + 다음 차례 미리 연결
  await waitFor(sA, () => document.querySelector('#w-test').textContent.includes('완료'), null, 40000, 'test A');
  await waitFor(sA, () => document.querySelector('#w-warm').textContent.includes('준비 완료'), null, 40000, 'A warm');
  log('student A tested & prewarmed; status:', (await text(sA, '#status')).replace(/\s+/g, ' ').slice(0, 40));
  await waitFor(panel, () => document.querySelector('#w-grid .wt.due[data-id="S_학생가"] .wa.due'), null, 15000, 'due tile');
  // 접속한 학생 칸: 아래에 멘토링 시간 + 알림(띵동) 버튼
  const bar = await panel.evaluate(() => (document.querySelector('#w-grid .wt[data-id="S_학생다"] .wbt') || {}).textContent || '');
  if (!/멘토링 \d/.test(bar) || !/알림/.test(bar)) throw new Error('connected tile should show mentoring time + 알림: ' + bar);
  await panel.click('#w-grid .wt[data-id="S_학생다"] [data-ring]');
  await waitFor(sC, () => (window.__rings || 0) >= 1, null, 20000, 'student C rung');
  log('connected tile bar:', bar.replace(/\s+/g, ' '), '→ 알림 → student C 띵동');
  log('ops due tile (시작 깜빡임) for 학생가');
  await ops.screenshot({ path: path.join(OUT, '3_ops_waiting.png') });
  await panel.screenshot({ path: path.join(OUT, '3_panel.png') });

  // 대기 녹화를 멈춘 상태에서도 멘토링은 자동 녹화
  await ops.click('.recb:visible');
  await waitFor(ops, () => !window.__rec().recording(), null, 15000, 'gap recording stopped');
  log('운영자 「녹화 중지」 → 대기 녹화 멈춤');
  // 대기실 창에서 시작 → 녹화 창이 녹화
  const t0 = Date.now();
  await panel.click('#w-grid .wt[data-id="S_학생가"] button[data-a="call"]');
  await waitFor(sA, () => !document.querySelector('#s-live').classList.contains('hide') && document.querySelector('#l-remote').videoWidth > 0, null, 30000, 'A live');
  log('started from panel window → student A live after', Date.now() - t0, 'ms');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide'), null, 20000, 'recording');
  await waitFor(ops, () => window.__rec().recording() && /학생가/.test(window.__rec().health().name), null, 20000, 'student file');
  if (!(await ops.evaluate(() => document.querySelector('#b-rec').classList.contains('lock')))) throw new Error('멘토링 중에는 녹화 버튼이 잠겨야 함');
  await ops.click('.recb:visible'); await sleep(800);
  if (!(await ops.evaluate(() => window.__rec().recording()))) throw new Error('멘토링 중 녹화 버튼을 눌러도 녹화는 계속되어야 함');
  log('recording started on host window (대기 녹화 꺼져 있어도 멘토링은 자동 녹화, 중지 버튼 잠김):', await ops.evaluate(() => window.__rec().health().name));
  // 연구원 멘토링실 참여(멘토링 중): 멘토 화면에 작게, 마이크 켜면 학생 화면에 작게 + 소리, 녹화에도
  const res2 = await mk('research2');
  await res2.goto(BASE + '/b/o.html?r=test');
  await res2.click('.seg label:nth-child(2)');
  await res2.fill('#g-name', '연구원B'); await res2.fill('#g-code', 'r1234'); await res2.click('#g-btn');
  await res2.waitForSelector('#s-main:not(.hide)');
  await res2.click('#b-join');
  await waitFor(res2, () => !document.querySelector('#b-smic').classList.contains('hide'), null, 15000, 'research joined room');
  await waitFor(mentor, () => { const v = document.querySelector('#m-rp .rpip video'); return v && v.videoWidth > 0; }, null, 40000, 'mentor sees research pip');
  log('연구원 멘토링실 들어감 → 멘토 화면 왼쪽 위 작은 화면(멘토 본인 화면과 함께)');
  await waitFor(sA, () => { const c = document.querySelector('#l-rp .rpip'); return c && c.classList.contains('off'); }, null, 30000, 'student has hidden research pip');
  await res2.keyboard.down('Space');
  await waitFor(sA, () => { const c = document.querySelector('#l-rp .rpip:not(.off)'); return c && c.querySelector('video').videoWidth > 0 && c.querySelector('video').srcObject.getAudioTracks().length; }, null, 20000, 'student sees research when mic on');
  await waitFor(mentor, () => !!document.querySelector('#m-rp .rpip.talk'), null, 20000, 'mentor sees research talking');
  log('연구원 스페이스바(마이크 켬) → 학생 화면 왼쪽 위에 연구원 작은 화면 + 소리, 멘토 화면 초록 테두리');
  await SHOT(sA, 'stu_live_research'); await SHOT(mentor, 'mentor_live_research'); await SHOT(res2, 'research_live_room'); await SHOT(ops, 'ops_live_research');
  await res2.keyboard.up('Space');
  await waitFor(sA, () => { const c = document.querySelector('#l-rp .rpip'); return c && c.classList.contains('off'); }, null, 20000, 'student hides research when mic off');
  await waitFor(ops, () => window.__rec().pips.length >= 1, null, 20000, 'recording includes research pip');
  log('마이크 끔 → 학생 화면에서 숨김, 녹화에는 연구원 작은 화면·소리 포함');
  await res2.click('#b-join');
  await waitFor(mentor, () => !document.querySelector('#m-rp .rpip'), null, 20000, 'research left room');
  await res2.context().close();   // 시험 PC 부담 줄이기
  log('연구원 「멘토링실에서 나가기」 → 멘토 화면에서 사라짐');
  // 운영진도 멘토링 참여(Ver.2.18): 녹화 PC의 운영진이 들어가면 멘토 화면에 작게 + 녹화에 본인도 포함
  await ops.click('#b-join:visible');
  await waitFor(mentor, () => { const v = document.querySelector('#m-rp .rpip video'); return v && v.videoWidth > 0; }, null, 40000, 'mentor sees ops pip');
  await waitFor(ops, () => window.__rec().pips.some(p => /운영/.test(p.label)), null, 20000, 'recording includes ops self');
  await SHOT(ops, 'ops_joined');
  await ops.click('#b-join:visible');
  await waitFor(mentor, () => !document.querySelector('#m-rp .rpip'), null, 20000, 'ops left room');
  log('운영진 「멘토링 참여」 → 멘토 화면에 작게 + 녹화에 본인 포함 → 다시 눌러 나가기');
  // 안정성: 서버 캐시가 통째로 비워져도(구글 캐시 축출) 진행 상태·접속이 이어지는지
  const ev = await (await fetch(BASE + '/__evict')).json();
  await sleep(6000);
  if (!/학생가/.test(await text(ops, '#c-name'))) throw new Error('cache evict: 진행 중 학생이 사라짐');
  if (await sA.evaluate(() => document.querySelector('#s-live').classList.contains('hide'))) throw new Error('cache evict: 학생 멘토링 화면에서 빠짐');
  await waitFor(sC, () => [...document.querySelectorAll('#wgrid .wt')].filter(t => !t.classList.contains('me') && t.querySelector('video').videoWidth > 0).length >= 1, null, 40000, 'waiting room video after evict');
  log('서버 캐시 비움(' + ev.evicted + '개) → 진행 중 학생·멘토링·대기실 화상 그대로 이어짐');
  if (process.env.SHOTS) { await SHOT(ops, 'ops_popup_start'); await ops.evaluate(() => { window.__tShift = 9 * 60000 + 5000; }); await sleep(1200); await SHOT(ops, 'ops_last1min'); await SHOT(panel, 'panel_last1min'); await ops.evaluate(() => { window.__tShift = 0; }); await ops.setViewportSize({ width: 1920, height: 1080 }); await sleep(1500); await SHOT(ops, 'ops_1920'); await ops.setViewportSize({ width: 1600, height: 950 }); }
  if (process.env.SHOTS) { await sleep(2500); await SHOT(sA, 'stu_live'); await SHOT(ops, 'ops_live'); await SHOT(mentor, 'mentor_live'); await SHOT(sB, 'stu_next'); await SHOT(panel, 'panel_live'); }
  await SHOT(ops, 'ops_split');
  await panel.close();
  await waitFor(ops, () => !document.body.classList.contains('split') && document.querySelector('#c-chat').offsetParent !== null, null, 5000, 'panel closed → waiting room back');
  log('panel window closed → waiting room back in main window');
  await sleep(1500); await SHOT(ops, 'ops_full_live');
  if (process.env.SHOTS) { await ops.click('#b-set2:visible, #b-set:visible'); await sleep(600); await SHOT(ops, 'ops_settings'); await ops.click('#b-set2:visible, #b-set:visible'); }
  await sleep(4000);

  // 다음 학생
  await waitFor(sB, () => document.querySelector('#w-warm').textContent.includes('준비 완료'), null, 30000, 'B warm');
  const tB = Date.now();
  await ops.click('#b-next');
  await waitFor(sB, () => document.querySelector('#l-remote').videoWidth > 0, null, 30000, 'B live');
  log('student B live after', Date.now() - tB, 'ms');
  await waitFor(sA, () => document.querySelector('#s-end').classList.contains('on'), null, 15000, 'A done → end screen');
  const camA = await sA.evaluate(() => [...document.querySelectorAll('video')].some(v => v.srcObject && v.srcObject.getTracks().some(t => t.readyState === 'live' && t.kind === 'video' && !t.remote)));
  log('student A: 멘토링 끝 → 안내 후 바로 퇴장 (end screen, live local camera:', camA, ')');
  await waitFor(sC, () => ![...document.querySelectorAll('#wgrid .wt')].some(t => /학생가/.test(t.textContent)), null, 20000, 'A gone from waiting room');
  log('student A no longer in C\'s waiting-room video');
  await SHOT(sA, 'stu_done');
  await sleep(3000);
  await ops.click('#b-end'); await ops.click('#b-end');
  try { await waitFor(ops, () => [...document.querySelectorAll('#rec-files li')].filter(li => li.textContent.includes('자동 저장')).length >= 3, null, 30000, 'auto-saved'); }
  catch (e) { await ops.screenshot({ path: path.join(OUT, 'dbg_ops_end.png') }); log('DIAG files:', await ops.evaluate(() => document.querySelector('#rec-files').innerText + ' | cur:' + document.querySelector('#c-name').textContent)); throw e; }
  await sleep(2500);
  if (await ops.evaluate(() => window.__rec().recording())) throw new Error('대기 녹화를 꺼 두었으면 멘토링 뒤 녹화 멈춤이어야 함');
  await ops.click('.recb:visible');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide') && window.__rec().recording(), null, 10000, 'gap recording after 녹화 시작 again');
  log('멘토링 끝 → 녹화 멈춤(대기 녹화 꺼 둠) → 「녹화 시작」 → 대기 녹화');
  const names = await ops.evaluate(() => [...document.querySelectorAll('#rec-files li span:first-child')].map(x => x.textContent));
  log('auto-saved:', names.join(' | '));
  if (!names.some(n => /^\d{6}_\d{4}_리허설_대기/.test(n))) throw new Error('no gap file');
  if (!names.every(n => /^\d{6}_\d{4}_/.test(n))) throw new Error('file name must start with YYMMDD_HHMM');
  log('student files + 대기 file saved, recording continues after last student');
  const vinfo = await ops.evaluate(async () => {
    const dir = await navigator.storage.getDirectory(); const out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue;
      if (!/\.(webm|mp4)$/.test(name)) continue;
      const f = await h.getFile(); if (!f.size) continue;   // 아직 녹화 중인 파일(닫히기 전 0바이트)
      const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(f);
      await new Promise(r => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 5000); });
      v.currentTime = 2; await new Promise(r => { v.onseeked = r; setTimeout(r, 3000); });
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
      out.push({ name, w: v.videoWidth, h: v.videoHeight, mb: +(f.size / 1e6).toFixed(1), png: c.toDataURL('image/png') });
    }
    return out;
  });
  vinfo.forEach(x => { log('recording file:', x.name, x.w + 'x' + x.h, x.mb + 'MB'); if (x.w < 1920 || x.h < 1080) throw new Error('recording below FHD'); });
  if (vinfo[0]) fs.writeFileSync(path.join(OUT, 's_rec_frame.png'), Buffer.from(vinfo[0].png.split(',')[1], 'base64'));


  // 학생 새로고침: 다시 입력 없이 카메라 확인부터
  await sC.reload();
  await sC.waitForSelector('#c-btn:not([disabled])', { timeout: 20000 });
  await sC.click('#c-btn');
  await sC.waitForSelector('#room.on');
  await waitFor(sC, () => document.querySelectorAll('#wgrid .wt').length >= 1 && document.querySelector('#wgrid .wt.me'), null, 30000, 'C waiting video after reload');
  log('student C reload → skipped login/rules, back in room (waiting-room video back)');

  // 회차 자동: 주소에 회차 없이 들어오면 날짜에 맞는 회차(오늘 11/16 → 2회차 11/21)
  const m2 = await mk('mentor-auto');
  await m2.goto(BASE + '/b/m.html');
  if (!(await m2.isVisible('#g-rrow')) || await m2.isVisible('#g-room')) throw new Error('auto room row not shown');
  if (await m2.getAttribute('#g-name', 'placeholder')) throw new Error('name placeholder still there');
  await SHOT(m2, 'mentor_gate_auto');
  await m2.fill('#g-name', '정은영'); await m2.fill('#g-code', 'm1234'); await m2.click('#g-btn');
  await m2.waitForSelector('#s-check:not(.hide)', { timeout: 15000 });
  const autoR = new URL(m2.url()).searchParams.get('r');
  log('mentor without 회차 → auto room:', autoR);
  if (autoR !== '2') throw new Error('auto room wrong: ' + autoR);
  // ── 녹화 안전장치 ──
  // ① 소리가 막힌 상태(브라우저 자동재생 제한)여도 재생되는 파일: 영상만 녹화 → 클릭하면 소리 포함 새 파일
  await ops.evaluate(async () => { const ac = window.__rec().ac; window.__acResume = ac.resume.bind(ac); ac.resume = () => Promise.resolve(); await ac.suspend(); window.__rec().stop(); });   // 자동재생 제한 흉내(클릭 전에는 소리가 안 풀림)
  await sleep(3500);
  const blocked = await ops.evaluate(() => ({ audio: window.__rec().recAudio, live: document.querySelector('#rec-live').textContent }));
  log('audio blocked → recAudio:', blocked.audio, '| status:', blocked.live.slice(0, 40));
  if (blocked.audio) throw new Error('should record video-only while audio is blocked');
  await ops.evaluate(() => { window.__rec().ac.resume = window.__acResume; });
  await ops.mouse.click(300, 900); await sleep(3500);
  const unblocked = await ops.evaluate(() => window.__rec().recAudio);
  log('after a click → recAudio:', unblocked);
  if (!unblocked) throw new Error('should restart with audio after click');
  // ② 창이 갑자기 닫혀도: 예비 사본(OPFS)에서 다음 접속 때 폴더로 복구
  await sleep(3000);
  const bkSize = await ops.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('karts-rec-backup'); let n = 0; for await (const [k, h] of d.entries()) n += (await h.getFile()).size; return n; });
  log('backup copy size while recording:', bkSize);
  if (!bkSize) throw new Error('no backup data');
  const octx = ops.context();
  await ops.close();   // 창을 그냥 닫음(저장 단계 없이)
  const ops2 = await octx.newPage();
  await ops2.goto(BASE + '/b/o.html?r=test');
  await ops2.fill('#g-name', '운영A'); await ops2.fill('#g-code', 'o1234'); await ops2.click('#g-btn');
  await ops2.waitForSelector('#recSetup:not(.hide)', { timeout: 15000 });
  await ops2.evaluate(async () => window.__setRecDir(await navigator.storage.getDirectory()));
  const crashed = await ops2.evaluate(async () => { const r = await navigator.storage.getDirectory(); for await (const [k, h] of r.entries()) if (h.kind === 'file' && !/crswap/.test(k) && !(await h.getFile()).size) return k; return ''; }).catch(() => '');
  await waitFor(ops2, async (n) => { const r = await navigator.storage.getDirectory(); for await (const [k, h] of r.entries()) if (h.kind === 'file' && k === n && (await h.getFile()).size) return true; return false; }, crashed, 20000, 'recovered in place');
  log('crashed file (was 0 bytes):', crashed, '→ recovered in place');
  const all = await ops2.evaluate(async () => {
    const dir = await navigator.storage.getDirectory(), out = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file') continue;
      const f = await h.getFile(); if (!f.size) { out.push({ name, size: 0 }); continue; }
      const v = document.createElement('video'); v.muted = true; v.src = URL.createObjectURL(f);
      await new Promise(r => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 6000); });
      out.push({ name, size: f.size, w: v.videoWidth, h: v.videoHeight, err: v.error ? v.error.code : 0 });
    }
    return out;
  });
  all.forEach(f => log('file:', f.name, (f.size / 1e6).toFixed(1) + 'MB', f.w + 'x' + f.h, f.err ? 'ERROR ' + f.err : 'plays'));
  const broken = all.filter(f => f.size && (f.err || f.w !== 1920));
  if (broken.length) throw new Error('unplayable recordings: ' + broken.map(f => f.name).join(', '));
  const cur2 = await ops2.evaluate(() => (window.__rec().health() || {}).name || '');
  const empty = all.filter(f => !f.size && !/crswap/.test(f.name) && f.name !== cur2);
  if (empty.length) throw new Error('empty files left: ' + empty.map(f => f.name).join(', '));
  log('crash recovery OK — all saved recordings play at 1920x1080');

  console.log(JSON.stringify((await (await fetch(BASE + '/__stats')).json()).chat).slice(0, 600));
  await browser.close();
})().catch(async e => { console.error('FAIL', e); try { for (const p of (global.__pages || [])) await p.screenshot({ path: path.join(OUT, 'fail_' + (global.__pages.indexOf(p)) + '.png') }); } catch (er) {} process.exit(1); });
