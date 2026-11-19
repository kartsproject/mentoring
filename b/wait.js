/* K예술영재 무용 온라인 멘토링 — 대기실 화상(Ver.2.7)
 * 대기실에 있는 학생·운영진·연구원이 서로 얼굴을 보고 이야기합니다.
 * 영상은 Cloudflare Realtime SFU가 중계(미술과 같은 ../a/sfu.js 사용): 각자 영상 1개만 올리고, 필요한 만큼 낮은 화질로 받음.
 * 멘토링실(멘토 ↔ 학생, 녹화)은 지금처럼 따로 직접 연결 — 이 화상은 녹화하지 않습니다.
 */
(function () {
  'use strict';
  var M = window.Meet, UI = M.UI;
  var MIC_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 5 2.2M15 10V5a3 3 0 0 0-5.7-1.3"/><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11 5.7M12 18v3M3 3l18 18"/></svg>';

  // 관문 호출(인증이 풀렸으면 다시 들어가서 한 번 더)
  async function call(sess, body) {
    var b = Object.assign({ r: sess.r, id: sess.id, tok: sess.tok }, body);
    var j = await M.api(b);
    if (!j.ok && j.error === 'auth') { await sess.rejoin(); b.id = sess.id; b.tok = sess.tok; j = await M.api(b); }
    return j;
  }

  /* o: { sess, el(칸을 그릴 곳), role 'student'|'staff', getLocal(학생: 카메라·마이크 스트림), listen(소리 켬), onMute(학생: 운영진이 마이크 끔), onChange } */
  function WaitRoom(o) {
    this.sess = o.sess; this.el = o.el; this.role = o.role || 'student';
    this.getLocal = o.getLocal || function () { return null; };
    this.listen = o.listen !== false;
    this.onChange = o.onChange || function () {};
    this.onMuteReq = o.onMute || function () {};
    this.canMute = !!o.canMute;
    this.on = false; this.sfu = null; this.view = null; this.lastWant = ''; this.err = '';
    this.rt = {};             // 사람 id → { cam, mic } 받은 트랙
    this.tiles = {};          // 사람 id → 칸 요소
    this.audios = {};         // 사람 id → 소리 요소
    this.mic = null; this.cam = null;   // (운영진·연구원) 대기실용 내 마이크·카메라
    this.talking = false; this.openMic = false;
    this.muteSeen = null;
    this.audioBox = document.createElement('div'); this.audioBox.hidden = true; document.body.appendChild(this.audioBox);
    var self = this;
    this.ro = window.ResizeObserver ? new ResizeObserver(function () { self.fit(); }) : null;
    if (this.ro && this.el) this.ro.observe(this.el);
  }

  WaitRoom.prototype.start = async function () {
    if (this.on) return;
    this.on = true; this.err = ''; this.lastWant = '';
    var self = this;
    var sfu = this.sfu = new window.ArtSFU(this.sess, {
      onTrack: function (k, t) { self.gotTrack(k, t); },
      onPub: function (names) { self.announce(names); }
    });
    try {
      await sfu.open();
      if (this.sfu !== sfu) return;
      if (this.role === 'student') {
        var L = this.getLocal(), v = L && L.getVideoTracks()[0], a = L && L.getAudioTracks()[0];
        if (v) await sfu.publish('cam', v);
        if (a) await sfu.publish('mic', a);
      } else {
        if (this.mic) await sfu.publish('mic', this.mic.getAudioTracks()[0]);
        if (this.cam) await sfu.publish('cam', this.cam.getVideoTracks()[0]);
      }
      sfu.watch(function () { self.lastWant = ''; if (self.view) self.sync(self.view); });
      this.announce(sfu.names());
      if (this.view) this.sync(this.view);
    } catch (e) {
      console.warn('대기실 화상', e);
      this.err = e.code === 'sfu_not_set' ? '대기실 화상이 아직 설정되지 않았습니다(관리자: Code.gs 스크립트 속성 CF_SFU_APP_ID·CF_SFU_APP_TOKEN)' : '대기실 화상 연결에 실패했습니다 — 잠시 후 다시 연결합니다';
      try { sfu.close(); } catch (e2) {}
      if (this.sfu === sfu) { this.sfu = null; this.on = false; }
      this.render();
      if (e.code !== 'sfu_not_set') setTimeout(function () { if (!self.on && self.wantOn) self.start(); }, 8000);
    }
  };
  WaitRoom.prototype.want = function (on) {   // 켜야 할 때 true(실패하면 다시 시도)
    this.wantOn = !!on;
    if (on && !this.on) this.start();
    if (!on && this.on) this.stop();
  };
  WaitRoom.prototype.stop = function () {
    if (!this.on && !this.sfu) return;
    this.on = false;
    var sfu = this.sfu; this.sfu = null;
    if (sfu) try { sfu.close(); } catch (e) {}
    this.rt = {}; this.lastWant = '';
    Object.keys(this.audios).forEach(function (k) { this.audios[k].remove(); }, this); this.audios = {};
    call(this.sess, { a: 'wr', cmd: 'pub', sfu: '' }).catch(function () {});
    this.render();
  };
  // (학생) 카메라를 바꾸는 등 내 스트림이 바뀌면 올리는 트랙만 바꿈
  WaitRoom.prototype.replaceLocal = function () {
    if (!this.on || !this.sfu || !this.sfu.sid || this.role !== 'student') return;
    var L = this.getLocal(), v = L && L.getVideoTracks()[0], a = L && L.getAudioTracks()[0];
    if (v) this.sfu.publish('cam', v).catch(function () {});
    if (a) this.sfu.publish('mic', a).catch(function () {});
    this.render();
  };
  WaitRoom.prototype.announce = function (names) {
    if (!this.sfu || !this.sfu.sid) return;
    var self = this;
    call(this.sess, { a: 'wr', cmd: 'pub', sfu: this.sfu.sid, tr: names }).then(function () { self.sess.kick(); }).catch(function () {});
  };

  // 받을 영상·소리 맞추기
  WaitRoom.prototype.sync = function (v) {
    this.view = v;
    var me = this.sess.id, list = (v && v.wr || []).filter(function (p) { return p.id !== me; });
    if (this.role === 'student' && v && v.wmuteAt) {   // 운영진이 내 마이크를 끔
      if (this.muteSeen == null) this.muteSeen = v.wmuteAt;
      else if (v.wmuteAt > this.muteSeen) { this.muteSeen = v.wmuteAt; this.onMuteReq(); }
    } else if (this.muteSeen == null) this.muteSeen = 0;
    if (this.on && this.sfu && this.sfu.sid) {
      var nStu = list.filter(function (p) { return p.role === 'student'; }).length;
      var small = this.el && this.el.clientWidth < 520;
      var want = [];
      list.forEach(function (p) {
        if (p.tr.cam) want.push({ key: p.id + '|cam', sessionId: p.sfu, trackName: p.tr.cam,
          rid: p.role !== 'student' ? 'h' : (nStu <= (small ? 2 : 4) ? 'h' : 'q') });
        if (p.tr.mic) want.push({ key: p.id + '|mic', sessionId: p.sfu, trackName: p.tr.mic });
      });
      var sig = JSON.stringify(want);
      if (sig !== this.lastWant) {
        this.lastWant = sig;
        var self = this;
        this.sfu.want(want).catch(function (e) { console.warn('대기실 받기', e); self.lastWant = ''; });
      }
    }
    this.render();
  };
  WaitRoom.prototype.gotTrack = function (key, track) {
    var i = key.lastIndexOf('|'), id = key.slice(0, i), kind = key.slice(i + 1);
    var r = this.rt[id] = this.rt[id] || {};
    if (track) r[kind] = track; else delete r[kind];
    this.render();
  };

  // 대기실 사람들 순서: 운영진·연구원 → 나 → 다른 학생(들어온 순서)
  WaitRoom.prototype.people = function () {
    var v = this.view || {}, me = this.sess.id, list = (v.wr || []).slice();
    // 운영진·연구원은 카메라를 켰거나 마이크를 쓴 사람만 칸으로(창만 열어 둔 사람은 칸 없음)
    var staff = list.filter(function (p) { return p.role !== 'student' && p.id !== me && (p.tr.cam || p.tr.mic); });
    var stu = list.filter(function (p) { return p.role === 'student' && p.id !== me; }).sort(function (a, b) { return a.at - b.at; });
    var out = staff.map(function (p) { return { p: p }; });
    if (this.on && (this.role === 'student' || this.cam || this.mic)) out.splice(staff.length, 0, { p: { id: me, name: this.sess.name, role: this.role }, me: true });
    return out.concat(stu.map(function (p) { return { p: p }; }));
  };

  WaitRoom.prototype.render = function () {
    var el = this.el; if (!el) return;
    var self = this, items = this.people(), seen = {};
    if (!this.on) {
      el.classList.add('wempty');
      el.innerHTML = '<div class="wmsg">' + UI.esc(this.err || (this.wantOn ? '대기실 화상 연결 중…' : '대기실 화상 꺼짐')) + '</div>';
      this.tiles = {}; this.onChange(0); return;
    }
    if (el.classList.contains('wempty')) { el.classList.remove('wempty'); el.innerHTML = ''; }
    items.forEach(function (it, idx) {
      var p = it.p, t = self.tiles[p.id];
      if (!t) {
        t = document.createElement('div'); t.className = 'wt';
        t.innerHTML = '<video autoplay playsinline muted></video><div class="wph"></div><span class="wnm"></span><span class="wmo" hidden>' + MIC_OFF + '</span>' +
          (self.canMute && !it.me && p.role === 'student' ? '<button class="wmute" type="button" title="이 학생 마이크 끄기">' + MIC_OFF + '<span>마이크 끄기</span></button>' : '');
        var mb = t.querySelector('.wmute');
        if (mb) mb.onclick = function (e) { e.stopPropagation(); self.mute(p.id, mb); };
        self.tiles[p.id] = t;
      }
      seen[p.id] = 1;
      if (el.children[idx] !== t) el.insertBefore(t, el.children[idx] || null);
      var vid = t.querySelector('video'), stream = null, hasCam = false, micOn = true;
      if (it.me) {
        var L = self.role === 'student' ? self.getLocal() : null;
        var tr = [];
        if (L) tr = L.getTracks(); else { if (self.cam) tr = tr.concat(self.cam.getVideoTracks()); if (self.mic) tr = tr.concat(self.mic.getAudioTracks()); }
        var vt = tr.filter(function (x) { return x.kind === 'video'; })[0], at = tr.filter(function (x) { return x.kind === 'audio'; })[0];
        hasCam = !!(vt && vt.enabled && vt.readyState === 'live');
        micOn = !!(at && at.enabled);
        stream = t.__s && t.__sig === tr.map(function (x) { return x.id; }).join() ? t.__s : new MediaStream(tr);
        t.__sig = tr.map(function (x) { return x.id; }).join();
        t.classList.add('me');
      } else {
        var r = self.rt[p.id] || {}, arr = [];
        if (r.cam) arr.push(r.cam); if (r.mic) arr.push(r.mic);
        var sig = arr.map(function (x) { return x.id; }).join();
        stream = t.__sig === sig && t.__s ? t.__s : (arr.length ? new MediaStream(arr) : null);
        t.__sig = sig;
        hasCam = !!(r.cam && p.tr && p.tr.cam);
        micOn = p.role === 'student' ? p.mic !== false : !!p.talk;
        self.playAudio(p.id, r.mic || null);
      }
      t.__s = stream;
      if (vid.srcObject !== stream) UI.attach(vid, stream);
      t.classList.toggle('nocam', !hasCam);
      t.classList.toggle('staff', p.role !== 'student');
      t.querySelector('.wph').textContent = (p.name || '').slice(-2);
      t.querySelector('.wnm').textContent = (p.role === 'ops' ? '운영진 ' : p.role === 'research' ? '연구원 ' : '') + (p.name || '') + (it.me ? ' (나)' : '');
      t.querySelector('.wmo').hidden = micOn;
    });
    Object.keys(this.tiles).forEach(function (id) {
      if (seen[id]) return;
      self.tiles[id].remove(); delete self.tiles[id];
      if (self.audios[id]) { self.audios[id].remove(); delete self.audios[id]; }
    });
    this.fit();
    this.onChange(items.length);
  };
  WaitRoom.prototype.playAudio = function (id, track) {
    var a = this.audios[id];
    if (!track) { if (a) { a.remove(); delete this.audios[id]; } return; }
    if (!a) { a = this.audios[id] = document.createElement('audio'); a.autoplay = true; this.audioBox.appendChild(a); }
    if (!a.srcObject || a.srcObject.getAudioTracks()[0] !== track) { a.srcObject = new MediaStream([track]); }
    a.muted = !this.listen;
    var pr = a.play(); if (pr && pr.catch) pr.catch(function () {});
  };
  WaitRoom.prototype.setListen = function (on) {
    this.listen = !!on;
    var self = this;
    Object.keys(this.audios).forEach(function (k) { var a = self.audios[k]; a.muted = !self.listen; if (self.listen) { var pr = a.play(); if (pr && pr.catch) pr.catch(function () {}); } });
  };

  // 칸 크기: 상자에 가장 크게 들어가도록 열 수를 고름(4:3)
  WaitRoom.prototype.fit = function () {
    var el = this.el; if (!el) return;
    var n = Object.keys(this.tiles).length; if (!n) return;
    var W = el.clientWidth, H = el.clientHeight, gap = 6, best = 1, bestW = 0;
    for (var c = 1; c <= n; c++) {
      var rows = Math.ceil(n / c), w = (W - gap * (c - 1)) / c, h = w * 3 / 4;
      if (H > 40 && rows * h + gap * (rows - 1) > H) { w = ((H - gap * (rows - 1)) / rows) * 4 / 3; }
      if (w > bestW) { bestW = w; best = c; }
    }
    el.style.setProperty('--wc', best);
    el.style.setProperty('--ww', Math.floor(bestW) + 'px');
  };

  /* ── 운영진·연구원: 말하기·마이크 켜 두기·카메라 ── */
  WaitRoom.prototype.ensureMic = async function () {
    if (this.mic) return true;
    try { this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); }
    catch (e) { UI.toast('마이크를 쓸 수 없습니다(브라우저 권한 확인)'); return false; }
    this.mic.getAudioTracks().forEach(function (t) { t.enabled = false; });
    if (this.sfu && this.sfu.sid) await this.sfu.publish('mic', this.mic.getAudioTracks()[0]);
    return true;
  };
  WaitRoom.prototype.applyTalk = function () {
    var on = this.talking || this.openMic;
    if (this.mic) this.mic.getAudioTracks().forEach(function (t) { t.enabled = on; });
    this.sess.info.wtalk = on;
    this.sess.kick();
    this.render();
  };
  WaitRoom.prototype.talk = async function (down) {
    if (down && !(await this.ensureMic())) return;
    this.talking = !!down; this.applyTalk();
  };
  WaitRoom.prototype.setOpenMic = async function (on) {
    if (on && !(await this.ensureMic())) return false;
    this.openMic = !!on; this.applyTalk(); return true;
  };
  WaitRoom.prototype.setCam = async function (on) {
    if (on && !this.cam) {
      try { this.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 24 } }, audio: false }); }
      catch (e) { UI.toast('카메라를 켜지 못했습니다'); return false; }
      if (this.sfu && this.sfu.sid) await this.sfu.publish('cam', this.cam.getVideoTracks()[0]);
    } else if (!on && this.cam) {
      if (this.sfu && this.sfu.sid) await this.sfu.unpublish('cam');
      this.cam.getTracks().forEach(function (t) { t.stop(); }); this.cam = null;
    }
    this.render(); return true;
  };
  WaitRoom.prototype.mute = async function (sid, btn) {
    if (btn) { if (!(btn.dataset.armed && Date.now() - Number(btn.dataset.armed) < 3000)) { btn.dataset.armed = Date.now(); btn.classList.add('arm'); btn.querySelector('span').textContent = '한 번 더'; setTimeout(function () { btn.classList.remove('arm'); btn.querySelector('span').textContent = '마이크 끄기'; delete btn.dataset.armed; }, 3000); return; } }
    var j = await call(this.sess, { a: 'wr', cmd: 'mute', sid: sid }).catch(function () { return null; });
    UI.toast(j && j.ok ? '학생 마이크를 껐습니다(학생이 다시 켤 수 있음)' : '마이크를 끄지 못했습니다');
  };

  M.WaitRoom = WaitRoom;
})();
