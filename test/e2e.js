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
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  const mk = async (name, vp) => {
    const c = await browser.newContext({ viewport: vp || { width: 1600, height: 950 }, acceptDownloads: true, permissions: ['camera', 'microphone'] });
    const p = await c.newPage(); (global.__pages = global.__pages || []).push(p);
    p.on('pageerror', e => console.log(`[${name} pageerror]`, e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`[${name} console]`, m.text()); });
    return p;
  };
  global.__pages = [];
  const ops = await mk('ops'), mentor = await mk('mentor'), res = await mk('research'), sA = await mk('stuA', { width: 420, height: 860 }), sB = await mk('stuB', { width: 420, height: 860 });

  // 운영진(녹화 창)
  await ops.goto(BASE + '/b/o.html?r=test');
  await SHOT(ops, 'ops_gate');
  await ops.fill('#g-name', '운영A'); await ops.fill('#g-code', 'o1234'); await ops.click('#g-btn');   // 운영진은 모두 자동 녹화
  await ops.waitForSelector('#s-main:not(.hide)');
  await ops.waitForSelector('#recSetup:not(.hide)', { timeout: 10000 });
  await sleep(500); await SHOT(ops, 'ops_recsetup');
  await ops.evaluate(async () => window.__setRecDir(await navigator.storage.getDirectory()));   // 폴더 선택 창 대신(시험용)
  await waitFor(ops, () => document.querySelector('#recSetup').classList.contains('hide') && !document.querySelector('#h-rec').classList.contains('hide'), null, 10000, 'gap recording on login');
  await waitFor(ops, () => document.querySelector('#sw-host').checked, null, 15000, 'recorder took host');
  log('ops 운영A in: folder set → recording from login (대기), host taken');
  // 명단 카드·미접속 알림(학생가: 대기실 접속 시각 지남)
  await waitFor(ops, () => document.querySelectorAll('#list .st').length >= 4, null, 15000, 'roster cards');
  await waitFor(ops, () => /학생가/.test(document.querySelector('#alerts').textContent) && document.querySelector('.al.absent'), null, 15000, 'absent alert');
  await SHOT(ops, 'ops_popups');
  log('top popup alerts:', await ops.evaluate(() => [...document.querySelectorAll('#alerts .al')].map(e => e.className).join(' | ')));
  await sleep(13000);
  const left = await ops.evaluate(() => [...document.querySelectorAll('#alerts .al')].filter(e => /absent|due/.test(e.className)).length);
  log('after 13s, absent/due popups left:', left);
  if (left) throw new Error('popups should disappear');
  log('ops cards:', await ops.evaluate(() => document.querySelectorAll('#list .st').length), '/ alerts:', (await text(ops, '#alerts')).slice(0, 80));
  if (!/010-1111-2222/.test(await text(ops, '#list'))) throw new Error('phones not shown');
  log('phones shown on cards');

  // 대기실 창 따로 띄우기(같은 로그인 이어받기)
  const [panel] = await Promise.all([ops.context().waitForEvent('page'), ops.click('#b-room')]);
  panel.on('pageerror', e => console.log('[panel pageerror]', e.message));
  await panel.waitForSelector('#s-main:not(.hide)', { timeout: 20000 });
  await waitFor(panel, () => document.querySelectorAll('#list .st').length >= 4 && document.body.classList.contains('pmode'), null, 15000, 'panel list');
  log('waiting-room panel window opened & auto-logged in:', await text(panel, '#h-title'));
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
  if (await res.isVisible('#p-rec') || await res.isVisible('#chatForm')) throw new Error('research should not see recording/chat send');
  await sleep(1200); await SHOT(res, 'research_empty');
  await res.click('#b-stage');
  await waitFor(mentor, () => { const v = document.querySelector('#g-stage video'); return v && v.videoWidth > 0; }, null, 30000, 'mentor sees researcher');
  log('mentor sees researcher on stage');
  await sleep(1500); await SHOT(mentor, 'mentor_stage'); await SHOT(res, 'research');
  { const png = await ops.evaluate(() => window.__recFrame()); if (png) fs.writeFileSync(path.join(OUT, 's_rec_gap_stage.png'), Buffer.from(png.split(',')[1], 'base64')); }
  if (!(await res.isVisible('#b-stoff'))) throw new Error('화면 끄기 not shown');
  const micOnStage = await res.evaluate(() => document.querySelector('#h-talk').textContent);
  log('research on stage — mic:', micOnStage);
  if (!/켜짐/.test(micOnStage)) throw new Error('mic should be on when appearing');
  await res.click('#b-stoff');
  await waitFor(res, () => !document.querySelector('#b-stage').classList.contains('hide') && document.querySelector('#st-ctrls').classList.contains('hide'), null, 10000, 'back to waiting view');
  log('화면 끄기 → back to next-student waiting view with 화면 등장 button');
  await res.close();

  // 학생 A: 이름+생년월일 → 유의사항 → 카메라 → 대기실
  async function studentIn(p, name, birth, wrongFirst) {
    await p.goto(BASE + '/b/');
    if (wrongFirst) await SHOT(p, 'stu_gate');
    if (wrongFirst) {
      await p.fill('#g-name', name); await p.fill('#g-birth', '20000101'); await p.check('#g-agree'); await p.click('#g-btn');
      await p.waitForFunction(() => document.querySelector('#g-err').textContent.includes('생년월일'));
      log('wrong birth rejected');
    }
    await p.fill('#g-name', name); await p.fill('#g-birth', birth); await p.check('#g-agree'); await p.click('#g-btn');
    await p.waitForSelector('#rules.on', { timeout: 15000 });
    if (wrongFirst) { await sleep(500); await SHOT(p, 'stu_rules0'); await p.click('#rNext'); await sleep(500); await SHOT(p, 'stu_rules1'); }
    for (let i = 0; i < 10 && await p.isVisible('#rules.on'); i++) await p.click('#rNext');
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

  // 대기실 채팅·공지
  await sA.fill('#text', '안녕하세요 학생가입니다'); await sA.click('#sendBtn');
  await waitFor(panel, () => /학생가입니다/.test(document.querySelector('#msgs').textContent), null, 15000, 'panel sees student chat');
  await panel.fill('#chatText', '반가워요! 운영진입니다'); await panel.click('#chatForm button');   // 대기실을 새 창으로 뺐으므로 채팅은 대기실 창에서
  await waitFor(sB, () => /운영진입니다/.test(document.querySelector('#msgs').textContent) && /운영진/.test(document.querySelector('#msgs .m.o .who').textContent), null, 15000, 'student sees ops chat');
  await panel.fill('#bcText', '앞 순서가 조금 늦어지고 있어요'); await panel.click('#bcForm button'); await panel.click('#bcForm button');
  await waitFor(sA, () => !document.querySelector('#bc').hidden && /늦어지고/.test(document.querySelector('#bc').textContent), null, 15000, 'student sees bc');
  log('chat + pinned notice ok (student↔ops, panel→students)');
  await sA.screenshot({ path: path.join(OUT, '2_student_chat.png') });

  // 연결 점검 + 다음 차례 미리 연결
  await waitFor(sA, () => document.querySelector('#w-test').textContent.includes('완료'), null, 40000, 'test A');
  await waitFor(sA, () => document.querySelector('#w-warm').textContent.includes('준비 완료'), null, 40000, 'A warm');
  log('student A tested & prewarmed; status:', (await text(sA, '#status')).replace(/\s+/g, ' ').slice(0, 40));
  await waitFor(ops, () => document.querySelector('#list .st.due'), null, 15000, 'due card');
  if (await ops.evaluate(() => document.documentElement.scrollHeight > innerHeight + 2 || document.querySelector('#list').scrollHeight > document.querySelector('#list').clientHeight + 2)) throw new Error('student list does not fit on screen');
  log('student list fits on screen (no scroll)');
  log('ops due alert shown for 학생가');
  await ops.screenshot({ path: path.join(OUT, '3_ops_waiting.png') });
  await panel.screenshot({ path: path.join(OUT, '3_panel.png') });

  // 대기실 창에서 시작 → 녹화 창이 녹화
  const t0 = Date.now();
  await panel.click('#list .st[data-id="S_학생가"] button[data-a="call"]');
  await waitFor(sA, () => !document.querySelector('#s-live').classList.contains('hide') && document.querySelector('#l-remote').videoWidth > 0, null, 30000, 'A live');
  log('started from panel window → student A live after', Date.now() - t0, 'ms');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide'), null, 20000, 'recording');
  log('recording started on host window');
  if (process.env.SHOTS) { await SHOT(ops, 'ops_popup_start'); await ops.evaluate(() => { window.__tShift = 9 * 60000 + 5000; }); await sleep(1200); await SHOT(ops, 'ops_last1min'); await SHOT(panel, 'panel_last1min'); await ops.evaluate(() => { window.__tShift = 0; }); await ops.setViewportSize({ width: 1920, height: 1080 }); await sleep(1500); await SHOT(ops, 'ops_1920'); await ops.setViewportSize({ width: 1600, height: 950 }); }
  if (process.env.SHOTS) { await sleep(2500); await SHOT(sA, 'stu_live'); await SHOT(ops, 'ops_live'); await SHOT(mentor, 'mentor_live'); await SHOT(sB, 'stu_next'); await SHOT(panel, 'panel_live'); }
  await SHOT(ops, 'ops_split');
  await panel.close();
  await waitFor(ops, () => !document.body.classList.contains('split') && document.querySelector('#c-list').offsetParent !== null, null, 5000, 'panel closed → list back');
  log('panel window closed → waiting room back in main window');
  await sleep(4000);

  // 다음 학생
  await waitFor(sB, () => document.querySelector('#w-warm').textContent.includes('준비 완료'), null, 30000, 'B warm');
  const tB = Date.now();
  await ops.click('#b-next');
  await waitFor(sB, () => document.querySelector('#l-remote').videoWidth > 0, null, 30000, 'B live');
  log('student B live after', Date.now() - tB, 'ms');
  await waitFor(sA, () => document.querySelector('#room').classList.contains('on') && document.querySelector('#status').classList.contains('done'), null, 15000, 'A done');
  log('student A back in room with done status (chat still available)');
  await SHOT(sA, 'stu_done');
  await sleep(3000);
  await ops.click('#b-end'); await ops.click('#b-end');
  await waitFor(ops, () => [...document.querySelectorAll('#rec-files li')].filter(li => li.textContent.includes('자동 저장')).length >= 3, null, 30000, 'auto-saved');
  await waitFor(ops, () => !document.querySelector('#h-rec').classList.contains('hide'), null, 10000, 'gap recording resumes after end');
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

  // 채팅 메시지 지우기·전체 지우기
  await ops.click('#clearChat'); await ops.click('#clearChat');
  await waitFor(sA, () => !/학생가입니다/.test(document.querySelector('#msgs').textContent), null, 15000, 'chat cleared on student');
  log('chat cleared → removed on student screen');

  // 학생 새로고침: 다시 입력 없이 카메라 확인부터
  await sB.reload();
  await sB.waitForSelector('#c-btn:not([disabled])', { timeout: 20000 });
  await sB.click('#c-btn');
  await sB.waitForSelector('#room.on');
  log('student B reload → skipped login/rules, back in room');

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
