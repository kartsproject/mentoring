/* 녹화: 멘토·학생 두 영상을 한 화면(좌우)으로 합치고 두 음성을 섞어 저장
 * - 운영진(녹화 담당) PC 브라우저에서 동작
 * - 학생 1명마다 파일 1개
 */
(function () {
  'use strict';

  var TYPES = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/webm;codecs=vp9,opus',   // H.264 MP4가 안 되는 브라우저: WebM(Vimeo·드라이브 업로드 가능)
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  function pickType() {
    if (!window.MediaRecorder) return '';
    for (var i = 0; i < TYPES.length; i++) if (MediaRecorder.isTypeSupported(TYPES[i])) return TYPES[i];
    return '';
  }

  // 모든 녹화기가 함께 쓰는 그리기 예산: 최근 1초 동안 그리기에 쓴 시간이 0.45초를 넘으면 쉼
  var duty = { w: [], sum: 0,
    ok: function () { var n = performance.now(); while (this.w.length && this.w[0][0] < n - 1000) this.sum -= this.w.shift()[1]; return this.sum < 450; },
    add: function (t, c) { this.w.push([t, c]); this.sum += c; } };

  var live = [];   // 지금 있는 녹화기들(그리기 순서 공평하게)
  // 백그라운드에서도 덜 느려지는 타이머(워커)
  function workerTimer(fps, fn) {
    var src = 'var t=null;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}';
    var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = fn;
    w.postMessage(Math.round(1000 / fps));
    return function () { w.postMessage(0); w.terminate(); };
  }

  /* 영상 프레임을 트랙에서 직접 받음(MediaStreamTrackProcessor)
   * — 녹화 창이 다른 창(대기실 창 등)에 가려지거나 다른 탭을 봐도 녹화 영상이 멈추지 않게. 지원하지 않는 브라우저는 <video>로 그림 */
  function makeTap(track) {
    if (!track || typeof window.MediaStreamTrackProcessor !== 'function') return null;
    try {
      var clone = track.clone(), reader = new window.MediaStreamTrackProcessor({ track: clone }).readable.getReader();
      var t = { src: track.id, frame: null, at: 0, dead: false,
        stop: function () { this.dead = true; try { reader.cancel(); } catch (e) {} try { clone.stop(); } catch (e) {} if (this.frame) { try { this.frame.close(); } catch (e) {} this.frame = null; } } };
      (function pump() {
        reader.read().then(function (r) {
          if (r.done || t.dead) { if (r.value) r.value.close(); return; }
          if (t.frame) t.frame.close();
          t.frame = r.value; t.at = Date.now(); pump();
        }).catch(function () {});
      })();
      return t;
    } catch (e) { return null; }
  }

  function Recorder(o) {
    o = o || {};
    // 녹화 파일 해상도: FHD(1920×1080) 기본 — 창 크기와 무관하게 이 크기로 그려 저장
    this.W = o.width || 1920; this.H = o.height || 1080; this.fps = o.fps || 30;
    this.k = this.W / 1280;   // 글자·여백 배율
    this.vbps = o.videoBitsPerSecond || Math.round(6000000 * (this.W * this.H) / (1920 * 1080));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');
    this.tiles = { M: { video: null, label: '' }, S: { video: null, label: '' } };
    this.pips = [];       // 멘토링실의 연구원·운영진 — 맨 아래 가운데에 작게(소리 포함, Ver.2.28)
    this.idleText = '';   // 오른쪽이 비었을 때 보일 글(예: 멘토링 대기 중)
    this.title = '';
    this.type = pickType();
    this.rec = null;
    this.files = [];
    this.onFile = o.onFile || function () {};
    this.onState = o.onState || function () {};
    var AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC();
    this.dest = this.ac.createMediaStreamDestination();
    // 아무도 접속하지 않아도 소리 줄에 늘 (무음) 데이터가 흐르게 — 소리가 끊기면 MP4가 재생되지 않는 파일이 될 수 있음
    try { var cs = this.ac.createConstantSource(); cs.offset.value = 0; cs.connect(this.dest); cs.start(); } catch (e) {}
    this.idle = { M: '', S: '' };
    this.srcNodes = {};
    this.taps = {};
    var self = this;
    this.skipped = 0;
    live.push(this);
    var stopT = null;
    this.stopTimer = function () { live = live.filter(function (r) { return r !== self; }); if (stopT) stopT(); Object.keys(self.taps).forEach(function (k) { self.taps[k].stop(); }); self.taps = {}; };
    stopT = workerTimer(this.fps, function () {
      // PC가 버거우면 그리기를 건너뜀(화면·조작이 멈추지 않게) — 녹화는 그대로, 초당 장면 수만 줄어듦
      if (!self.recording()) return;   // 녹화 중이 아니면 그리지 않음(멈춘 녹화기가 PC를 쓰지 않게)
      // 예산을 넘으면 쉬되, 가장 오래 못 그린 녹화기 하나는 1초에 한 번 그림(새로 시작한 녹화기가 굶어 빈 파일이 되지 않게)
      var now = performance.now();
      if (!duty.ok()) {
        var me = now - (self.lastDrawn || 0), worst = 0;
        live.forEach(function (r) { if (r !== self && r.recording()) worst = Math.max(worst, now - (r.lastDrawn || 0)); });
        if (me < 1000 || me < worst) { self.skipped++; return; }
      }
      self.lastDrawn = now; self.draw(); duty.add(now, performance.now() - now);
    });
  }

  Recorder.prototype.supported = function () { return !!this.type; };
  Recorder.prototype.ext = function () { return /mp4/.test(this.type) ? 'mp4' : 'webm'; };
  Recorder.prototype.resume = function () { if (this.ac.state !== 'running') return this.ac.resume(); return Promise.resolve(); };

  // 영상 트랙 → 프레임 받기(같은 트랙이면 그대로, 바뀌면 새로)
  Recorder.prototype.tapFor = function (key, stream) {
    var tr = stream && stream.getVideoTracks()[0], t = this.taps[key];
    if (t && (!tr || t.src !== tr.id || tr.readyState === 'ended')) { t.stop(); delete this.taps[key]; t = null; }
    if (!t && tr && tr.readyState === 'live') { t = makeTap(tr); if (t) this.taps[key] = t; }
    return t;
  };
  // key: 'M' | 'S'
  Recorder.prototype.setTile = function (key, video, label, stream) {
    var t = this.tiles[key];
    t.video = video; t.label = label || ''; t.tap = this.tapFor('T:' + key, stream);
    var at = stream && stream.getAudioTracks()[0];
    var cur = this.srcNodes[key];
    if (cur && cur.trackId === (at && at.id)) return;
    if (cur) { try { cur.node.disconnect(); } catch (e) {} delete this.srcNodes[key]; }
    if (at) {
      try {
        var node = this.ac.createMediaStreamSource(new MediaStream([at]));
        node.connect(this.dest);
        this.srcNodes[key] = { node: node, trackId: at.id };
      } catch (e) { console.warn('audio mix', e); }
    }
  };

  // 멘토링실의 연구원: [{key, video, label, stream, mic}] — 학생 칸 왼쪽 위 작은 화면 + 소리
  Recorder.prototype.setPips = function (items) {
    var self = this, keep = {};
    this.pips = (items || []).slice(0, 6).map(function (it) { keep['P:' + it.key] = 1; return { video: it.video, label: it.label || '', mic: !!it.mic, tap: self.tapFor('P:' + it.key, it.stream) }; });
    Object.keys(this.taps).forEach(function (k) { if (k.indexOf('P:') === 0 && !keep[k]) { self.taps[k].stop(); delete self.taps[k]; } });
    (items || []).slice(0, 3).forEach(function (it) { self.mixAudio('P:' + it.key, it.stream); });
    Object.keys(this.srcNodes).forEach(function (k) { if (k.indexOf('P:') === 0 && !keep[k]) { try { self.srcNodes[k].node.disconnect(); } catch (e) {} delete self.srcNodes[k]; } });
  };
  Recorder.prototype.mixAudio = function (key, stream) {
    var at = stream && stream.getAudioTracks()[0];
    var cur = this.srcNodes[key];
    if (cur && cur.trackId === (at && at.id)) return;
    if (cur) { try { cur.node.disconnect(); } catch (e) {} delete this.srcNodes[key]; }
    if (at) {
      try {
        var node = this.ac.createMediaStreamSource(new MediaStream([at]));
        node.connect(this.dest);
        this.srcNodes[key] = { node: node, trackId: at.id };
      } catch (e) { console.warn('audio mix', e); }
    }
  };

  /* 녹음할 소리 묶음(미술: 화면은 painter로 직접 그림) — audio = [{ key, stream }] */
  Recorder.prototype.setLayout = function (sections, audio) {
    var self = this, keep = {};
    (audio || []).forEach(function (it) { if (it.stream && !keep['L:' + it.key]) { keep['L:' + it.key] = 1; self.mixAudio('L:' + it.key, it.stream); } });
    Object.keys(this.srcNodes).forEach(function (k) { if (k.indexOf('L:') === 0 && !keep[k]) { try { self.srcNodes[k].node.disconnect(); } catch (e) {} delete self.srcNodes[k]; } });
  };

  Recorder.prototype.draw = function () {
    var c = this.ctx, W = this.W, H = this.H;
    if (this.painter) { try { this.painter(c, W, H); } catch (e) { console.warn('painter', e); } return; }   // 화면 구성을 직접 그리는 경우(미술)
    c.fillStyle = '#121315'; c.fillRect(0, 0, W, H);
    var k = this.k, top = Math.round(44 * k), gap = Math.round(8 * k), tw = (W - gap) / 2, th = H - top;
    this.drawTile(this.tiles.M, 0, top, tw, th, '멘토', this.idle.M);
    this.drawTile(this.tiles.S, tw + gap, top, tw, th, '학생', this.idleText || this.idle.S, this.pips.length > 0);   // 가운데 아래 작은 화면과 겹치지 않게 이름은 오른쪽 아래로
    if (this.pips.length) {
      // 운영진·연구원: 맨 아래 가운데에 작게 가로로(Ver.2.28)
      var pw = Math.round(W * 0.075), phh = Math.round(pw * 0.75), pg = Math.round(6 * k), self2 = this;
      var px0 = Math.round((W - (this.pips.length * pw + (this.pips.length - 1) * pg)) / 2), py = H - phh - Math.round(10 * k);
      this.pips.forEach(function (p, i) {
        var px = px0 + i * (pw + pg);
        c.fillStyle = p.mic ? '#3DDC84' : 'rgba(255,255,255,.35)'; c.fillRect(px - 2, py - 2, pw + 4, phh + 4);
        self2.drawTile({ video: p.video, tap: p.tap, label: '' }, px, py, pw, phh, '', '');
        c.font = '700 ' + Math.round(9 * k) + 'px "Pretendard Variable", Pretendard, sans-serif'; c.textBaseline = 'middle';
        var lw = Math.min(pw - 6 * k, c.measureText(p.label).width + 8 * k);
        c.fillStyle = 'rgba(18,19,21,.75)'; c.fillRect(px + 3 * k, py + phh - 16 * k, lw, 13 * k);
        c.save(); c.beginPath(); c.rect(px + 3 * k, py + phh - 16 * k, lw, 13 * k); c.clip();
        c.fillStyle = '#fff'; c.fillText(p.label, px + 7 * k, py + phh - 9.5 * k); c.restore();
      });
    }
    // 상단 표시줄
    c.fillStyle = '#1A1C1F'; c.fillRect(0, 0, W, top);
    ['#4F8AC9', '#D0628A', '#D46C3C', '#4E9B55'].forEach(function (col, i) { c.fillStyle = col; c.fillRect(i * W / 4, top - Math.round(3 * k), W / 4, Math.round(3 * k)); });   // 분야 색 띠
    c.fillStyle = '#E84958'; c.beginPath(); c.arc(22 * k, top / 2, 6 * k, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#F3F1EC'; c.font = '600 ' + Math.round(18 * k) + 'px "Pretendard Variable", Pretendard, sans-serif'; c.textBaseline = 'middle';
    c.fillText(this.title, 38 * k, top / 2);
    var d = new Date();
    var ts = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    c.textAlign = 'right'; c.fillStyle = '#A8ABB0'; c.fillText(ts, W - 16 * k, top / 2); c.textAlign = 'left';
  };

  Recorder.prototype.drawTile = function (t, x, y, w, h, fallback, idle, right) {
    var c = this.ctx, v = t.video || t.img, k = this.k;
    if (t.tap && t.tap.frame && Date.now() - t.tap.at < 5000) v = t.tap.frame;   // 트랙에서 바로 받은 최신 프레임(창이 가려져도 움직임)
    c.fillStyle = '#000'; c.fillRect(x, y, w, h);
    var vw = v ? (v.displayWidth || v.videoWidth || v.naturalWidth || 0) : 0, vh = v ? (v.displayHeight || v.videoHeight || v.naturalHeight || 0) : 0;
    var ok = v && vw > 0 && (v.displayWidth ? true : v.tagName === 'IMG' ? v.complete : v.readyState >= 2);
    if (ok) {
      // 칸을 꽉 채움(가운데 기준으로 넘치는 쪽만 잘라냄 — 세로 영상도 좌우 검은 띠 없이, Ver.2.29)
      var s = Math.max(w / vw, h / vh), sw = w / s, sh = h / s;
      try { c.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, x, y, w, h); } catch (e) {}
    } else {
      c.fillStyle = '#686C72'; c.font = '600 ' + Math.round(20 * k) + 'px "Pretendard Variable", Pretendard, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(idle || '영상 없음', x + w / 2, y + h / 2); c.textAlign = 'left';
    }
    var label = t.label || fallback;
    if (!label) return;
    c.font = '700 ' + Math.round(17 * k) + 'px "Pretendard Variable", Pretendard, sans-serif'; c.textBaseline = 'middle';
    var lw = c.measureText(label).width + 22 * k;
    var lx = right ? x + w - 12 * k - lw : x + 12 * k;
    c.fillStyle = 'rgba(18,19,21,.72)'; c.fillRect(lx, y + h - 44 * k, lw, 32 * k);
    c.fillStyle = '#fff'; c.fillText(label, lx + 11 * k, y + h - 28 * k);
  };

  Recorder.prototype.recording = function () { return !!(this.rec && this.rec.state === 'recording'); };

  // 자동 저장 폴더(파일 시스템 접근). 없으면 다운로드로 저장
  Recorder.prototype.setDir = function (dir) { this.dir = dir || null; };
  Recorder.autoSaveSupported = function () { return typeof window.showDirectoryPicker === 'function'; };

  Recorder.prototype.start = function (filename, title) {
    if (this.recording()) return false;
    if (!this.type) throw new Error('이 브라우저는 녹화를 지원하지 않습니다(크롬 사용)');
    this.resume();
    this.title = title || '';
    this.draw();   // 첫 장면을 바로 그려 둠
    var vs = this.canvas.captureStream(this.fps);
    var withAudio = this.ac.state === 'running';   // 소리가 막힌 상태(브라우저 자동재생 제한)면 영상만 녹화
    var tracks = vs.getVideoTracks().concat(withAudio ? this.dest.stream.getAudioTracks() : []);
    var stream = new MediaStream(tracks);
    var type = this.type;
    if (!withAudio) { var vt = type.replace(/,\s*(mp4a[^;]*|opus)$/, ''); if (vt !== type && MediaRecorder.isTypeSupported(vt)) type = vt; }
    var opts = { mimeType: type, videoBitsPerSecond: this.vbps, videoKeyFrameIntervalDuration: 2000 };
    if (withAudio) opts.audioBitsPerSecond = 128000;
    var rec = new MediaRecorder(stream, opts);
    this.recAudio = withAudio;
    var self = this, started = Date.now();
    var chunks = this.dir ? null : [];   // 폴더 저장이면 메모리에 쌓지 않음(긴 녹화에도 창이 멈추지 않게) — 예비 사본이 대신함
    // 같은 이름이 이미 있으면(같은 분에 다시 시작·다시 접속) 뒤에 -2, -3… 을 붙여 덮어쓰지 않음
    this.used = this.used || {};
    var ext = this.ext(), fname = filename + '.' + ext;
    for (var i = 2; this.used[fname]; i++) fname = filename + '-' + i + '.' + ext;
    this.used[fname] = 1;
    var st = this.stat = { name: fname, at: started, bytes: 0, lastData: started, sinkFailed: false, backupOk: false, error: '' };

    // ① 예비 사본: 브라우저 안 저장소(OPFS)에 쓰는 즉시 디스크에 반영 → 창이 갑자기 닫혀도 다음 접속 때 복구
    var bk = Backup.open(fname, this.type);
    st.backupOk = !!bk;

    // ② 정한 폴더에 바로 이어 씀(창·알림 없이 저장)
    var sink = null;
    if (this.dir) {
      sink = { q: [], w: null, busy: false, failed: false, idle: null };
      var dir = this.dir;
      (async function () {
        for (var j = 2; j < 100; j++) {
          try { await dir.getFileHandle(fname); } catch (e) { break; }   // 폴더에 없으면 그 이름 사용
          fname = filename + '-' + j + '.' + ext; self.used[fname] = 1; st.name = fname;
        }
        return dir.getFileHandle(fname, { create: true });
      })()
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w) { sink.w = w; pump(); })
        .catch(function (e) { console.warn('auto-save', e); sink.failed = st.sinkFailed = true; sink.q = []; if (sink.idle) sink.idle(); self.onState(true); });
    }
    function pump() {
      if (!sink || !sink.w || sink.busy) return;
      sink.busy = true;
      (async function () {
        try { while (sink.q.length) await sink.w.write(sink.q.shift()); }
        catch (e) { console.warn('auto-save write', e); sink.failed = st.sinkFailed = true; sink.q = []; self.onState(true); }
        sink.busy = false;
        if (sink.idle && !sink.q.length) sink.idle();
      })();
    }
    function drained() {
      return new Promise(function (res) {
        if (sink.failed || (sink.w && !sink.busy && !sink.q.length)) return res();
        sink.idle = function () { if (sink.failed || (sink.w && !sink.busy && !sink.q.length)) { sink.idle = null; res(); } };
        setTimeout(res, 20000);
      });
    }

    rec.ondataavailable = function (e) {
      if (!e.data || !e.data.size) return;
      st.bytes += e.data.size; st.lastData = Date.now();
      if (chunks) chunks.push(e.data);
      if (bk) bk.write(e.data);
      if (sink && !sink.failed) { sink.q.push(e.data); pump(); }
    };
    rec.onerror = function (e) { st.error = String((e && e.error && e.error.name) || 'error'); console.warn('MediaRecorder error', e); };
    rec.onstop = async function () {
      var f = { name: fname, size: st.bytes, sec: Math.round((Date.now() - started) / 1000), at: started };
      if (bk) await bk.close();
      if (sink) {
        await drained();
        if (!sink.failed && sink.w) {
          try { await sink.w.close(); f.saved = true; f.auto = true; f.folder = self.dir.name; }
          catch (e) { sink.failed = st.sinkFailed = true; }
        }
        // 폴더 저장이 실패했으면 예비 사본을 폴더에 다시 써 봄 → 그래도 안 되면 내려받기
        if (!f.auto && bk) {
          try { var ok = await Backup.copyTo(fname, self.dir, fname.replace(/(\.\w+)$/, '_예비$1')); if (ok) { f.auto = true; f.saved = true; f.folder = self.dir.name; f.name = ok; f.fromBackup = true; } } catch (e) {}
          if (!f.auto) { try { f.blob = await Backup.file(fname); if (f.blob) { self.save(f); f.fromBackup = true; } } catch (e) {} }
        }
      }
      if (!f.auto && !f.blob && chunks) {   // 폴더 없이 녹화한 경우: 내려받기
        f.blob = new Blob(chunks, { type: self.type.split(';')[0] });
        self.save(f);
      }
      if (bk && f.auto) Backup.remove(fname);   // 폴더에 잘 저장됐으면 예비 사본 지움(아니면 다음 접속 때 복구)
      // 시작하자마자 멈춰 내용이 없는 파일은 남기지 않음
      if (!st.bytes && f.auto && self.dir) { try { await self.dir.removeEntry(f.name); f.empty = true; } catch (e) {} if (bk) Backup.remove(fname); }
      self.files.unshift(f);
      // 메모리 보호: 최근 4개만 다시 받기 가능
      self.files.slice(4).forEach(function (x) { if (x.url) URL.revokeObjectURL(x.url); x.blob = null; x.url = null; });
      self.onFile(f);
      self.onState(self.recording());   // 다음 학생 녹화가 이미 시작됐을 수 있음
    };
    rec.start(1000);
    this.rec = rec; this.recName = filename; this.recAt = started;
    this.onState(true);
    return true;
  };

  // 지금 녹화 상태(화면 표시·이상 감지용)
  Recorder.prototype.health = function () {
    var s = this.stat;
    if (!this.recording() || !s) return null;
    return { name: s.name, sec: Math.round((Date.now() - s.at) / 1000), bytes: s.bytes, stall: Date.now() - s.lastData,
             sinkFailed: s.sinkFailed, backupOk: s.backupOk && Backup.ok(s.name), error: s.error, audio: this.recAudio };
  };

  Recorder.prototype.stop = function () {
    if (!this.recording()) return false;
    try { this.rec.requestData(); } catch (e) {}
    this.rec.stop();
    return true;
  };

  /* ───── 예비 사본(OPFS) — 창이 갑자기 닫혀도 녹화가 남도록 ───── */
  var BK_DIR = 'karts-rec-backup';
  var BK_SRC = [
    'var h=null;',
    'onmessage=async function(e){var m=e.data;try{',
    ' if(m.t==="open"){var root=await navigator.storage.getDirectory();var d=await root.getDirectoryHandle("' + BK_DIR + '",{create:true});',
    '  var fh=await d.getFileHandle(m.name,{create:true});h=await fh.createSyncAccessHandle();h.truncate(0);h.flush();postMessage({t:"opened"});}',
    ' else if(m.t==="write"){if(!h)return;h.write(new Uint8Array(m.buf),{at:h.getSize()});h.flush();postMessage({t:"wrote",n:m.buf.byteLength});}',
    ' else if(m.t==="close"){if(h){h.flush();h.close();h=null;}postMessage({t:"closed"});}',
    '}catch(err){postMessage({t:"err",msg:String(err)});}};'
  ].join('\n');
  var BK_OK = {};
  var Backup = {
    ok: function (name) { return BK_OK[name] !== false; },
    open: function (name, type) {
      if (!(navigator.storage && navigator.storage.getDirectory && window.Worker)) return null;
      var w;
      try { w = new Worker(URL.createObjectURL(new Blob([BK_SRC], { type: 'text/javascript' }))); } catch (e) { return null; }
      var chain = Promise.resolve(), closed = null, release = null;
      BK_OK[name] = true;
      // 녹화 중인 사본은 잠가 둠(다른 창의 복구가 건드리지 않게)
      if (navigator.locks) navigator.locks.request('karts-rec:' + name, function () { return new Promise(function (r) { release = r; }); }).catch(function () {});
      var waitMsg = function (t) { return new Promise(function (res) { var on = function (e) { if (e.data.t === t || e.data.t === 'err') { w.removeEventListener('message', on); if (e.data.t === 'err') BK_OK[name] = false; res(); } }; w.addEventListener('message', on); }); };
      chain = chain.then(function () { var p = waitMsg('opened'); w.postMessage({ t: 'open', name: name }); return p; });
      return {
        write: function (blob) {
          chain = chain.then(function () { return blob.arrayBuffer(); }).then(function (buf) { var p = waitMsg('wrote'); w.postMessage({ t: 'write', buf: buf }, [buf]); return p; }).catch(function () { BK_OK[name] = false; });
        },
        close: function () {
          if (closed) return closed;
          closed = chain.then(function () { var p = waitMsg('closed'); w.postMessage({ t: 'close' }); return p; }).then(function () { w.terminate(); if (release) release(); });
          return Promise.race([closed, new Promise(function (r) { setTimeout(r, 20000); })]);
        }
      };
    },
    dir: async function () { var root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(BK_DIR, { create: true }); },
    file: async function (name) { var d = await Backup.dir(); return (await d.getFileHandle(name)).getFile(); },
    remove: async function (name) { try { var d = await Backup.dir(); await d.removeEntry(name); } catch (e) {} },
    // 예비 사본을 폴더에 복사(이름이 겹치면 -2…). 성공하면 저장한 이름을 돌려줌
    copyTo: async function (name, dir, outName) {
      if (!dir) return '';
      var src = await Backup.file(name);
      if (!src || !src.size) return '';
      var base = outName.replace(/(\.\w+)$/, ''), ext = (outName.match(/\.\w+$/) || [''])[0], nm = outName;
      for (var j = 2; j < 100; j++) { try { await dir.getFileHandle(nm); nm = base + '-' + j + ext; } catch (e) { break; } }
      var w = await (await dir.getFileHandle(nm, { create: true })).createWritable();
      await src.stream().pipeTo(w);   // pipeTo가 끝나면 파일이 닫히고 저장됨
      return nm;
    },
    // 지난번에 끝나지 못한 녹화(창이 닫힘·멈춤)를 폴더로 복구. 돌려주는 값: 복구한 파일 이름 목록
    recover: async function (dir) {
      if (!(navigator.storage && navigator.storage.getDirectory)) return [];
      var held = {};
      try { if (navigator.locks) (await navigator.locks.query()).held.forEach(function (l) { held[l.name] = 1; }); } catch (e) {}
      var d = await Backup.dir(), names = [], out = [];
      for await (var ent of d.values()) if (ent.kind === 'file') names.push(ent.name);
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (held['karts-rec:' + n]) continue;   // 다른 창에서 녹화 중
        try {
          var f = await (await d.getFileHandle(n)).getFile();
          if (!f.size) { await d.removeEntry(n); continue; }
          // 창이 갑자기 닫히면 폴더에는 같은 이름의 빈(0바이트) 파일이 남음 → 그 자리에 복구. 내용이 있으면 「_복구」로 따로
          var target = n.replace(/(\.\w+)$/, '_복구$1');
          if (dir) { try { var ex = await (await dir.getFileHandle(n)).getFile(); if (!ex.size) { await dir.removeEntry(n); target = n; } } catch (e) { target = n; } }
          var saved = dir ? await Backup.copyTo(n, dir, target) : '';
          if (!saved) continue;   // 폴더에 못 쓰면 지우지 않고 남겨 둠(다음에 다시 복구)
          await d.removeEntry(n);
          out.push(saved);
        } catch (e) { console.warn('recover', n, e); }
      }
      return out;
    }
  };
  Recorder.Backup = Backup;

  Recorder.prototype.save = function (f) {
    if (!f.blob) return false;
    f.url = f.url || URL.createObjectURL(f.blob);
    var a = document.createElement('a');
    a.href = f.url; a.download = f.name; document.body.appendChild(a); a.click(); a.remove();
    f.saved = true;
    return true;
  };

  /* 저장 폴더 기억(다음에 열 때 다시 고르지 않도록) */
  var DB = 'karts-meet', STORE = 'kv';
  function idb(mode, fn) {
    return new Promise(function (res, rej) {
      var o = indexedDB.open(DB, 1);
      o.onupgradeneeded = function () { o.result.createObjectStore(STORE); };
      o.onerror = function () { rej(o.error); };
      o.onsuccess = function () {
        var tx = o.result.transaction(STORE, mode), st = tx.objectStore(STORE);
        var r = fn(st);
        tx.oncomplete = function () { res(r && r.result); };
        tx.onerror = function () { rej(tx.error); };
      };
    });
  }
  Recorder.loadDir = function () { return idb('readonly', function (st) { return st.get('recdir'); }).catch(function () { return null; }); };
  Recorder.saveDir = function (h) { return idb('readwrite', function (st) { st.put(h, 'recdir'); }).catch(function () {}); };
  // 저장 폴더 확보: 기억된 폴더 권한 확인 → 없으면 고르기 (반드시 버튼 클릭 직후 호출)
  Recorder.ensureDir = async function (forcePick) {
    if (!Recorder.autoSaveSupported()) return null;
    var h = forcePick ? null : await Recorder.loadDir();
    if (h) {
      try {
        var q = await h.queryPermission({ mode: 'readwrite' });
        if (q === 'granted') return h;
        if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') return h;
      } catch (e) {}
    }
    try {
      h = await window.showDirectoryPicker({ id: 'karts-mentoring-rec', mode: 'readwrite', startIn: 'documents' });
      await Recorder.saveDir(h);
      return h;
    } catch (e) { return null; }   // 취소
  };

  window.MeetRecorder = Recorder;
})();
