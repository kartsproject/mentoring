/* 운영 화면 보조(o.html 녹화 창·대기실 창 공용) — Ver.2.19에서 정리
 *  - 학생 칸 표시용 시간 판단: 멘토링 시간이 됨(due) · 대기실 접속 시각이 지났는데 미접속(late)
 *  - 「운영 순서」 안내
 *  - 녹화가 안 될 때의 경고음(운영 화면의 다른 알림음·팝업은 쓰지 않음)
 */
(function () {
  'use strict';
  var M = window.Meet, UI = M.UI, $ = UI.$;

  function Room(o) {
    this.o = o;   // { sess }
    this.view = null;
    this.audio = null;
    var self = this;
    var gb = $('#guideBtn'), g = $('#guide');
    if (gb && g) {
      gb.onclick = function () { g.classList.toggle('on'); if (g.classList.contains('on')) self.renderGuide(); };
      g.addEventListener('click', function (e) { if (e.target.id === 'guideClose') g.classList.remove('on'); });
    }
    // 소리 장치는 사용자가 한 번 누른 뒤에야 깨어남
    var wake = function () { try { self.audio = self.audio || new (window.AudioContext || window.webkitAudioContext)(); self.audio.resume(); } catch (e) {} };
    ['pointerdown', 'keydown'].forEach(function (t) { document.addEventListener(t, wake, { once: true, capture: true }); });
  }

  function kstDay(t) { return new Date(t + 9 * 3600e3).toISOString().slice(0, 10); }
  function kst(d, hm) { var m = String(hm || '').match(/(\d{1,2}):(\d{2})/); return m ? new Date(d + 'T' + m[1].padStart(2, '0') + ':' + m[2] + ':00+09:00').getTime() : NaN; }
  Room.prototype.day = function () { var s = this.view && this.view.session; return (s && s.date) || kstDay(Date.now()); };
  Room.prototype.rlabel = function () { var r = this.o.sess.r; return r === 'test' ? '리허설' : r + '회차'; };
  Room.prototype.render = function (v) { this.view = v; if ($('#guide') && $('#guide').classList.contains('on')) this.renderGuide(); };

  /* 학생 칸 표시(그 회차 당일에만): due = 멘토링 시간이 됐는데 아직 시작 안 함 / late = 대기실 접속 시각이 지났는데 미접속 */
  Room.prototype.flagMap = function () {
    var v = this.view, F = {}, now = Date.now(), d = this.day();
    if (!v || kstDay(now) !== d) return F;
    v.students.forEach(function (x) {
      if (x.extra || x.done || x.zoom || (v.cur && v.cur.id === x.id)) return;
      var f = {};
      if (x.time && now >= kst(d, x.time)) f.due = true;
      if (!x.live && x.wait && now >= kst(d, x.wait)) f.late = true;
      if (f.due || f.late) F[x.id] = f;
    });
    return F;
  };

  /* 녹화가 안 될 때만 경고음 */
  Room.prototype.alarm = function () {
    var a = this.audio; if (!a) return;
    try {
      a.resume();
      [[880, 0], [1175, .18], [880, .36], [1175, .54]].forEach(function (x) {
        var o = a.createOscillator(), g = a.createGain(); o.frequency.value = x[0]; o.connect(g); g.connect(a.destination);
        g.gain.setValueAtTime(.0001, a.currentTime + x[1]); g.gain.exponentialRampToValueAtTime(.3, a.currentTime + x[1] + .02); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + x[1] + .16);
        o.start(a.currentTime + x[1]); o.stop(a.currentTime + x[1] + .18);
      });
    } catch (e) {}
  };

  /* 운영 순서(지금 시스템 기준) */
  function addMin(hm, m) { var p = String(hm).split(':').map(Number), t = p[0] * 60 + p[1] + m; return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
  Room.prototype.renderGuide = function () {
    var L = ((this.view && this.view.students) || []).filter(function (x) { return !x.extra && x.time; }), f = L[0], last = L[L.length - 1];
    $('#guide').innerHTML = '<div class="gh"><b>' + UI.ico('list') + '당일 운영 순서 · ' + this.rlabel() + '</b><button class="btn ghost sm" type="button" id="guideClose">닫기</button></div>' +
      '<div class="cols"><div>' +
      '<h4>시작 전</h4><ul>' + (f ? '<li><b class="t">' + addMin(f.wait, -20) + '</b>까지 운영진 접속 · 녹화 PC는 「녹화 준비」에서 저장 폴더 고르기</li>' +
        '<li><b class="t">' + addMin(f.time, -30) + '</b>부터 학생 입장 가능 · <b class="t">' + f.wait + '</b>까지 멘토 접속</li>' : '<li>시트 「명단」을 채우면 시각이 표시됩니다.</li>') +
      '<li>2대 모니터면 「대기실 창 열기」로 대기실을 옆 화면에</li></ul>' +
      '</div><div>' +
      '<h4>진행 중</h4><ul><li><b>대기실</b>: 학생이 들어오면 녹화 PC가 자동 연결 점검. 빨간 테두리(미접속) 칸은 📞로 <b>전화</b>, 안 되면 [ZOOM]</li>' +
      '<li>멘토링 시간이 되면 칸의 [시작]이 빨갛게 — 누르면 학생이 멘토링실로(녹화 자동 시작)</li>' +
      '<li>앞 학생이 끝나면 [다음 시작] 한 번(앞 학생 녹화 자동 저장)</li>' +
      '<li>' + (last ? '<b class="t">' + UI.esc(last.end || last.time) + '</b> ' : '') + '마지막 학생은 [이 학생 종료] 두 번 → 녹화 파일 확인</li></ul>' +
      '</div></div>';
  };

  window.MeetRoom = Room;
})();
