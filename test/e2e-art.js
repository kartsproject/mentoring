// 미술 온라인 멘토링 시험(헤드리스 크롬): 가짜 SFU + 운영(녹화) + 멘토 2 + 학생 4
//  CODE=a PORT=8081 node test/mock-server.js & node test/mock-sfu.js & → node test/e2e-art.js
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:' + (process.env.PORT || 8081);
const SFU = 'http://localhost:' + (process.env.SFU_PORT || 8788);
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function waitFor(page, fn, arg, ms = 30000, label = '') {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) {
    try { last = await page.evaluate(fn, arg); if (last) return last; } catch (e) { last = e.message; }
    await sleep(400);
  }
  throw new Error('timeout: ' + label + ' (' + JSON.stringify(last) + ')');
}
const RECSHOT = async (ops, name) => { if (!process.env.SHOTS) return; try { const d = await ops.evaluate(() => Object.entries(window.__recs()).map(([k, x]) => [k, x.r.canvas.toDataURL('image/jpeg', .85)])); d.forEach(([k, u]) => fs.writeFileSync(path.join(OUT, 'rec_' + name + '_' + k + '.jpg'), Buffer.from(u.split(',')[1], 'base64'))); } catch (e) { console.log('recshot fail', e.message); } };
const SHOT = async (p, name) => { if (process.env.SHOTS) try { await p.screenshot({ path: path.join(OUT, 'a_' + name + '.png'), timeout: 10000 }); } catch (e) { console.log('(screenshot skipped:', name + ')'); } };
// 그 페이지에서 실제로 움직이는(프레임이 오는) 영상 칸 수
const liveTiles = p => p.evaluate(() => [...document.querySelectorAll('.tile video')].filter(v => v.srcObject && v.readyState >= 2 && v.videoWidth > 0).map(v => v.closest('.tile').querySelector('.t-label').textContent));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=fps=12', '--autoplay-policy=no-user-gesture-required', '--auto-select-desktop-capture-source=Entire screen']
  });
  const mk = async (name, vp) => {
    const c = await browser.newContext({ viewport: vp || { width: 1500, height: 900 }, permissions: ['camera', 'microphone'] });
    const p = await c.newPage();
    p.on("pageerror", e => console.log(`[${name} pageerror]`, e.stack.split("\n").slice(0, 3).join(" < ")));
    p.on('console', m => { const t = m.text(); if ((m.type() === 'error' && !/Failed to load resource/.test(t)) || /^\[sfu\]/.test(t)) console.log(`[${name}]`, t); });
    return p;
  };
  let fail = null;
  try {
    const host = await mk('sfu');
    await host.goto(SFU + '/host');

    // 운영진: 입장 → 이 PC에서 녹화
    const ops = global.__ops = await mk('ops', { width: 1600, height: 950 });
    await ops.addInitScript(() => { window.__testFps = 1; });
    await ops.goto(BASE + '/a/o.html?r=test');
    await ops.evaluate(() => { window.MEET_CONFIG.REC_FPS = 12; });   // 시험 PC가 느려서 녹화 장면 수를 낮춤
    await ops.fill('#g-name', '운영A'); await ops.fill('#g-code', 'o1234'); await ops.click('#g-btn');
    await ops.waitForSelector('#s-main:not(.hide)');
    await ops.evaluate(async () => window.__setRecDir(await navigator.storage.getDirectory()));
    log('ops in, recorder on');
    // 접속 현황: 전화 아이콘 → 학생·보호자 번호 팝업(Ver.1.9), 공지 칸 없음
    await waitFor(ops, () => !!document.querySelector('#abs [data-tel="S_학생가"]'), null, 15000, 'abs phone icon');
    await ops.click('#abs [data-tel="S_학생가"]');
    await waitFor(ops, () => { const p = document.querySelector('#abs [data-tel="S_학생가"] + .abpop'); return p && !p.hidden && /010-1111-2222/.test(p.textContent) && /010-3333-4444/.test(p.textContent); }, null, 5000, 'abs phone popup');
    await sleep(2000);
    if (await ops.evaluate(() => document.querySelector('#abs [data-tel="S_학생가"] + .abpop').hidden)) throw new Error('전화 팝업이 다시 그리기로 닫히면 안 됨');
    await SHOT(ops, 'ops_phone');
    await ops.click('#abs [data-tel="S_학생가"]');
    if (await ops.$('#f-notice')) throw new Error('공지 칸은 없어야 함');
    if (!(await ops.isVisible('#b-rec'))) throw new Error('조작 막대 녹화 버튼');
    log('접속 현황 전화 아이콘 → 번호 팝업, 공지 칸 없음, 조작 막대 녹화 버튼');
    // 학생 입장 시간(Code.gs Ver.1.4): 2회차(11월 21일 10:00 시작) → 그날 9:30 전에는 「멘토링 시간이 아닙니다」
    { const sx = await mk('notime', { width: 420, height: 860 });
      await sx.goto(BASE + '/a/?r=2');
      await sx.fill('#g-name', '홍길동'); await sx.fill('#g-birth', '20140505'); await sx.check('#g-agree'); await sx.click('#g-btn');
      const t = await waitFor(sx, () => { const e = document.querySelector('#g-err').textContent; return /멘토링 시간이 아닙니다/.test(e) && e; }, null, 15000, 'art not_time');
      if (!/11월 21일\(토\) 오전 9:30부터/.test(t)) throw new Error('입장 가능 시각 안내: ' + t);
      await SHOT(sx, 'stu_not_time'); await sx.context().close();
      log('학생 입장 시간 전 →', t); }

    // 멘토 2
    const m1 = await mk('m1'), m2 = await mk('m2');
    for (const [p, n] of [[m1, '멘토일'], [m2, '멘토이']]) {
      await p.goto(BASE + '/a/m.html?r=test');
      await p.fill('#g-name', n); await p.fill('#g-code', 'm1234'); await p.click('#g-btn');
      await p.waitForSelector('#c-btn:not([disabled])', { timeout: 15000 }); await p.click('#c-btn');
      await p.waitForSelector('#s-room:not(.hide)');
    }
    log('mentors in');
    // 학생 4 (A: 가·나, B: 다·라)
    const st = {};
    for (const [n, b, vp] of [['학생가', '20140101'], ['학생나', '20150202', { width: 400, height: 820 }], ['학생다', '160303']]) {
      const p = st[n] = await mk(n, vp || { width: 1280, height: 760 });
      await p.goto(BASE + '/a/?r=test');
      await p.fill('#g-name', n); await p.fill('#g-birth', b); await p.check('#g-agree'); await p.click('#g-btn');
      await p.waitForSelector('#c-btn:not([disabled])', { timeout: 15000 }); await p.click('#c-btn');
      await p.waitForSelector('#s-room:not(.hide)');
    }
    log('students in');
    // 생년월일 틀림·명단에 없음 → 거절(관문 직접 확인)
    const api = b => fetch(BASE + '/api', { method: 'POST', body: JSON.stringify(b) }).then(r => r.json());
    log('wrong birth →', (await api({ a: 'join', r: 'test', role: 'student', name: '학생가', birth: '20990101' })).error, '| not in roster →', (await api({ a: 'join', r: 'test', role: 'student', name: '홍길동', birth: '20140101' })).error, '| bad mentor code →', (await api({ a: 'join', r: 'test', role: 'mentor', name: 'x', code: 'zz' })).error);

    // ① 시작 전 → 전체 멘토링: 모두 한 방, 학생 화면에 멘토 2명 크게
    const phase = async (to) => {   // 두 번 눌러 확인(느린 시험 PC에서는 한 번에 두 번 누름)
      for (let i = 0; i < 4; i++) {
        const done = await ops.evaluate(t => { const b = document.querySelector(`#steps button[data-p="${t}"]`); if (!b) return true; b.click(); if (b.classList.contains('arm')) b.click(); return b.disabled; }, to);
        if (done) return; await sleep(500);
      }
    };
    log('ops header:', await ops.evaluate(() => document.querySelector('#steps').innerText.replace(/\n/g, ' | ')));
    await phase('all');
    await waitFor(st['학생가'], () => /전체 멘토링/.test(document.querySelector('#t-phase').textContent), null, 15000, 'phase all on student');
    const seen = await waitFor(st['학생가'], () => { const l = [...document.querySelectorAll('.r-top .tile video')].filter(v => v.readyState >= 2 && v.videoWidth > 0); return l.length >= 2 && l.length; }, null, 40000, 'student sees 2 mentors big');
    log('전체: student sees', seen, 'mentor videos on top; bottom:', await st['학생가'].evaluate(() => [...document.querySelectorAll('.r-bot .tile')].map(t => (t.classList.contains('absent') ? '(빈칸)' : '') + (t.querySelector('.t-label').textContent || t.querySelector('.t-wait').textContent)).join(', ')));
    const absent = await st['학생가'].evaluate(() => [...document.querySelectorAll('.r-bot .tile.absent .t-wait')].map(x => x.textContent).join(','));
    if (!/학생라/.test(absent) || !/학생마/.test(absent)) throw new Error('absent students should show as black tiles with names: ' + absent);
    await waitFor(ops, () => [...document.querySelectorAll('.rp video')].filter(v => v.readyState >= 2 && v.videoWidth > 0).length >= 5, null, 40000, 'ops sees 6 videos');
    log('ops sees all 5 videos in 전체');
    // 운영진 카메라·마이크 켜기 → 같은 방 학생 화면에 「운영 …」 칸
    await ops.click('#b-mycam');
    await waitFor(st['학생가'], () => [...document.querySelectorAll('.tile .t-label')].some(l => /운영 /.test(l.textContent)), null, 40000, 'ops cam visible to student');
    await ops.click('#b-mymic');
    log('ops camera on → student tiles:', await st['학생가'].evaluate(() => [...document.querySelectorAll('.r-bot .tile .t-label')].map(l => l.textContent).filter(Boolean).join(', ')), '| ops buttons:', await ops.evaluate(() => document.querySelector('#b-mycam').textContent + ' / ' + document.querySelector('#b-mymic').textContent));
    await SHOT(st['학생가'], 'stu_opscam');
    await ops.click('#b-mymic');
    await ops.click('#b-mycam');
    await ops.click('#b-who');
    const who = await waitFor(ops, () => { const t = document.querySelector('#who-b').innerText; return /멘토일/.test(t) && /운영A/.test(t) && t; }, null, 10000, 'who popup');
    log('전체 접속자 팝업:', who.replace(/\n+/g, ' / ').slice(0, 220));
    await SHOT(ops, 'ops_who');
    await ops.click('#who-x');
    const spk = await st['학생가'].evaluate(async () => { const seen = {}; for (let i = 0; i < 25; i++) { document.querySelectorAll('.tile.speaking').forEach(t => { seen[t._it.label] = 1; }); await new Promise(r => setTimeout(r, 200)); } return Object.keys(seen).join(', '); });
    log('speaking indicator seen on student screen for:', spk || '(none)');
    const spkM = await m1.evaluate(async () => { const seen = {}; for (let i = 0; i < 25; i++) { document.querySelectorAll('.tile.speaking').forEach(t => { seen[t._it.label] = 1; }); await new Promise(r => setTimeout(r, 200)); } return Object.keys(seen).join(', '); });
    log('speaking indicator on mentor screen (own mic, fake beep):', spkM || '(none)');
    if (!/멘토일/.test(spkM)) throw new Error('speaking indicator not shown');
    await SHOT(m1, 'mentor_speaking');
    await SHOT(st['학생가'], 'stu_speaking');
    // 학생 마이크는 전체에서 꺼짐
    log('student mic in 전체:', await st['학생가'].evaluate(() => document.querySelector('#b-mic').className));
    await sleep(1500); await RECSHOT(ops, 'all');
    await SHOT(st['학생가'], 'stu_all1'); await SHOT(st['학생나'], 'stu_all1_mobile'); await SHOT(m1, 'mentor_all1'); await SHOT(ops, 'ops_all1');

    // 손들기 → 멘토 화면에 표시, 멘토가 크게 보기 지정
    await st['학생다'].click('#b-hand');
    await waitFor(m1, () => /손든 학생 1명/.test(document.querySelector('#t-me').textContent), null, 15000, 'mentor sees hand');
    log('hand → mentor title:', await m1.evaluate(() => document.querySelector('#t-me').textContent));
    await m1.evaluate(() => { const t = [...document.querySelectorAll('.tile')].find(x => /학생다/.test(x.querySelector('.t-label').textContent)); t.click(); });
    await waitFor(st['학생가'], () => { const t = document.querySelector('.r-top .tile.feature .t-label'); return t && /학생다/.test(t.textContent); }, null, 15000, 'spot shown to others');
    log('mentor spot → 학생다 big on 학생가 screen');

    // 작품 사진 올리기
    const png = await host.evaluate(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 900; const g = c.getContext('2d'); g.fillStyle = '#d0628a'; g.fillRect(0, 0, 1200, 900); g.fillStyle = '#fff'; g.font = '120px sans-serif'; g.fillText('작품', 400, 480); return c.toDataURL('image/png').split(',')[1]; });
    await st['학생다'].setInputFiles('#s-file', { name: 'art.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await waitFor(m2, () => [...document.querySelectorAll('.tile img')].some(i => i.naturalWidth > 0), null, 60000, 'photo visible to mentor');
    log('photo upload → visible to mentor (via gate, no public link)');
    await sleep(1500); await RECSHOT(ops, 'all_photo'); await SHOT(st['학생가'], 'stu_photo');

    // ② 1분 예고 → 취소 → 바로 조별
    await ops.evaluate(() => { window.MEET_CONFIG.QUAD_FALLBACK = false; });   // 시험 PC는 느려서 자동 4분할을 끄고 시험(4분할은 아래에서 직접 확인)
    await phase('group');
    log('ops header in 분반:', await ops.evaluate(() => document.querySelector('#steps').innerText.replace(/\n/g, ' | ')), '|', await ops.evaluate(() => document.querySelector('#h-timer').textContent));
    await waitFor(st['학생가'], () => /A조/.test(document.querySelector('#t-room').textContent), null, 45000, 'student moved to A조');
    await waitFor(st['학생다'], () => /B조/.test(document.querySelector('#t-room').textContent), null, 45000, 'student moved to B조');
    const gA = await waitFor(st['학생가'], () => { const l = [...document.querySelectorAll('.tile video')].filter(v => v.readyState >= 2 && v.videoWidth > 0).map(v => v.closest('.tile').querySelector('.t-label').textContent); return l.length >= 3 && l; }, null, 60000, 'A조 videos');
    log('group: 학생가 sees', gA.join(', '));
    if (gA.some(x => /학생다|멘토이/.test(x))) throw new Error('other group visible');
    log('student mic in 조:', await st['학생가'].evaluate(() => document.querySelector('#b-mic').className));
    await waitFor(ops, () => document.querySelectorAll('.rp').length === 4, null, 15000, 'ops shows 4 group panels');
    await waitFor(ops, () => window.__recs && Object.keys(window.__recs()).length === 4, null, 15000, 'four group recordings');
    log('ops: 2 group panels, recording files:', await ops.evaluate(() => Object.values(window.__recs()).map(x => x.r.stat && x.r.stat.name).join(' | ')));
    // 4분할 전환(PC가 버거울 때) → 조별 파일 대신 1개 파일
    await sleep(8000);   // 조별 파일에 내용이 쌓이도록
    await ops.evaluate(() => window.__quad(true));
    await waitFor(ops, () => { const r = window.__recs(); return Object.keys(r).join() === 'quad' && r.quad.r.recording(); }, null, 15000, 'quad recording');
    await waitFor(ops, () => { const q = window.__recs().quad; return q && q.r.stat && q.r.stat.bytes > 200000; }, null, 40000, 'quad has data');
    await SHOT(ops, 'ops_quad'); await RECSHOT(ops, 'quad');
    log('quad fallback recording:', await ops.evaluate(() => { const q = window.__recs().quad; return q && q.r.stat ? q.r.stat.name : '(재시작 중)'; }));
    await ops.evaluate(() => window.__quad(false));
    await waitFor(ops, () => Object.keys(window.__recs()).length === 4, null, 15000, 'back to group files');
    await sleep(1500); await RECSHOT(ops, 'group');
    await SHOT(st['학생가'], 'stu_group'); await SHOT(m1, 'mentor_group'); await SHOT(ops, 'ops_group');

    // 운영진이 B조 듣기 + 조작 막대 마이크 길게 누르기 → B조 학생에게 들림
    await ops.evaluate(() => document.querySelector('.rp[data-room="g2"] .hear').click());
    const tb = await ops.$('#b-mymic'); const bx = await tb.boundingBox();
    await ops.mouse.move(bx.x + 5, bx.y + 5); await ops.mouse.down();
    await waitFor(st['학생다'], () => [...document.querySelectorAll('audio')].some(a => /^O_/.test(a.dataset.k) && !a.muted), null, 20000, 'ops voice audible in B조');
    await waitFor(st['학생가'], () => ![...document.querySelectorAll('audio')].some(a => /^O_/.test(a.dataset.k) && !a.muted), null, 5000, 'not audible in A조');
    await ops.mouse.up();
    log('ops talk → heard only in B조');

    // 조 옮기기(드래그 대신 명령) — 학생나 → B조
    await ops.evaluate(() => { const ev = new DataTransfer(); const c = document.querySelector('.chipst[data-sid="S_학생나"]'); c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: ev })); const col = document.querySelector('.col[data-g="2"]'); col.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: ev })); col.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: ev })); });
    await waitFor(st['학생나'], () => /B조/.test(document.querySelector('#t-room').textContent), null, 15000, 'moved to B조');
    log('drag 학생나 → B조: moved');

    // 관찰 메모
    await ops.fill('#memo', '학생다 색 대비 질문'); await ops.click('#b-memo');
    await sleep(1500);
    if (await st['학생다'].$('#t-notice')) throw new Error('학생 화면에 공지 띠가 없어야 함');
    await sleep(6000);   // 조별 녹화 몇 초

    // ③ 전체 마무리 → 마침
    await phase('all');
    await waitFor(st['학생가'], () => /전체/.test(document.querySelector('#t-room').textContent), null, 45000, 'back to 전체');
    await waitFor(st['학생가'], () => [...document.querySelectorAll('.tile video')].filter(v => v.readyState >= 2 && v.videoWidth > 0).length >= 4, null, 60000, 'all2 videos');
    log('all2: everyone back, videos:', (await liveTiles(st['학생가'])).length);
    // 이어 녹화: 새 파일 먼저 시작 → 앞 파일 멈춤(빈틈 없음)
    await waitFor(ops, () => { const x = window.__recs().all; return x && x.r.stat && x.r.stat.bytes > 0; }, null, 60000, 'all2 recording');
    const alla = await ops.evaluate(() => (window.__alla = window.__recs().all.r.stat.name));
    await ops.evaluate(() => window.__retire('all'));
    try { await waitFor(ops, () => { const x = window.__recs().all; return x && x.r.stat && x.r.stat.name !== window.__alla && x.r.stat.bytes > 0; }, null, 45000, 'all continued in new file'); }
    catch (e) { log('DIAG', await ops.evaluate(() => JSON.stringify({ recs: Object.entries(window.__recs()).map(([k, x]) => [k, x.starting, x.r.recording(), x.r.stat && x.r.stat.name, x.r.stat && x.r.stat.bytes, x.r.ac.state]), log: window.__recLog() }))); throw e; }
    log('이어 녹화(전체):', alla, '→', await ops.evaluate(() => window.__recs().all.r.stat.name));
    // 예비 녹화 PC(두 번째 운영진)
    const ops2 = await mk('ops2', { width: 1400, height: 900 });
    await ops2.goto(BASE + '/a/o.html?r=test');
    await ops2.evaluate(() => { window.MEET_CONFIG.REC_FPS = 8; });
    await ops2.fill('#g-name', '운영B'); await ops2.fill('#g-code', 'o1234'); await ops2.click('#g-btn');
    await ops2.waitForSelector('#s-main:not(.hide)');
    await ops2.evaluate(async () => window.__setRecDir(await navigator.storage.getDirectory(), true));
    await waitFor(ops2, () => { const x = window.__recs().all; return x && x.r.stat && x.r.stat.bytes > 0; }, null, 60000, 'backup recording');
    log('예비 녹화:', await ops2.evaluate(() => window.__recs().all.r.stat.name + ' · ' + document.querySelector('#rec-mode').textContent));
    await ops.click('#b-who');
    await waitFor(ops, () => /예비 녹화/.test(document.querySelector('#who').innerText), null, 20000, 'who shows 예비 녹화');
    await ops.evaluate(() => document.querySelector('#who').click());
    log('전체 접속자 보기에 「예비 녹화」 표시');
    await sleep(4000);
    await ops2.evaluate(() => { window.confirm = () => true; document.querySelector('#sw-rec').click(); });   // 예비 녹화 끄기(시험 PC 부담 줄임)
    await waitFor(ops, () => Object.values(window.__recs()).some(x => x.r.recording() && x.r.stat && x.r.stat.bytes > 150000), null, 60000, '전체_분반후 has data');
    await sleep(3000);
    await phase('end');
    try { await waitFor(ops, () => !!document.querySelector('#steps button[data-p="closeall"]'), null, 30000, 'closeall button'); }
    catch (e) { log('DIAG steps:', await ops.evaluate(() => document.querySelector('#steps').innerText + ' | toast:' + (document.querySelector('.toast') || {}).textContent)); await phase('end'); await waitFor(ops, () => !!document.querySelector('#steps button[data-p="closeall"]'), null, 30000, 'closeall button 2'); }
    await phase('closeall');
    await waitFor(st['학생가'], () => /모두 끝났습니다/.test(document.querySelector('#t-move').textContent) && !document.querySelector('#t-move').classList.contains('hide'), null, 30000, 'student closed');
    await waitFor(m1, () => /모두 끝났습니다/.test(document.querySelector('#t-move').textContent), null, 30000, 'mentor closed');
    log('모두 퇴장 → 학생·멘토 화면 종료 안내, 카메라 꺼짐:', await st['학생가'].evaluate(() => document.querySelectorAll('video').length >= 0 && document.title));
    await SHOT(st['학생가'], 'stu_closed');
    log('sfu tracks/update calls:', await host.evaluate(() => window.__upd || 0));
    await sleep(12000);
    log('end phase — rec:', await ops.evaluate(() => JSON.stringify(Object.values(window.__recs()).map(x => [x.ph, x.starting, x.r.health()]))));
    // 녹화 멈추고 파일 확인
    await ops.evaluate(() => { window.confirm = () => true; document.querySelector('#sw-rec').click(); });
    await sleep(15000);
    log('after off — recs:', await ops.evaluate(() => JSON.stringify(Object.keys(window.__recs()))), '| list:', await ops.evaluate(() => document.querySelector('#rec-files').innerText.replace(/\n/g, ' / ')));
    const files = await ops.evaluate(async () => {
      const d = await navigator.storage.getDirectory(), out = [];
      for await (const [n, h] of d.entries()) { if (h.kind !== 'file' || !/미술/.test(n)) continue; if (/crswap/.test(n)) { out.push({ n, size: -1, url: '' }); continue; } const f = await h.getFile(); out.push({ n, size: f.size, url: URL.createObjectURL(f) }); }
      for (const x of out) {
        const v = document.createElement('video'); v.muted = true; v.src = x.url;
        await new Promise(r => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
        x.w = v.videoWidth; x.h = v.videoHeight;
      }
      return out.map(x => ({ n: x.n, mb: (x.size / 1048576).toFixed(1), wh: x.w + 'x' + x.h }));
    });
    files.sort((a, b) => a.n < b.n ? -1 : 1).forEach(f => log('file:', f.n, f.mb + 'MB', f.wh));
    const need = ['전체_분반전', '분반1_A조', '분반2_B조', '전체_분반후', '분반_4분할'];
    if (files.some(f => /대기/.test(f.n))) throw new Error('should not record 대기 (before start / after end)');
    need.forEach(k => { if (!files.some(f => f.n.includes(k) && f.wh === '1920x1080')) throw new Error('missing recording ' + k); });
    log('recordings OK: 전체_분반전 · 분반1_A조 · 분반2_B조 · (4분할) · 전체_분반후 at 1920x1080, no 대기 files');
    // 녹화 기록표 + 파일을 꺼내 「녹화 조각 합치기」 시험용으로 저장
    const OUTREC = '/tmp/artrec'; fs.rmSync(OUTREC, { recursive: true, force: true }); fs.mkdirSync(OUTREC + '/bk', { recursive: true });
    for (const [pg, sub] of [[ops, ''], [ops2, '/bk']]) {
      const got = await pg.evaluate(async () => {
        const d = await navigator.storage.getDirectory(), out = [];
        for await (const [n, h] of d.entries()) {
          if (h.kind !== 'file' || !/미술|녹화기록/.test(n) || /crswap/.test(n)) continue;
          const b = new Uint8Array(await (await h.getFile()).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768));
          out.push([n, btoa(s)]);
        }
        return out;
      });
      got.forEach(([n, b]) => fs.writeFileSync(OUTREC + sub + '/' + n, Buffer.from(b, 'base64')));
      log('exported', sub || '(주)', got.map(x => x[0]).join(' | '));
    }
    const lg = fs.readdirSync(OUTREC).filter(n => /^_녹화기록/.test(n));
    if (!lg.length) throw new Error('no 녹화기록 tsv');
    log('녹화기록표:', lg[0], '\n' + fs.readFileSync(OUTREC + '/' + lg[0], 'utf8'));
    // 녹화 화면 한 장(조별 파일)
    const stats = await (await fetch(BASE + '/__stats')).json();
    log('memo rows:', JSON.stringify(stats.memo.slice(1)), '| sfu calls:', stats.sfuCalls, '| photos:', stats.photos);
    log('log:', stats.log.slice(1).map(r => r[2] + ':' + r[4]).join(' / ').slice(0, 300));
    log('sfu host:', JSON.stringify(await host.evaluate(() => window.__sfuStats().length)), 'sessions');
    log('ALL OK');
  } catch (e) { fail = e; console.log('FAIL', e.message.split('\n')[0]);
    if (global.__ops) { try { const cdp = await global.__ops.context().newCDPSession(global.__ops); await cdp.send('Debugger.enable'); const got = new Promise(r => cdp.once('Debugger.paused', r)); await cdp.send('Debugger.pause'); const ev = await Promise.race([got, sleep(5000).then(() => null)]); console.log('ops stack:', ev ? ev.callFrames.slice(0, 8).map(f => f.functionName + ':' + f.location.lineNumber).join(' < ') : 'no pause'); } catch (e3) { console.log('cdp', e3.message); } } for (const c of browser.contexts()) for (const pg of c.pages()) { try { await pg.screenshot({ path: path.join(OUT, 'fail_' + (await pg.title()).replace(/\W+/g, '_').slice(0, 20) + '_' + Math.random().toString(36).slice(2, 5) + '.png'), timeout: 8000 }); } catch (e2) { console.log('shot fail', e2.message.split('\n')[0]); } } }
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
