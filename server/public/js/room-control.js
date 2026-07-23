(function () {
  'use strict';

  window.addEventListener('error', function (e) {
    const detail = e && e.message ? e.message : 'unknown error';
    const where = e && e.filename ? ' @' + e.filename + ':' + e.lineno : '';
    console.error('[rc] window error' + where + ': ' + detail);
  });
  window.addEventListener('unhandledrejection', function (e) {
    const reason = e && e.reason ? (e.reason.message || String(e.reason)) : 'unhandled rejection';
    console.error('[rc] unhandledrejection:', reason);
  });

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);

  // ─── Device identity ──────────────────────────────────
  let deviceId = localStorage.getItem('hearth_rcDeviceId') || 'rc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  localStorage.setItem('hearth_rcDeviceId', deviceId);

  // ─── Base station state (monitoring / broadcast) ──────
  let sources = [];
  let devices = [];
  let viewingId = null;
  let viewMode = null;
  let subscribed = new Set();
let streams = {};
  let audioState = {};
  let capabilitiesByDevice = {};
  let configDeviceId = null;

  // Broadcast reception (FaceTalk from base stations)
  let broadcastPeerId = null;
  let broadcastVideoActive = false;
  let lastActivity = {};

  // Display config (set by base station)
  let displayMode = 'blank';

  // Talk
  let talkingTo = null;

  // Monitor overlay
  let monitorMuted = false;
  let mutedVolume = 100;
  let monitorControlsTimer = null;
  let statsStop = null;
  let fsActive = false;

  // Watch recovery
  let recovering = false;
  let recoverTimer = null;
  let recoverAttempts = 0;
  const WATCH_DEAD_MS = 8000;
  const RECOVER_TIMEOUT = 10000;
  const MAX_RECOVER_ATTEMPTS = 4;
  const RECOVER_RETRY_MS = 15000;

  // ─── Own camera state (from camera.js) ────────────────
  let cameraSourceId = null;
  let publishedType = null;
  let subscriberCount = 0;
  const subscribers = new Set();
  let wakeLock = null;

  let localVideoStream = null;
  let localAudioStream = null;
  let hasVideo = false;
  let hasAudio = false;

  let audioCtx = null;
  let analyser = null;
  let audioMeterTimer = null;
  let audioMeterTickCount = 0;
  let smoothRms = 0;

  const SETTINGS_KEY = 'hearth_rcSettings';

  function defaultSettings() {
    return {
      camera: 'front',
      resolution: '720p',
      frameRate: 30,
      keepAwake: true,
      displayMode: 'blank',
      speakerVolume: 0.5,
      micSensitivity: 0.8,
      audioAlertEnabled: true,
      audioAlertThresholdDb: -40,
    };
  }

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch {}
    return Object.assign(defaultSettings(), saved);
  }

  function saveSettings(cfg) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch {}
  }

  let currentConfig = loadSettings();

  // ─── DOM refs ─────────────────────────────────────────
  const connectionDot = document.getElementById('connectionDot');
  const monitorFeed = document.getElementById('monitorFeed');
  const monitorVideo = document.getElementById('monitorVideo');
  const monitorError = document.getElementById('monitorError');
  const monitorStatus = document.getElementById('monitorStatus');
  const monitorPlaceholder = document.getElementById('monitorPlaceholder');
  const stopMonitorBtn = document.getElementById('stopMonitorBtn');
  const monitorVolume = document.getElementById('monitorVolume');
  const monitorMuteBtn = document.getElementById('monitorMuteBtn');
  const monitorTalkBtn = document.getElementById('monitorTalkBtn');
  const monitorFullscreenBtn = document.getElementById('monitorFullscreenBtn');
  const monitorQuality = document.getElementById('monitorQuality');
  const ftDebug = document.getElementById('ftDebug');
  const rxDebug = document.getElementById('rxDebug');
  const toast = document.getElementById('toast');
  const homeView = document.getElementById('homeView');
  const deviceList = document.getElementById('deviceList');
  const configPanel = document.getElementById('configPanel');
  const configForm = document.getElementById('configForm');
  const configTitle = document.getElementById('configTitle');
  const incomingCall = document.getElementById('incomingCall');
  const incomingCallFrom = document.getElementById('incomingCallFrom');
  const remoteAudio = document.getElementById('remoteAudio');

  // ─── Debug readouts ───────────────────────────────────
  let ftDbgState = { wsMethod: '--', wsUp: false, target: null, sourceId: null, pc: '--', ice: '--', tracks: '--' };
  function renderFtDebug() {
    if (!ftDebug) return;
    const d = ftDbgState;
    ftDebug.textContent =
      'ft:' + (d.target ? 'ON->' + d.target.slice(-4) : 'idle') +
      '  ws:' + d.wsMethod + (d.wsUp ? '^' : 'v') +
      '  src:' + (d.sourceId ? d.sourceId.slice(-6) : '-') +
      '  pc:' + d.pc + '  ice:' + d.ice + '  tracks:' + d.tracks;
  }

  let rxDbgState = { peer: null, pc: '--', ice: '--', tracks: '--', res: '--', fps: '--', br: '--', rtt: '--' };
  function renderRxDebug() {
    if (!rxDebug) return;
    const d = rxDbgState;
    rxDebug.textContent =
      'rx:' + (d.peer ? 'ON->' + d.peer.slice(-4) : 'idle') +
      '  pc:' + d.pc + '  ice:' + d.ice + '  tracks:' + d.tracks +
      '  ' + d.res + '@' + d.fps + '  ' + d.br + '  rtt:' + d.rtt;
  }

  // ─── Helpers ──────────────────────────────────────────
  function formatTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function sourceTypeFor(id) {
    const src = sources.find(s => s.publisherId === id);
    return src ? src.type : null;
  }

  function hasVideoType(type) { return type === 'video+audio' || type === 'video-only'; }
  function hasAudioType(type) { return type === 'video+audio' || type === 'audio-only'; }

  let toastTimer = null;
  function showToast(msg, ms) {
    ms = ms || 4000;
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.add('hidden'); }, ms);
  }

  function showMonitorStatus(text) {
    if (!text) { monitorStatus.classList.add('hidden'); monitorStatus.textContent = ''; return; }
    monitorStatus.textContent = text;
    monitorStatus.classList.remove('hidden');
  }

  // ─── Volume control ───────────────────────────────────
  const USE_GAIN_NODE = false;
  let gainNode = null;
  let audioSourceNode = null;

  function ensureAudioGraph() {
    if (USE_GAIN_NODE) {
      if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); gainNode = audioCtx.createGain(); gainNode.connect(audioCtx.destination); } catch {}
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }
  }

  function connectAudioSource(stream) {
    if (!USE_GAIN_NODE || !gainNode) return;
    if (audioSourceNode) { try { audioSourceNode.disconnect(); } catch {} audioSourceNode = null; }
    var track = stream.getAudioTracks()[0];
    if (!track) return;
    var audioStream = new MediaStream([track]);
    audioSourceNode = audioCtx.createMediaStreamSource(audioStream);
    audioSourceNode.connect(gainNode);
  }

  function applyVolume(value) {
    var n = parseFloat(value);
    var v = Math.max(0, Math.min(200, isNaN(n) ? 100 : n));
    if (USE_GAIN_NODE) {
      if (gainNode) gainNode.gain.value = v / 100;
    } else {
      if (monitorVideo) monitorVideo.volume = Math.min(1, v / 100);
    }
  }

  var initVol = parseFloat(localStorage.getItem('hearth_rcVolume'));
  if (!isFinite(initVol) || initVol < 0 || initVol > 200) initVol = 100;
  monitorVolume.value = initVol;
  applyVolume(initVol);

  function updateTrackFill() {
    monitorVolume.style.setProperty('--vol-pct', (monitorVolume.value / 200 * 100) + '%');
  }
  updateTrackFill();

  monitorVolume.addEventListener('input', function () {
    updateTrackFill();
    ensureAudioGraph();
    applyVolume(monitorVolume.value);
    localStorage.setItem('hearth_rcVolume', monitorVolume.value);
  });

  var volumeToggleBtn = document.getElementById('volumeToggleBtn');
  var volumeSliderWrap = document.getElementById('volumeSliderWrap');
  if (volumeToggleBtn && volumeSliderWrap) {
    volumeToggleBtn.addEventListener('click', function () { volumeSliderWrap.classList.toggle('hidden'); });
  }

  // ─── Monitor feed ─────────────────────────────────────
  function attachMonitorStream() {
    if (!viewingId) return;
    var stream = streams[viewingId];
    if (!stream) return;
    monitorVideo.srcObject = stream;
    applyViewMode();
    ensureAudioGraph();
    connectAudioSource(stream);
    monitorVideo.muted = true;
    applyVolume(monitorVolume.value);
    var p = monitorVideo.play();
    if (p && p.then) {
      p.then(function () { if (!USE_GAIN_NODE) monitorVideo.muted = false; }).catch(function () {});
    } else if (!USE_GAIN_NODE) {
      monitorVideo.muted = false;
    }
  }

  function applyViewMode() {
    if (!viewingId) return;
    var stream = streams[viewingId];
    if (!stream) return;
    if (viewMode === 'audio') {
      monitorVideo.classList.add('hidden');
      monitorPlaceholder.classList.remove('hidden');
      return;
    }
    if (stream.getVideoTracks().length === 0) {
      monitorVideo.classList.add('hidden');
      monitorPlaceholder.classList.remove('hidden');
      return;
    }
    monitorVideo.classList.remove('hidden');
    monitorPlaceholder.classList.add('hidden');
  }

  function updateAudioMeterUi(id) {
    var st = audioState[id];
    if (!st) return;
    var item = deviceList.querySelector('.device-item[data-id="' + id + '"]');
    if (!item) return;
    var dbText = (st.levelDb != null) ? ' ' + Math.round(st.levelDb) + 'dB' : '';
    var readout = item.querySelector('.db-readout');
    if (st.levelDb != null) {
      if (!readout) {
        readout = document.createElement('span');
        readout.className = 'db-readout';
        var name = item.querySelector('.device-name');
        if (name) name.appendChild(readout);
      }
      readout.textContent = dbText;
    } else if (readout) {
      readout.remove();
    }
    if (st.alerting) item.classList.add('audio-alert');
    else item.classList.remove('audio-alert');
  }

  // ─── Show local camera in monitor feed ────────────────
  function showLocalCameraInMonitor() {
    if (!rtc.localStream) return;
    monitorVideo.srcObject = rtc.localStream;
    monitorVideo.muted = true;
    monitorVideo.play().catch(function () {});
    monitorFeed.classList.remove('hidden');
    monitorError.classList.add('hidden');
    monitorPlaceholder.classList.add('hidden');
    monitorVideo.classList.remove('hidden');
    showMonitorControls();
  }

  // ─── Monitor overlay auto-hide ────────────────────────
  function showMonitorControls() {
    var overlay = document.querySelector('.monitor-overlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    renderControlButtons();
    if (monitorControlsTimer) clearTimeout(monitorControlsTimer);
    monitorControlsTimer = setTimeout(function () {
      overlay.classList.remove('visible');
      monitorControlsTimer = null;
    }, 5000);
  }

  function hideMonitorControls() {
    var overlay = document.querySelector('.monitor-overlay');
    if (overlay) overlay.classList.remove('visible');
    if (monitorControlsTimer) { clearTimeout(monitorControlsTimer); monitorControlsTimer = null; }
  }

  // ─── Control buttons ──────────────────────────────────
  function setPressed(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function renderControlButtons() {
    setPressed(monitorMuteBtn, monitorMuted);
    setPressed(monitorTalkBtn, !!talkingTo);
    setPressed(monitorFullscreenBtn, fsActive);
  }

  // ─── Fullscreen ───────────────────────────────────────
  function toggleFullscreen() {
    var el = monitorFeed;
    if (!el) return;
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) {
      fsActive = true;
      if (el.requestFullscreen) el.requestFullscreen().catch(function () { fsActive = false; });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (monitorVideo.webkitEnterFullscreen) monitorVideo.webkitEnterFullscreen();
    } else {
      fsActive = false;
      if (document.exitFullscreen) document.exitFullscreen().catch(function () {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    renderControlButtons();
  }

  function syncFsFromDom() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    var now = !!fsEl;
    if (now !== fsActive) { fsActive = now; renderControlButtons(); }
  }
  document.addEventListener('fullscreenchange', syncFsFromDom);
  document.addEventListener('webkitfullscreenchange', syncFsFromDom);

  var monitorResumeBtn = document.getElementById('monitorResumeBtn');
  var resumeArmed = false;

  function showResumeIfPaused() {
    if (!monitorResumeBtn) return;
    var paused = monitorVideo && monitorVideo.srcObject && monitorVideo.paused;
    monitorResumeBtn.classList.toggle('hidden', !paused);
  }

  function attemptResume() {
    if (!monitorVideo || !monitorVideo.srcObject) return;
    var p = monitorVideo.play();
    if (p && typeof p.catch === 'function') p.catch(function () { showResumeIfPaused(); });
  }

  function armAutoResume() {
    if (!monitorVideo || !monitorVideo.srcObject) return;
    resumeArmed = true;
    attemptResume();
  }

  if (monitorResumeBtn) {
    monitorResumeBtn.addEventListener('click', function () {
      monitorResumeBtn.classList.add('hidden');
      resumeArmed = false;
      if (monitorVideo) monitorVideo.play().catch(function () {});
    });
  }
  if (monitorVideo) {
    monitorVideo.addEventListener('pause', showResumeIfPaused);
    monitorVideo.addEventListener('play', function () { resumeArmed = false; if (monitorResumeBtn) monitorResumeBtn.classList.add('hidden'); });
    monitorVideo.addEventListener('playing', function () { resumeArmed = false; if (monitorResumeBtn) monitorResumeBtn.classList.add('hidden'); });
  }
  document.addEventListener('fullscreenchange', function () {
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) armAutoResume();
  });
  document.addEventListener('webkitfullscreenchange', function () {
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) armAutoResume();
  });

  // ─── Talk / FaceTalk / Mute ───────────────────────────
  async function startTalk(peerId) {
    if (talkingTo === peerId) return;
    try {
      await rtc.enableTalkback(peerId);
      sig.requestTalk(peerId);
      talkingTo = peerId;
      renderControlButtons();
    } catch (err) {
      console.error('[rc] startTalk failed', err);
      showToast('Microphone unavailable for talkback');
    }
  }

  function stopTalk(peerId) {
    if (!talkingTo) return;
    rtc.disableTalkback(peerId);
    sig.stopTalk(peerId);
    talkingTo = null;
    renderControlButtons();
  }

  function toggleTalk() {
    if (!viewingId) { showToast('Open a device feed first'); return; }
    if (talkingTo) stopTalk(viewingId);
    else startTalk(viewingId);
    showMonitorControls();
  }

  function toggleMute() {
    monitorMuted = !monitorMuted;
    if (monitorMuted) {
      mutedVolume = parseFloat(monitorVolume.value) || 100;
      applyVolume(0);
    } else {
      applyVolume(mutedVolume);
    }
    renderControlButtons();
  }

  // ─── Render devices ───────────────────────────────────
  function renderDevices() {
    var kiosks = devices.filter(function (d) { return (d.type === 'kiosk' || d.type === 'room') && d.id !== deviceId; });
    if (kiosks.length === 0) {
      deviceList.innerHTML = '<p class="hint" style="padding:12px">No kiosks connected</p>';
      return;
    }
    renderListView(kiosks);
  }

  function renderListView(kiosks) {
    deviceList.innerHTML = kiosks.map(function (d) {
      var isViewing = viewingId === d.id;
      var vActive = isViewing && viewMode === 'video';
      var aActive = isViewing && viewMode === 'audio';
      var type = sourceTypeFor(d.id);
      var videoOk = hasVideoType(type);
      var audioOk = hasAudioType(type);
      var alerting = audioState[d.id] && audioState[d.id].alerting;
      var st = audioState[d.id];
      var dbText = (st && st.levelDb != null) ? ' ' + Math.round(st.levelDb) + 'dB' : '';
      var zzz = (d.config && d.config.broadcastDisabled) ? ' <span class="broadcast-off" title="System broadcasts disabled">zzz</span>' : '';
      var itemClass = 'device-item' + (alerting ? ' audio-alert' : '');
      var audioBtn = audioOk
        ? '<button class="btn btn-small ' + (aActive ? 'btn-danger' : 'btn-outline') + ' audio-btn" data-id="' + d.id + '">' + (aActive ? 'Stop' : 'Audio') + '</button>'
        : '<button class="btn btn-small btn-disabled audio-btn" disabled data-id="' + d.id + '">Audio</button>';
      var videoBtn = videoOk
        ? '<button class="btn btn-small ' + (vActive ? 'btn-danger' : 'btn-outline') + ' video-btn" data-id="' + d.id + '">' + (vActive ? 'Stop' : 'Video') + '</button>'
        : '<button class="btn btn-small btn-disabled video-btn" disabled data-id="' + d.id + '">Video</button>';
      var settingsBtn = '<button class="btn btn-small btn-outline settings-btn" data-id="' + d.id + '">Settings</button>';
      return '<div class="' + itemClass + '" data-id="' + d.id + '">' +
        '<div class="device-info">' +
        '<div class="device-name">' + d.label + zzz + (dbText ? '<span class="db-readout">' + dbText + '</span>' : '') + '</div>' +
        '<div class="device-last-seen ' + (d.online ? 'online' : 'offline') + '">' + (d.online ? 'online' : formatTime(d.lastSeenAt)) + '</div>' +
        '</div>' +
        '<div class="btn-row">' + audioBtn + videoBtn + settingsBtn +
        '</div></div>';
    }).join('');
  }

  // ─── View management ──────────────────────────────────
  function startView(peerId, mode) {
    if (viewingId === peerId && viewMode === mode) { stopView(); return; }
    if (devices.find(function (d) { return d.id === peerId && (d.type !== 'kiosk' && d.type !== 'room'); })) return;
    var type = sourceTypeFor(peerId);
    if (mode === 'video' && !hasVideoType(type)) mode = 'audio';
    stopView();
    viewingId = peerId;
    viewMode = mode;
    localStorage.setItem('hearth_rcViewingId', peerId);
    rxDbgState.peer = peerId;
    rxDbgState.pc = 'new';
    rxDbgState.ice = 'new';
    rxDbgState.tracks = '--';
    rxDbgState.res = '--';
    rxDbgState.fps = '--';
    rxDbgState.br = '--';
    rxDbgState.rtt = '--';
    renderRxDebug();
    subscribed.add(peerId);
    sig.subscribeSource(peerId);
    showMonitor();
    renderDevices();
    attachMonitorStream();
    if (statsStop) { statsStop(); statsStop = null; }
    statsStop = rtc.startStats(peerId, updateQuality);
  }

  function stopView() {
    var oldId = viewingId;
    if (oldId) {
      rtc.closePeerConnection(oldId);
      if (subscribed.has(oldId)) { subscribed.delete(oldId); sig.unsubscribeSource(oldId); }
    }
    viewingId = null;
    viewMode = null;
    localStorage.removeItem('hearth_rcViewingId');
    recovering = false;
    recoverAttempts = 0;
    if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
    if (audioSourceNode) { try { audioSourceNode.disconnect(); } catch {} audioSourceNode = null; }
    monitorVideo.srcObject = null;
    monitorVideo.muted = true;
    if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.pause(); }
    monitorError.classList.add('hidden');
    hideMonitorControls();
    if (displayMode === 'self') showLocalCameraInMonitor();
    else if (displayMode === 'blank') {
      showHome();
    }
    rxDbgState.peer = null;
    rxDbgState.pc = '--';
    rxDbgState.ice = '--';
    rxDbgState.tracks = '--';
    rxDbgState.res = '--';
    rxDbgState.fps = '--';
    rxDbgState.br = '--';
    rxDbgState.rtt = '--';
    renderRxDebug();
    renderDevices();
    if (talkingTo) stopTalk(talkingTo);
    if (statsStop) { statsStop(); statsStop = null; }
    if (monitorQuality) monitorQuality.textContent = '';
  }

  function showMonitor() {
    monitorFeed.classList.remove('hidden');
    monitorError.classList.add('hidden');
    showMonitorStatus(null);
    showMonitorControls();
  }

  function showHome() {
    monitorFeed.classList.add('hidden');
  }

  function updateQuality(stats) {
    if (viewingId && stats && (stats.state === 'connected' || stats.iceState === 'connected' || stats.iceState === 'completed')) {
      lastActivity[viewingId] = Date.now();
    }
    if (viewingId && stats) {
      if (stats.frameWidth && stats.frameHeight) rxDbgState.res = stats.frameWidth + 'x' + stats.frameHeight;
      if (stats.fps) rxDbgState.fps = stats.fps + 'fps';
      if (stats.bitrateKbps) rxDbgState.br = stats.bitrateKbps + 'kbps';
      if (stats.rttMs) rxDbgState.rtt = stats.rttMs + 'ms';
      renderRxDebug();
    }
    if (!monitorQuality) return;
    if (!stats || stats.state !== 'connected') { monitorQuality.textContent = stats ? '(' + stats.state + ')' : ''; return; }
    var parts = [];
    if (stats.bitrateKbps) parts.push(stats.bitrateKbps + ' kbps');
    if (stats.rttMs) parts.push('RTT ' + stats.rttMs + ' ms');
    if (stats.packetsLost) parts.push('lost ' + stats.packetsLost);
    monitorQuality.textContent = parts.length ? parts.join(' . ') : 'connected';
  }

  // ─── Watch recovery ───────────────────────────────────
  function recoverWatch() {
    if (!viewingId || recovering) return;
    recovering = true;
    recoverAttempts++;
    showMonitorStatus(recoverAttempts > 1 ? 'Reconnecting... (' + recoverAttempts + ')' : 'Reconnecting...');
    var pc = rtc.peerConnections.get(viewingId);
    if (pc) pc._restarting = true;
    rtc.closePeerConnection(viewingId);
    if (subscribed.has(viewingId)) sig.unsubscribeSource(viewingId);
    subscribed.delete(viewingId);
    sig.subscribeSource(viewingId);
    if (recoverTimer) clearTimeout(recoverTimer);
    recoverTimer = setTimeout(function () {
      if (!recovering) return;
      recovering = false;
      if (!viewingId) return;
      if (recoverAttempts < MAX_RECOVER_ATTEMPTS) {
        recoverWatch();
      } else {
        showMonitorStatus(null);
        monitorError.textContent = 'Stream lost - still retrying...';
        monitorError.classList.remove('hidden');
        renderDevices();
        recoverTimer = setTimeout(function () { if (viewingId) recoverWatch(); }, RECOVER_RETRY_MS);
      }
    }, RECOVER_TIMEOUT);
  }

  function watchdog() {
    if (!viewingId || !viewMode || recovering) return;
    var type = sourceTypeFor(viewingId);
    if (!type) return;
    var last = lastActivity[viewingId] || 0;
    var deadFor = Date.now() - last;
    if (deadFor > WATCH_DEAD_MS) {
      var expectVideo = hasVideoType(type);
      var expectAudio = hasAudioType(type);
      var stream = streams[viewingId];
      var gotVideo = stream ? stream.getVideoTracks().length > 0 : false;
      var gotAudio = stream ? stream.getAudioTracks().length > 0 : false;
      var noExpectedActivity =
        (expectVideo && !gotVideo && !gotAudio) ||
        (expectAudio && !gotAudio && !gotVideo) ||
        (expectVideo && expectAudio && !gotVideo && !gotAudio);
      if (noExpectedActivity) recoverWatch();
    }
  }

  // ─── Incoming call ────────────────────────────────────
  function showIncomingCall(data) {
    if (!incomingCall) return;
    incomingCallFrom.textContent = (data.label || data.from) + ' is calling';
    incomingCall.dataset.from = data.from;
    incomingCall.classList.remove('hidden');
    if (incomingCall._timer) clearTimeout(incomingCall._timer);
    incomingCall._timer = setTimeout(function () { incomingCall.classList.add('hidden'); }, 30000);
  }

  function answerCall() {
    if (!incomingCall) return;
    var from = incomingCall.dataset.from;
    incomingCall.classList.add('hidden');
    if (!from) return;
    startView(from, 'video');
    startTalk(from);
    sig.sendCallState(from, 'connected');
    showToast('Call connected');
  }

  function dismissCall() {
    if (!incomingCall) return;
    var from = incomingCall.dataset.from;
    incomingCall.classList.add('hidden');
    if (from) sig.sendCallState(from, 'ended');
  }

  // ─── Config panel ─────────────────────────────────────
  function showConfig(device) {
    configPanel.classList.remove('hidden');
    configDeviceId = device.id;
    configTitle.textContent = device.label + ' Settings';
    renderConfigForm(device);
    sig.getConfig(device.id);
  }

  function renderConfigForm(device) {
    var caps = capabilitiesByDevice[device.id];
    var cfg = device.config || {};
    var displayMode = cfg.displayMode || 'blank';
    var broadcastsDisabled = cfg.broadcastDisabled === true;

    var cameraRow;
    if (caps && caps.videoDevices && caps.videoDevices.length) {
      var opts = caps.videoDevices.map(function (v) {
        return '<option value="' + v.id + '" ' + (cfg.videoDevice === v.id ? 'selected' : '') + '>' + (v.label || v.id) + '</option>';
      }).join('');
      cameraRow = '<div class="config-row"><label>Camera</label><select id="cfg-camera">' + opts + '</select></div>';
    } else {
      cameraRow = '<div class="config-row"><label>Camera</label><select id="cfg-camera">' +
        '<option value="front" ' + (cfg.camera !== 'rear' ? 'selected' : '') + '>Front</option>' +
        '<option value="rear" ' + (cfg.camera === 'rear' ? 'selected' : '') + '>Rear</option></select></div>';
    }

    var audioSourceRow = '';
    if (caps && caps.audioDevices && caps.audioDevices.length) {
      var aOpts = caps.audioDevices.map(function (a) {
        return '<option value="' + a.id + '" ' + (cfg.audioDevice === a.id ? 'selected' : '') + '>' + (a.label || a.id) + '</option>';
      }).join('');
      audioSourceRow = '<div class="config-row"><label>Microphone</label><select id="cfg-audioDevice">' + aOpts + '</select></div>';
    }

    var alertEnabled = cfg.audioAlertEnabled !== false;
    var alertThreshold = (cfg.audioAlertThresholdDb != null) ? cfg.audioAlertThresholdDb : -40;
    var hasAudioCap = hasAudioType(sourceTypeFor(device.id)) || (caps && caps.audioDevices && caps.audioDevices.length > 0);

    configForm.innerHTML =
      '<div class="config-row"><label>Label</label><input type="text" id="cfg-label" value="' + device.label + '"></div>' +
      cameraRow + audioSourceRow +
      '<div class="config-row"><label>Resolution</label><select id="cfg-resolution">' +
      '<option value="480p" ' + (cfg.resolution === '480p' ? 'selected' : '') + '>480p</option>' +
      '<option value="720p" ' + (cfg.resolution !== '480p' && cfg.resolution !== '1080p' ? 'selected' : '') + '>720p</option>' +
      '<option value="1080p" ' + (cfg.resolution === '1080p' ? 'selected' : '') + '>1080p</option></select></div>' +
      '<div class="config-row"><label>Frame Rate</label><select id="cfg-framerate">' +
      '<option value="15" ' + (cfg.frameRate === 15 ? 'selected' : '') + '>15 fps</option>' +
      '<option value="24" ' + (cfg.frameRate !== 15 && cfg.frameRate !== 30 ? 'selected' : '') + '>24 fps</option>' +
      '<option value="30" ' + (cfg.frameRate === 30 ? 'selected' : '') + '>30 fps</option></select></div>' +
      '<div class="config-row"><label>View Self</label><div class="toggle-switch ' + (displayMode === 'self' ? 'active' : '') + '" id="cfg-displayMode"></div></div>' +
      '<div class="config-row"><label>Keep Awake</label><div class="toggle-switch ' + (cfg.keepAwake !== false ? 'active' : '') + '" id="cfg-keepAwake"></div></div>' +
      '<div class="config-row"><label>System Broadcasts</label><div class="toggle-switch ' + (!broadcastsDisabled ? 'active' : '') + '" id="cfg-broadcasts"></div></div>' +
      (hasAudioCap ? '<div class="config-row"><label>Audio Alert</label><div class="toggle-switch ' + (alertEnabled ? 'active' : '') + '" id="cfg-audioAlert"></div></div>' +
      '<div class="config-row"><label>Alert Threshold (dB)</label><input type="number" id="cfg-audioThreshold" value="' + alertThreshold + '"></div>' : '') +
      '<button id="removeDeviceBtn" class="btn btn-danger" style="margin-top:12px">Remove device</button>' +
      '<button id="saveConfigBtn" class="btn btn-primary" style="margin-top:12px">Save</button>';

    configForm.querySelectorAll('.toggle-switch').forEach(function (el) {
      el.addEventListener('click', function () { el.classList.toggle('active'); });
    });
    document.getElementById('saveConfigBtn').addEventListener('click', function () {
      var payload = {
        label: document.getElementById('cfg-label').value,
        resolution: document.getElementById('cfg-resolution').value,
        frameRate: parseInt(document.getElementById('cfg-framerate').value),
        keepAwake: document.getElementById('cfg-keepAwake').classList.contains('active'),
        broadcastDisabled: !document.getElementById('cfg-broadcasts').classList.contains('active'),
      };
      if (caps && caps.videoDevices && caps.videoDevices.length) payload.videoDevice = document.getElementById('cfg-camera').value;
      else payload.camera = document.getElementById('cfg-camera').value;
      if (caps && caps.audioDevices && caps.audioDevices.length) payload.audioDevice = document.getElementById('cfg-audioDevice').value;
      if (hasAudioCap) {
        payload.audioAlertEnabled = document.getElementById('cfg-audioAlert').classList.contains('active');
        payload.audioAlertThresholdDb = parseFloat(document.getElementById('cfg-audioThreshold').value);
      }
      sig.setConfig(device.id, payload);
      var newDisplay = document.getElementById('cfg-displayMode').classList.contains('active') ? 'self' : 'blank';
      sig.setDisplayConfig(device.id, newDisplay);
      configPanel.classList.add('hidden');
    });
    document.getElementById('removeDeviceBtn').addEventListener('click', function () {
      if (confirm('Remove ' + device.label + ' from the list?')) {
        sig.removeDevice(device.id);
        configPanel.classList.add('hidden');
      }
    });
  }

  // ─── Own camera (from camera.js) ──────────────────────
  var DIMS = { '480p': [640, 480], '720p': [1280, 720], '1080p': [1920, 1080] };

  function buildVideoConstraints(config) {
    var res = (config && config.resolution) || '720p';
    var cam = (config && config.camera) || 'front';
    var fr = (config && config.frameRate) || 24;
    var dims = DIMS[res] || DIMS['720p'];
    if (config && config.videoDevice) {
      return { video: { deviceId: { exact: config.videoDevice }, width: { ideal: dims[0] }, height: { ideal: dims[1] }, frameRate: { ideal: fr } } };
    }
    return { video: { facingMode: cam === 'rear' ? 'environment' : 'user', width: { ideal: dims[0] }, height: { ideal: dims[1] }, frameRate: { ideal: fr } } };
  }

  function buildAudioConstraints(config) {
    var proc = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (config && config.audioDevice) return { audio: { deviceId: { exact: config.audioDevice }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    return { audio: proc };
  }

  function stopLocalMedia() {
    if (localVideoStream) { localVideoStream.getTracks().forEach(function (t) { t.stop(); }); localVideoStream = null; }
    if (localAudioStream) { localAudioStream.getTracks().forEach(function (t) { t.stop(); }); localAudioStream = null; }
    hasVideo = false;
    hasAudio = false;
    stopAudioAnalyser();
    if (rtc.localStream) { rtc.localStream.getTracks().forEach(function (t) { t.stop(); }); rtc.localStream = null; }
  }

  function currentSourceType() {
    if (hasVideo && hasAudio) return 'video+audio';
    if (hasVideo) return 'video-only';
    if (hasAudio) return 'audio-only';
    return 'none';
  }

  function publishCurrentSource() {
    var type = currentSourceType();
    if (type === 'none') {
      if (publishedType && cameraSourceId) { sig.unpublishSource(cameraSourceId); publishedType = null; }
      return;
    }
    if (!cameraSourceId) cameraSourceId = 'cam-' + Date.now();
    if (type !== publishedType) {
      if (publishedType) sig.unpublishSource(cameraSourceId);
      sig.publishSource(cameraSourceId, sig.deviceLabel || 'Room Control', type);
      publishedType = type;
    }
  }

  function syncPeerTracks() {
    for (var entry of rtc.peerConnections) {
      rtc.syncTracksToPeer(entry[0]);
    }
  }

  async function startMedia() {
    try {
      stopLocalMedia();
      if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
      var constraints = Object.assign({}, buildVideoConstraints(currentConfig), buildAudioConstraints(currentConfig));
      var stream;
      try {
        stream = await rtc.startCamera(constraints);
      } catch (e) {
        try { stream = await rtc.startVideo(buildVideoConstraints(currentConfig)); } catch (e2) { showCameraError(e2); return; }
      }
      localVideoStream = new MediaStream(stream.getVideoTracks());
      localAudioStream = new MediaStream(stream.getAudioTracks());
      hasVideo = localVideoStream.getVideoTracks().length > 0;
      hasAudio = localAudioStream.getAudioTracks().length > 0;
      if (!hasVideo && !hasAudio) { showCameraError(new Error('No camera or microphone available')); return; }
      var merged = new MediaStream();
      if (localVideoStream) localVideoStream.getVideoTracks().forEach(function (t) { merged.addTrack(t); });
      if (localAudioStream) localAudioStream.getAudioTracks().forEach(function (t) { merged.addTrack(t); });
      rtc.localStream = merged;
      publishCurrentSource();
      setupAudioAnalyser();
      if (!viewingId) {
        if (displayMode === 'self') showLocalCameraInMonitor();
        else if (displayMode === 'blank') {
          monitorVideo.srcObject = null;
          monitorVideo.classList.add('hidden');
          monitorPlaceholder.classList.remove('hidden');
          monitorFeed.classList.remove('hidden');
          showMonitorControls();
        }
      }
      for (var subId of subscribers) offerToSubscriber(subId);
    } catch (err) {
      console.error('[rc] Media failed:', err);
    }
  }

  function offerToSubscriber(peerId) {
    if (!rtc.localStream) return;
    var existingPc = rtc.peerConnections.get(peerId);
    if (existingPc) { existingPc.close(); rtc.peerConnections.delete(peerId); }
    rtc.createPeerConnection(peerId, 'send');
  }

  function isLegacyIOS() {
    var ua = navigator.userAgent;
    var m = ua.match(/OS (\d+)_(\d+)_?(\d+)? like Mac OS X/);
    if (!m) return false;
    return parseInt(m[1], 10) < 13;
  }

  // ─── Audio analyser ───────────────────────────────────
  function stopAudioAnalyser() {
    if (audioMeterTimer) { clearInterval(audioMeterTimer); audioMeterTimer = null; }
    if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
  }

  function setupAudioAnalyser() {
    stopAudioAnalyser();
    if (!hasAudio || !localAudioStream) return;
    var track = localAudioStream.getAudioTracks()[0];
    if (!track) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var src = audioCtx.createMediaStreamSource(localAudioStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      audioMeterTickCount = 0;
      smoothRms = 0;
      audioMeterTimer = setInterval(audioMeterTick, 250);
    } catch (e) { console.error('[rc] analyser setup failed', e); }
  }

  function audioMeterTick() {
    if (!analyser || !hasAudio) return;
    var n = analyser.fftSize;
    var rms;
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      var buf = new Float32Array(n);
      analyser.getFloatTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      rms = Math.sqrt(sum / buf.length);
    } else {
      var bytes = new Uint8Array(n);
      analyser.getByteTimeDomainData(bytes);
      var sum2 = 0;
      for (var j = 0; j < bytes.length; j++) { var v = (bytes[j] - 128) / 128; sum2 += v * v; }
      rms = Math.sqrt(sum2 / bytes.length);
    }
    var alpha = 0.3;
    smoothRms = alpha * rms + (1 - alpha) * smoothRms;
    var db = 20 * Math.log10(smoothRms);
    if (!isFinite(db) || !isFinite(smoothRms)) db = -100;
    audioMeterTickCount++;
    var alertEnabled = currentConfig.audioAlertEnabled !== false;
    var threshold = (currentConfig.audioAlertThresholdDb != null) ? currentConfig.audioAlertThresholdDb : -40;
    var isAbove = db > threshold;
    if (audioMeterTickCount % 8 === 0) {
      sig.send('AUDIO_PEAK', { deviceId: sig.deviceId, levelDb: db, peak: alertEnabled && isAbove, ts: Date.now() });
    }
  }

  // ─── Wake lock ────────────────────────────────────────
  function makeSilentWavUrl(seconds, sampleRate) {
    seconds = seconds || 1;
    sampleRate = sampleRate || 8000;
    var numSamples = seconds * sampleRate;
    var buffer = new ArrayBuffer(44 + numSamples);
    var view = new DataView(buffer);
    var writeStr = function (off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples, true);
    for (var i = 44; i < 44 + numSamples; i++) view.setUint8(i, 128);
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  async function requestWakeLock() {
    if (!currentConfig.keepAwake) { releaseWakeLock(); return; }
    if ('wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener?.('release', function () { wakeLock = null; }); return; } catch {}
    }
    var nsa = document.getElementById('noSleepAudio');
    if (nsa) { try { if (!nsa.src) nsa.src = makeSilentWavUrl(); await nsa.play(); } catch {} }
  }

  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
    var nsa = document.getElementById('noSleepAudio');
    if (nsa) { try { nsa.pause(); } catch {} }
  }

  function applyRemoteAudio() {
    if (!remoteAudio) return;
    var vol = (currentConfig.speakerVolume != null) ? currentConfig.speakerVolume : 0.5;
    remoteAudio.volume = Math.max(0, Math.min(1, vol));
    remoteAudio.muted = false;
    remoteAudio.play().catch(function () {});
  }

  function subscribeToBroadcast(baseId) {
    if (broadcastPeerId === baseId) return;
    broadcastPeerId = baseId;
    sig.subscribeBroadcast(baseId);
  }

  function unsubscribeFromBroadcast() {
    if (broadcastPeerId) {
      sig.unsubscribeBroadcast(broadcastPeerId);
      rtc.closeBroadcastPeerConnection(broadcastPeerId);
      broadcastVideoActive = false;
      broadcastPeerId = null;
      if (!viewingId) {
        if (displayMode === 'self') showLocalCameraInMonitor();
        else if (displayMode === 'blank') {
          monitorVideo.srcObject = null;
          monitorVideo.classList.add('hidden');
          monitorPlaceholder.classList.remove('hidden');
          monitorFeed.classList.remove('hidden');
          showMonitorControls();
        }
      }
    }
  }

  // ─── Click handler ────────────────────────────────────
  document.addEventListener('click', function (e) {
    var t = e.target;
    var icon = t.closest && t.closest('#stopMonitorBtn, #monitorTalkBtn, #monitorMuteBtn, #monitorFullscreenBtn');
    if (icon) {
      switch (icon.id) {
        case 'stopMonitorBtn': stopView(); break;
        case 'monitorTalkBtn': toggleTalk(); break;
        case 'monitorMuteBtn': toggleMute(); break;
        case 'monitorFullscreenBtn': toggleFullscreen(); break;
      }
      return;
    }
    if (t.id === 'answerCallBtn') { answerCall(); return; }
    if (t.id === 'dismissCallBtn') { dismissCall(); return; }
    var audioBtn = t.closest('.audio-btn');
    if (audioBtn && !audioBtn.disabled) { startView(audioBtn.dataset.id, 'audio'); return; }
    var videoBtn = t.closest('.video-btn');
    if (videoBtn && !videoBtn.disabled) { startView(videoBtn.dataset.id, 'video'); return; }
    var settingsBtn = t.closest('.settings-btn');
    if (settingsBtn) {
      var id = settingsBtn.dataset.id;
      var d = devices.find(function (dev) { return dev.id === id; });
      if (d) showConfig(d);
      return;
    }
  });

  // ─── WebRTC callbacks ─────────────────────────────────
  rtc.onRemoteTrack = function (peerId, stream, track) {
    streams[peerId] = stream;
    lastActivity[peerId] = Date.now();
    if (peerId === viewingId) {
      recoverAttempts = 0;
      if (recovering) {
        recovering = false;
        if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
        showMonitorStatus(null);
        monitorError.classList.add('hidden');
      }
      var v = stream.getVideoTracks().length;
      var a = stream.getAudioTracks().length;
      rxDbgState.tracks = (v || a) ? (v + 'v ' + a + 'a') : '--';
      renderRxDebug();
      attachMonitorStream();
    }
    // Broadcast stream from a base station (FaceTalk)
    if (peerId === broadcastPeerId || (broadcastPeerId && peerId.startsWith('broadcast-'))) {
      if (track.kind === 'video') {
        broadcastVideoActive = true;
        if (!viewingId) {
          monitorVideo.srcObject = stream;
          monitorVideo.muted = true;
          monitorVideo.play().catch(function () {});
          monitorFeed.classList.remove('hidden');
          monitorError.classList.add('hidden');
          monitorPlaceholder.classList.add('hidden');
          monitorVideo.classList.remove('hidden');
          showMonitorControls();
        }
      } else if (track.kind === 'audio') {
        remoteAudio.srcObject = stream;
        applyRemoteAudio();
      }
    } else if (track.kind === 'audio') {
      remoteAudio.srcObject = stream;
      applyRemoteAudio();
    }
  };

  rtc.onConnectionStateChange = function (peerId, state) {
    if (peerId === viewingId) {
      rxDbgState.pc = state;
      renderRxDebug();
      if (state === 'failed') recoverWatch();
    }
  };

  rtc.onIceConnectionStateChange = function (peerId, state) {
    if (peerId === viewingId) {
      rxDbgState.ice = state;
      renderRxDebug();
      if (state === 'failed') recoverWatch();
    }
  };

  rtc.onPeerDisconnected = function (peerId) {
    if (peerId === viewingId) recoverWatch();
  };

  // ─── Init ─────────────────────────────────────────────
  function init() {
    sig.deviceId = deviceId;
    sig.deviceType = 'room';
    sig.deviceLabel = 'Room Control';
    sig.connect();

    if (monitorFeed) {
      monitorFeed.addEventListener('click', function (e) {
        if (e.target.closest('.monitor-overlay')) return;
        showMonitorControls();
      });
    }

    setInterval(watchdog, 2000);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && currentConfig.keepAwake) requestWakeLock();
    });

    sig.on('open', function () {
      connectionDot.className = 'status-dot reconnecting';
      sig.joinRoom('default', deviceId, currentConfig);
      ftDbgState.wsMethod = sig.useSSE ? 'SSE' : 'WS';
      ftDbgState.wsUp = true;
      renderFtDebug();
    });

    sig.on('welcome', function (data) {
      deviceId = data.deviceId;
      localStorage.setItem('hearth_rcDeviceId', deviceId);
      connectionDot.className = 'status-dot online';
      sources = data.sources || [];
      devices = data.recentlySeenDevices || [];
      renderDevices();
      // Default display mode to blank (off) on every connect
      displayMode = 'blank';
      // Apply blank mode immediately if not viewing a remote feed
      if (!viewingId) {
        showHome();
      }
      // Auto-resume last viewed feed
      var lastViewing = localStorage.getItem('hearth_rcViewingId');
      if (lastViewing && sources.some(function (s) { return s.publisherId === lastViewing; })) {
        startView(lastViewing, 'video');
      }
      // Start own camera
      startMedia();
      requestWakeLock();
    });

    sig.on('close', function () {
      connectionDot.className = 'status-dot offline';
      publishedType = null;
      ftDbgState.wsUp = false;
      renderFtDebug();
    });

    sig.on('sourceAdded', function (source) {
      var existing = sources.find(function (s) { return s.id === source.id; });
      if (existing) { existing.type = source.type; existing.label = source.label; }
      else { sources.push(source); showToast('Source online: ' + (source.label || source.id)); }
      if (source.isBroadcast && source.publisherId !== deviceId) {
        if (source.targetDeviceId && source.targetDeviceId !== deviceId) return;
        subscribeToBroadcast(source.publisherId);
      }
      renderDevices();
    });

    sig.on('sourceRemoved', function (data) {
      var removed = sources.find(function (s) { return s.id === data.sourceId; });
      var pubId = removed ? removed.publisherId : data.sourceId;
      sources = sources.filter(function (s) { return s.id !== data.sourceId; });
      delete streams[data.sourceId];
      delete streams[pubId];
      subscribed.delete(pubId);
      if (pubId === viewingId) {
        rtc.closePeerConnection(viewingId);
        if (audioSourceNode) { try { audioSourceNode.disconnect(); } catch {} audioSourceNode = null; }
        viewingId = null;
        viewMode = null;
        recovering = false;
        if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
        monitorVideo.srcObject = null;
        if (displayMode === 'self') showLocalCameraInMonitor();
        else if (displayMode === 'blank') {
          monitorVideo.srcObject = null;
          monitorVideo.classList.add('hidden');
          monitorPlaceholder.classList.remove('hidden');
          monitorFeed.classList.remove('hidden');
          showMonitorControls();
        }
      }
      if (broadcastPeerId && data.sourceId) unsubscribeFromBroadcast();
      renderDevices();
    });

    sig.on('subscriberJoined', function (data) {
      subscriberCount++;
      var peerId = data.subscriberId;
      subscribers.add(peerId);
      if (!rtc.localStream) return;
      offerToSubscriber(peerId);
    });

    sig.on('subscriberLeft', function (data) {
      subscriberCount = Math.max(0, subscriberCount - 1);
      subscribers.delete(data.subscriberId);
      rtc.closePeerConnection(data.subscriberId);
    });

    sig.on('doorbell', function (data) {
      showIncomingCall(data);
      showToast((data.label || data.from) + ' is calling');
    });

    sig.on('audioPeak', function (data) {
      audioState[data.deviceId] = { levelDb: data.levelDb, alerting: !!data.peak };
      updateAudioMeterUi(data.deviceId);
    });

    sig.on('capabilities', function (data) {
      capabilitiesByDevice[data.deviceId] = { videoDevices: data.videoDevices || [], audioDevices: data.audioDevices || [] };
      renderDevices();
    });

    sig.on('deviceRemoved', function (data) {
      var id = data.deviceId;
      devices = devices.filter(function (d) { return d.id !== id; });
      delete audioState[id];
      if (id === viewingId) stopView();
      renderDevices();
    });

    sig.on('deviceStatus', function (data) {
      var wasKnown = devices.some(function (dev) { return dev.id === data.deviceId; });
      var d = devices.find(function (dev) { return dev.id === data.deviceId; });
      if (d) {
        d.online = data.status === 'online';
        d.lastSeenAt = data.lastSeenAt || Date.now();
        if (data.label) d.label = data.label;
        if (data.type) d.type = data.type;
        if (data.config) d.config = data.config;
      } else if (data.status === 'online' && data.type) {
        devices.push({ id: data.deviceId, label: data.label || data.deviceId, type: data.type, lastSeenAt: data.lastSeenAt || Date.now(), online: true, config: data.config || {} });
        if (!wasKnown && (data.type === 'kiosk' || data.type === 'room')) showToast('Device joined: ' + (data.label || data.deviceId));
      }
      if (data.deviceId === viewingId && data.status === 'offline') {
        monitorError.textContent = 'Kiosk went offline.';
        monitorError.classList.remove('hidden');
      }
      renderDevices();
    });

    // Handle broadcast sources (FaceTalk from base stations)
    sig.on('sourceAdded', function (source) {
      if (source.isBroadcast && source.publisherId !== deviceId) {
        // Check if this broadcast is targeted at us
        if (source.targetDeviceId && source.targetDeviceId !== deviceId) return;
        if (currentConfig.broadcastDisabled) return;
        sig.subscribeBroadcast(source.publisherId);
      }
    });

    sig.on('sourceRemoved', function (data) {
      // Check if removed source was a broadcast we were receiving
      if (broadcastPeerId) {
        var removed = sources.find(function (s) { return s.id === data.sourceId; });
        if (removed && removed.isBroadcast && removed.publisherId === broadcastPeerId) {
          unsubscribeFromBroadcast();
        }
      }
    });

    sig.on('setDisplayConfig', function (data) {
      var mode = data.displayMode;
      if (!mode) return;
      displayMode = mode;
      if (viewingId) return; // don't override active remote view

      if (mode === 'blank') {
        monitorVideo.srcObject = null;
        monitorVideo.classList.add('hidden');
        monitorPlaceholder.classList.remove('hidden');
        monitorFeed.classList.remove('hidden');
        showMonitorControls();
      } else if (mode === 'self') {
        showLocalCameraInMonitor();
      } else if (mode === 'base' && broadcastPeerId) {
        // Base station told us to display the broadcast feed
        var stream = streams[broadcastPeerId];
        if (stream && stream.getVideoTracks().length > 0) {
          monitorVideo.srcObject = stream;
          monitorVideo.muted = true;
          monitorVideo.play().catch(function () {});
          monitorFeed.classList.remove('hidden');
          monitorError.classList.add('hidden');
          showMonitorControls();
        }
      }
    });

    sig.on('configUpdated', function (data) {
      if (data.config) {
        currentConfig = Object.assign({}, currentConfig, data.config);
        saveSettings(currentConfig);
        // Note: displayMode is intentionally NOT applied here — it's controlled
        // exclusively by SET_DISPLAY_CONFIG from a base station. The welcome handler
        // forces blank on every connect.
      }
    });

    sig.on('error', function (err) {
      console.error('[rc] signaling ERROR:', err);
    });

    sig.connect();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
