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

  // 백그라운드에서도 덜 느려지는 타이머(워커)
  function workerTimer(fps, fn) {
    var src = 'var t=null;onmessage=function(e){clearInterval(t);if(e.data>0)t=setInterval(function(){postMessage(0)},e.data)}';
    var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = fn;
    w.postMessage(Math.round(1000 / fps));
    return function () { w.postMessage(0); w.terminate(); };
  }

  function Recorder(o) {
    o = o || {};
    this.W = o.width || 1280; this.H = o.height || 720; this.fps = o.fps || 30;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.W; this.canvas.height = this.H;
    this.ctx = this.canvas.getContext('2d');
    this.tiles = { M: { video: null, label: '' }, S: { video: null, label: '' } };
    this.title = '';
    this.type = pickType();
    this.rec = null;
    this.files = [];
    this.onFile = o.onFile || function () {};
    this.onState = o.onState || function () {};
    var AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC();
    this.dest = this.ac.createMediaStreamDestination();
    this.srcNodes = {};
    var self = this;
    this.stopTimer = workerTimer(this.fps, function () { self.draw(); });
  }

  Recorder.prototype.supported = function () { return !!this.type; };
  Recorder.prototype.ext = function () { return /mp4/.test(this.type) ? 'mp4' : 'webm'; };
  Recorder.prototype.resume = function () { if (this.ac.state !== 'running') return this.ac.resume(); return Promise.resolve(); };

  // key: 'M' | 'S'
  Recorder.prototype.setTile = function (key, video, label, stream) {
    var t = this.tiles[key];
    t.video = video; t.label = label || '';
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

  Recorder.prototype.draw = function () {
    var c = this.ctx, W = this.W, H = this.H;
    c.fillStyle = '#0E1315'; c.fillRect(0, 0, W, H);
    var top = 44, gap = 8, tw = (W - gap) / 2, th = H - top;
    this.drawTile(this.tiles.M, 0, top, tw, th, '멘토');
    this.drawTile(this.tiles.S, tw + gap, top, tw, th, '학생');
    // 상단 표시줄
    c.fillStyle = '#172024'; c.fillRect(0, 0, W, top);
    c.fillStyle = '#E84958'; c.beginPath(); c.arc(22, top / 2, 6, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#eef2f3'; c.font = '600 18px "Pretendard Variable", Pretendard, sans-serif'; c.textBaseline = 'middle';
    c.fillText(this.title, 38, top / 2);
    var d = new Date();
    var ts = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0') + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    c.textAlign = 'right'; c.fillStyle = '#93a2a8'; c.fillText(ts, W - 16, top / 2); c.textAlign = 'left';
  };

  Recorder.prototype.drawTile = function (t, x, y, w, h, fallback) {
    var c = this.ctx, v = t.video;
    c.fillStyle = '#000'; c.fillRect(x, y, w, h);
    var ok = v && v.readyState >= 2 && v.videoWidth > 0;
    if (ok) {
      var s = Math.min(w / v.videoWidth, h / v.videoHeight);
      var dw = v.videoWidth * s, dh = v.videoHeight * s;
      try { c.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); } catch (e) {}
    } else {
      c.fillStyle = '#5b6a70'; c.font = '600 20px "Pretendard Variable", Pretendard, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('영상 없음', x + w / 2, y + h / 2); c.textAlign = 'left';
    }
    var label = t.label || fallback;
    c.font = '700 17px "Pretendard Variable", Pretendard, sans-serif'; c.textBaseline = 'middle';
    var lw = c.measureText(label).width + 22;
    c.fillStyle = 'rgba(0,0,0,.6)'; c.fillRect(x + 12, y + h - 44, lw, 32);
    c.fillStyle = '#fff'; c.fillText(label, x + 23, y + h - 28);
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
    var vs = this.canvas.captureStream(this.fps);
    var tracks = vs.getVideoTracks().concat(this.dest.stream.getAudioTracks());
    var stream = new MediaStream(tracks);
    var rec = new MediaRecorder(stream, { mimeType: this.type, videoBitsPerSecond: 3000000, audioBitsPerSecond: 128000 });
    var chunks = [], self = this, started = Date.now();
    var fname = filename + '.' + this.ext();

    // 폴더가 정해져 있으면 녹화하는 동안 파일에 바로 이어 씀(창·알림 없이 저장, 중간에 꺼져도 앞부분 보존)
    var sink = null;
    if (this.dir) {
      sink = { q: [], w: null, busy: false, failed: false, idle: null };
      this.dir.getFileHandle(fname, { create: true })
        .then(function (fh) { return fh.createWritable(); })
        .then(function (w) { sink.w = w; pump(); })
        .catch(function (e) { console.warn('auto-save', e); sink.failed = true; if (sink.idle) sink.idle(); });
    }
    function pump() {
      if (!sink || !sink.w || sink.busy) return;
      sink.busy = true;
      (async function () {
        try { while (sink.q.length) await sink.w.write(sink.q.shift()); }
        catch (e) { console.warn('auto-save write', e); sink.failed = true; }
        sink.busy = false;
        if (sink.idle && !sink.q.length) sink.idle();
      })();
    }
    function drained() {
      return new Promise(function (res) {
        if (sink.failed || (sink.w && !sink.busy && !sink.q.length)) return res();
        sink.idle = function () { if (sink.failed || (sink.w && !sink.busy && !sink.q.length)) { sink.idle = null; res(); } };
        setTimeout(res, 15000);
      });
    }

    rec.ondataavailable = function (e) {
      if (!e.data || !e.data.size) return;
      chunks.push(e.data);
      if (sink && !sink.failed) { sink.q.push(e.data); pump(); }
    };
    rec.onstop = async function () {
      var f = { name: fname, size: 0, sec: Math.round((Date.now() - started) / 1000), at: started };
      chunks.forEach(function (c) { f.size += c.size; });
      if (sink) {
        await drained();
        if (!sink.failed && sink.w) {
          try { await sink.w.close(); f.saved = true; f.auto = true; f.folder = self.dir.name; chunks = null; }
          catch (e) { sink.failed = true; }
        }
      }
      if (!f.auto) {   // 자동 저장이 안 됐으면 다운로드로
        f.blob = new Blob(chunks, { type: self.type.split(';')[0] });
        self.save(f);
      }
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

  Recorder.prototype.stop = function () {
    if (!this.recording()) return false;
    this.rec.stop();
    return true;
  };

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
