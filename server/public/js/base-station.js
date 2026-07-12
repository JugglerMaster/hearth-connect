(function () {
  'use strict';

  // Surface uncaught errors on-device (no Safari dev tools on iPad Air).
  window.addEventListener('error', function (e) {
    const detail = e && e.message ? e.message : 'unknown error';
    const where = e && e.filename ? ' @' + e.filename + ':' + e.lineno : '';
    console.error('[base] window error' + where + ': ' + detail);
  });
  window.addEventListener('unhandledrejection', function (e) {
    const reason = e && e.reason ? (e.reason.message || String(e.reason)) : 'unhandled rejection';
    console.error('[base] unhandledrejection:', reason);
  });

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_baseDeviceId') || 'base-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  let sources = [];
  let devices = [];
  let viewingId = null;
  let viewMode = null; // 'video' | 'audio'
  let subscribed = new Set();
  let streams = {};
  let capabilitiesByDevice = {}; // deviceId → { videoDevices, audioDevices }
  let audioState = {};           // deviceId → { levelDb, alerting }
  let lastActivity = {};         // peerId → ts of last track activity

  // Broadcast state
  let isBroadcasting = false;
  let broadcastSourceId = null;
  let broadcastStream = null;
  let broadcastVideoTrack = null;
  let broadcastAudioTrack = null;
  let broadcastSubscribers = new Set(); // kioskIds receiving our broadcast

  // Grid view state
  let gridMode = false; // false = single view, true = 2x2 grid
  let gridViewingIds = new Set(); // Set of kioskIds being viewed in grid

  // Grid view state (sources)
  let gridSources = []; // Array of {deviceId, label, stream} for grid

  // Additional broadcast media-selection state (localBroadcastStream is the
  // live preview/broadcast stream owned by the base station).
  let broadcastVideoDevice = null;
  let broadcastAudioDevice = null;
  let localBroadcastStream = null;

  // Watch recovery state
  let recovering = false;
  let recoverTimer = null;
  const WATCH_DEAD_MS = 8000;
  const RECOVER_TIMEOUT = 10000;

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
  const monitorFaceTalkBtn = document.getElementById('monitorFaceTalkBtn');
  const monitorQuality = document.getElementById('monitorQuality');
  const ftDebug = document.getElementById('ftDebug');
  const toast = document.getElementById('toast');
  const homeView = document.getElementById('homeView');
  const deviceList = document.getElementById('deviceList');
  const configPanel = document.getElementById('configPanel');
  const configForm = document.getElementById('configForm');
  const configTitle = document.getElementById('configTitle');
  const incomingCall = document.getElementById('incomingCall');
  const incomingCallFrom = document.getElementById('incomingCallFrom');
  const answerCallBtn = document.getElementById('answerCallBtn');
  const dismissCallBtn = document.getElementById('dismissCallBtn');
  let configDeviceId = null;

  // Talk / mute / call state (per active view)
  let talkingTo = null;       // deviceId we are currently talking to
  let faceTalkingTo = null;   // kioskId we are currently pushing video+audio to
  let faceTalkSourceId = null; // broadcast source id owned by FaceTalk
  let faceTalkRestore = null; // { displayMode, audioMode } to restore on hang-up
  let monitorMuted = false;   // base station speaker mute for the live stream
  let statsStop = null;       // getStats polling cleanup for the active view
  let mutedVolume = 100;      // volume to restore after unmute

  // Broadcast UI elements (created dynamically)
  let broadcastPanel = null;
  let broadcastPreview = null;
  let broadcastVideoSel = null;
  let broadcastAudioSel = null;
  let broadcastBtn = null;

  // ─── Volume control ──
  // Slider 0–200 → gain 0–2×.  100 = unity, 200 = double (+6 dB).
  // Audio is routed through a MediaStreamSource + GainNode (NOT through the
  // video element).  The video element is muted so its direct Safari audio path
  // doesn't bypass the GainNode.
  let audioCtx = null;
  let gainNode = null;
  let audioSourceNode = null; // MediaStreamAudioSourceNode (disconnected on stop)

  function ensureAudioGraph() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return;
    }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      gainNode = audioCtx.createGain();
      gainNode.connect(audioCtx.destination);
    } catch (e) {
      console.error('[volume] audio graph setup failed', e);
    }
  }

  function connectAudioSource(stream) {
    if (!gainNode || !audioCtx) return;
    if (audioSourceNode) {
      try { audioSourceNode.disconnect(); } catch {}
      audioSourceNode = null;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const audioStream = new MediaStream([track]);
    audioSourceNode = audioCtx.createMediaStreamSource(audioStream);
    audioSourceNode.connect(gainNode);
  }

  function applyVolume(value) {
    const n = parseFloat(value);
    const v = Math.max(0, Math.min(200, isNaN(n) ? 100 : n));
    const gain = v / 100; // 0→0, 100→1.0, 200→2.0
    if (gainNode) {
      gainNode.gain.value = gain;
    }
  }

  // ─── Two-way talkback (base → kiosk reverse audio) ─────
  // enableTalkback() acquires the base mic and adds it as a track to the live
  // monitor PC; webrtc.js's onnegotiationneeded then renegotiates so the audio
  // actually flows to the kiosk. We also tell the kiosk to unmute its speaker.
  async function startTalk(peerId) {
    if (talkingTo === peerId) return;
    try {
      await rtc.enableTalkback(peerId);
      sig.requestTalk(peerId);
      talkingTo = peerId;
      if (monitorTalkBtn) {
        monitorTalkBtn.textContent = '🎙 Talking…';
        monitorTalkBtn.classList.add('btn-danger');
        monitorTalkBtn.classList.remove('btn-outline');
      }
      console.log('[base] talkback ON to', peerId);
    } catch (err) {
      console.error('[base] startTalk failed', err);
      showToast('Microphone unavailable for talkback');
    }
  }

  function stopTalk(peerId) {
    if (!talkingTo) return;
    rtc.disableTalkback(peerId);
    sig.stopTalk(peerId);
    talkingTo = null;
    if (monitorTalkBtn) {
      monitorTalkBtn.textContent = '🎙 Talk';
      monitorTalkBtn.classList.remove('btn-danger');
      monitorTalkBtn.classList.add('btn-outline');
    }
    console.log('[base] talkback OFF to', peerId);
  }

  // ─── FaceTalk (base → kiosk reverse video+audio) ──────
  // Debug readout for the base→kiosk audio/video (FaceTalk/broadcast) link.
  // Rendered at the top of the monitor video area. Tracks the signaling (WS/SSE)
  // transport plus the per-kiosk broadcast RTCPeerConnection + track state.
  let ftDbgState = {
    wsMethod: '--',
    wsUp: false,
    target: null,      // kioskId we are FaceTalking to
    sourceId: null,    // broadcast source id
    pc: '--',          // broadcast PC connection state
    ice: '--',         // broadcast PC ICE state
    tracks: '--',      // tracks added to the broadcast PC
  };
  function renderFtDebug() {
    if (!ftDebug) return;
    const d = ftDbgState;
    const tgt = d.target ? d.target.slice(-4) : '—';
    ftDebug.textContent =
      'ft:' + (d.target ? 'ON→' + tgt : 'idle') +
      '  ws:' + d.wsMethod + (d.wsUp ? '↑' : '↓') +
      '  src:' + (d.sourceId ? d.sourceId.slice(-6) : '—') +
      '  pc:' + d.pc + '  ice:' + d.ice +
      '  tracks:' + d.tracks;
  }

  // Starts a video+audio broadcast from the base station to the watched kiosk
  // and temporarily switches that kiosk's display to 'base' so the feed is
  // shown/heard. The kiosk's previous display/audio mode is restored on hang-up.
  async function startFaceTime(peerId) {
    if (faceTalkingTo === peerId) return;
    try {
      const dev = devices.find(d => d.id === peerId);
      faceTalkRestore = {
        displayMode: dev?.config?.displayMode || 'self',
        audioMode: dev?.config?.audioMode || 'mute',
      };

      if (!localBroadcastStream) {
        await ensureBroadcastStream();
      }
      if (!localBroadcastStream) {
        showToast('FaceTalk failed: no camera/mic available');
        return;
      }

      // Keep FaceTalk's source id separate from a manually-started broadcast
      // so stopping FaceTalk doesn't tear down an independent broadcast.
      faceTalkSourceId = 'broadcast-' + deviceId + '-' + Date.now();
      broadcastStream = localBroadcastStream;
      // Mark as broadcasting so the base creates a broadcast PC when the kiosk
      // subscribes to this source (see the subscriberJoined handler).
      isBroadcasting = true;
      sig.broadcastSource(faceTalkSourceId, 'Base Station FaceTalk', 'video+audio');

      // Switch the target kiosk to show/hear the base's broadcast.
      sig.setDisplayConfig(peerId, 'base', 'base');

      faceTalkingTo = peerId;
      ftDbgState.target = peerId;
      ftDbgState.sourceId = faceTalkSourceId;
      ftDbgState.pc = 'new';
      ftDbgState.ice = 'new';
      ftDbgState.tracks = '--';
      renderFtDebug();
      if (monitorFaceTalkBtn) {
        monitorFaceTalkBtn.textContent = '📹 FaceTalking…';
        monitorFaceTalkBtn.classList.add('btn-danger');
        monitorFaceTalkBtn.classList.remove('btn-outline');
      }
      console.log('[base] FaceTalk ON to', peerId);
    } catch (err) {
      console.error('[base] startFaceTime failed', err);
      showToast('Camera/microphone unavailable for FaceTalk');
    }
  }

  function stopFaceTime(peerId) {
    if (!faceTalkingTo) return;
    if (faceTalkSourceId) {
      sig.unbroadcastSource(faceTalkSourceId);
      faceTalkSourceId = null;
    }
    // Close only the broadcast PC opened to this kiosk for FaceTalk.
    broadcastSubscribers.forEach(kioskId => {
      if (kioskId === peerId) rtc.closeBroadcastPeerConnection(kioskId);
    });
    broadcastSubscribers.delete(peerId);
    // Restore the broadcasting flag to reflect any manual broadcast still active.
    isBroadcasting = !!broadcastSourceId;

    if (faceTalkRestore) {
      sig.setDisplayConfig(faceTalkingTo, faceTalkRestore.displayMode, faceTalkRestore.audioMode);
      faceTalkRestore = null;
    }

    faceTalkingTo = null;
    ftDbgState.target = null;
    ftDbgState.sourceId = null;
    ftDbgState.pc = '--';
    ftDbgState.ice = '--';
    ftDbgState.tracks = '--';
    renderFtDebug();
    if (monitorFaceTalkBtn) {
      monitorFaceTalkBtn.textContent = '📹 FaceTalk';
      monitorFaceTalkBtn.classList.remove('btn-danger');
      monitorFaceTalkBtn.classList.add('btn-outline');
    }
    console.log('[base] FaceTalk OFF to', peerId);
  }

  function toggleFaceTime() {
    if (!viewingId) { showToast('Open a device feed first'); return; }
    if (faceTalkingTo) stopFaceTime(faceTalkingTo);
    else startFaceTime(viewingId);
    showMonitorControls();
  }

  function toggleTalk() {
    if (!viewingId) { showToast('Open a device feed first'); return; }
    if (talkingTo) stopTalk(viewingId);
    else startTalk(viewingId);
    showMonitorControls();
  }

  // ─── Speaker mute (affects the live GainNode, not just stored config) ──
  function toggleMute() {
    monitorMuted = !monitorMuted;
    if (monitorMuted) {
      mutedVolume = parseFloat(monitorVolume.value) || 100;
      applyVolume(0);
      if (monitorMuteBtn) {
        monitorMuteBtn.textContent = '🔈 Unmute';
        monitorMuteBtn.classList.add('btn-danger');
        monitorMuteBtn.classList.remove('btn-outline');
      }
    } else {
      applyVolume(mutedVolume);
      if (monitorMuteBtn) {
        monitorMuteBtn.textContent = '🔇 Mute';
        monitorMuteBtn.classList.remove('btn-danger');
        monitorMuteBtn.classList.add('btn-outline');
      }
    }
  }

  // ─── Connection-quality indicator (getStats) ──────────
  function updateQuality(stats) {
    if (!monitorQuality) return;
    if (!stats || stats.state !== 'connected') {
      monitorQuality.textContent = stats ? `(${stats.state})` : '';
      return;
    }
    const parts = [];
    if (stats.bitrateKbps) parts.push(`${stats.bitrateKbps} kbps`);
    if (stats.rttMs) parts.push(`RTT ${stats.rttMs} ms`);
    if (stats.packetsLost) parts.push(`lost ${stats.packetsLost}`);
    if (stats.jitterMs) parts.push(`jit ${stats.jitterMs} ms`);
    monitorQuality.textContent = parts.length ? `▮ ${parts.join(' · ')}` : '▮ connected';
  }

  // ─── Incoming doorbell / call ─────────────────────────
  function showIncomingCall(data) {
    if (!incomingCall) return;
    incomingCallFrom.textContent = (data.label || data.from) + ' is calling';
    incomingCall.dataset.from = data.from;
    incomingCall.classList.remove('hidden');
    // Auto-dismiss the modal prompt after 30s if not answered.
    if (incomingCall._timer) clearTimeout(incomingCall._timer);
    incomingCall._timer = setTimeout(() => {
      incomingCall.classList.add('hidden');
    }, 30000);
  }

  function answerCall() {
    if (!incomingCall) return;
    const from = incomingCall.dataset.from;
    incomingCall.classList.add('hidden');
    if (!from) return;
    // Open the feed (subscribe + watch) and start two-way talkback.
    startView(from, 'video');
    startTalk(from);
    sig.sendCallState(from, 'connected');
    showToast('Call connected to ' + (devices.find(d => d.id === from)?.label || from));
  }

  function dismissCall() {
    if (!incomingCall) return;
    const from = incomingCall.dataset.from;
    incomingCall.classList.add('hidden');
    if (from) sig.sendCallState(from, 'ended');
  }

  let initVol = parseFloat(localStorage.getItem('hearth_baseVolume'));
  if (!isFinite(initVol) || initVol < 0 || initVol > 200) initVol = 100;
  monitorVolume.value = initVol;
  applyVolume(initVol);

  function updateTrackFill() {
    monitorVolume.style.setProperty('--vol-pct', (monitorVolume.value / 200 * 100) + '%');
  }

  updateTrackFill();

  monitorVolume.addEventListener('input', () => {
    updateTrackFill();
    ensureAudioGraph();
    applyVolume(monitorVolume.value);
    localStorage.setItem('hearth_baseVolume', monitorVolume.value);
  });

  function formatTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  // Map a device to its published source type (or null if none)
  function sourceTypeFor(id) {
    const src = sources.find(s => s.publisherId === id);
    return src ? src.type : null;
  }

  function hasVideo(type) {
    return type === 'video+audio' || type === 'video-only';
  }
  function hasAudio(type) {
    return type === 'video+audio' || type === 'audio-only';
  }

  // ─── Transient toast (e.g. "device XXX joined") ──────────
  let toastTimer = null;
  function showToast(msg, ms = 4000) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  function showMonitorStatus(text) {
    if (!text) {
      monitorStatus.classList.add('hidden');
      monitorStatus.textContent = '';
      return;
    }
    monitorStatus.textContent = text;
    monitorStatus.classList.remove('hidden');
  }

  function attachMonitorStream() {
    if (!viewingId) return;
    const stream = streams[viewingId];
    if (!stream) return;
    monitorVideo.srcObject = stream;
    applyViewMode();
    ensureAudioGraph();
    connectAudioSource(stream);
    applyVolume(monitorVolume.value);
    monitorVideo.muted = true; // Video element renders video only; audio goes through GainNode
    monitorVideo.play().catch(() => {});
  }

  function applyViewMode() {
    if (!viewingId) return;
    const stream = streams[viewingId];
    if (!stream) return;
    const vTracks = stream.getVideoTracks();
    // Audio-only mode: hide the video surface but keep the received track enabled.
    // (Disabling a *received* track and re-enabling it is unreliable on iOS
    // Safari and can leave the track unrenderable when switching back to video.)
    if (viewMode === 'audio') {
      monitorVideo.classList.add('hidden');
      monitorPlaceholder.classList.remove('hidden');
      return;
    }
    // Video mode:
    if (vTracks.length === 0) {
      // Video track not arrived yet (tracks fire as separate ontrack events).
      // Keep waiting — do NOT downgrade viewMode, just show a connecting state.
      monitorVideo.classList.add('hidden');
      monitorPlaceholder.classList.remove('hidden');
      return;
    }
    monitorVideo.classList.remove('hidden');
    monitorPlaceholder.classList.add('hidden');
  }

  // In-place update of a device's dB readout + alert highlight. Used by the
  // AUDIO_PEAK handler so we never rebuild the device list (which would clobber
  // an open display/audio <select> the operator is interacting with).
  function updateAudioMeterUi(id) {
    const st = audioState[id];
    if (!st) return;
    const item = deviceList.querySelector('.device-item[data-id="' + id + '"]');
    if (!item) return;
    const dbText = (st.levelDb != null) ? ` ${Math.round(st.levelDb)}dB` : '';
    let readout = item.querySelector('.db-readout');
    if (st.levelDb != null) {
      if (!readout) {
        readout = document.createElement('span');
        readout.className = 'db-readout';
        const name = item.querySelector('.device-name');
        if (name) name.appendChild(readout);
      }
      readout.textContent = dbText;
    } else if (readout) {
      readout.remove();
    }
    if (st.alerting) item.classList.add('audio-alert');
    else item.classList.remove('audio-alert');
  }

  function renderDevices() {
    const kiosks = devices.filter(d => d.type === 'kiosk' && d.id !== deviceId);
    const bases = devices.filter(d => d.type === 'base' && d.id !== deviceId);

    // Build broadcast panel HTML.
    // Only show when NOT actively watching a device feed (no video/audio
    // option selected). While a feed is open we hide the broadcast controls.
    let broadcastPanel = '';
    if (!viewingId && bases.length === 0 && devices.some(d => d.id === deviceId && d.type === 'base')) {
      // We are the only base or first base - show broadcast controls
      broadcastPanel = buildBroadcastPanel();
    }

    if (kiosks.length === 0) {
      deviceList.innerHTML = broadcastPanel + '<p class="hint" style="padding:12px">No kiosks connected</p>';
      return;
    }

    if (gridMode) {
      renderGridView(kiosks, broadcastPanel);
    } else {
      renderListView(kiosks, broadcastPanel);
    }
  }

  function buildBroadcastPanel() {
    const caps = capabilitiesByDevice[deviceId];
    let cameraOptions = '';
    let micOptions = '';

    if (caps && caps.videoDevices && caps.videoDevices.length) {
      cameraOptions = caps.videoDevices.map(v =>
        `<option value="${v.id}">${v.label || v.id}</option>`
      ).join('');
    } else {
      cameraOptions = `<option value="front">Front</option><option value="rear">Rear</option>`;
    }

    if (caps && caps.audioDevices && caps.audioDevices.length) {
      micOptions = caps.audioDevices.map(a =>
        `<option value="${a.id}">${a.label || a.id}</option>`
      ).join('');
    } else {
      micOptions = `<option value="default">Default</option>`;
    }

    return `
      <div class="broadcast-panel panel">
        <h3>📡 Broadcast</h3>
        <div class="broadcast-preview">
          <video id="broadcastPreview" autoplay playsinline muted></video>
        </div>
        <div class="broadcast-controls">
          <div class="config-row">
            <label>Camera</label>
            <select id="broadcastCamera">${cameraOptions}</select>
          </div>
          <div class="config-row">
            <label>Microphone</label>
            <select id="broadcastMic">${micOptions}</select>
          </div>
          <div class="config-row">
            <label>Resolution</label>
            <select id="broadcastResolution">
              <option value="480p">480p</option>
              <option value="720p" selected>720p</option>
              <option value="1080p">1080p</option>
            </select>
          </div>
          <div class="config-row">
            <label>Frame Rate</label>
            <select id="broadcastFramerate">
              <option value="15">15 fps</option>
              <option value="24">24 fps</option>
              <option value="30" selected>30 fps</option>
            </select>
          </div>
          <button id="toggleBroadcastBtn" class="btn btn-primary" style="width:100%;margin-top:8px">
            Start Broadcast
          </button>
        </div>
      </div>
    `;
  }

  function renderListView(kiosks, broadcastPanel) {
    deviceList.innerHTML = broadcastPanel + kiosks.map(d => {
      const isViewing = viewingId === d.id;
      const vActive = isViewing && viewMode === 'video';
      const aActive = isViewing && viewMode === 'audio';
      const type = sourceTypeFor(d.id);
      const videoOk = hasVideo(type);
      const audioOk = hasAudio(type);
      const alerting = audioState[d.id] && audioState[d.id].alerting;
      const st = audioState[d.id];
      const dbText = (st && st.levelDb != null) ? ` ${Math.round(st.levelDb)}dB` : '';
      const itemClass = 'device-item' + (alerting ? ' audio-alert' : '');
      const audioBtn = audioOk
        ? `<button class="btn btn-small ${aActive ? 'btn-danger' : 'btn-outline'} audio-btn" data-id="${d.id}">${aActive ? 'Stop' : 'Audio'}</button>`
        : `<button class="btn btn-small btn-disabled audio-btn" disabled data-id="${d.id}">Audio</button>`;
      const videoBtn = videoOk
        ? `<button class="btn btn-small ${vActive ? 'btn-danger' : 'btn-outline'} video-btn" data-id="${d.id}">${vActive ? 'Stop' : 'Video'}</button>`
        : `<button class="btn btn-small btn-disabled video-btn" disabled data-id="${d.id}">Video</button>`;

      return `
        <div class="${itemClass}" data-id="${d.id}">
          <div class="device-info">
            <div class="device-name">${d.label}${dbText ? `<span class="db-readout">${dbText}</span>` : ''}</div>
            <div class="device-last-seen ${d.online ? 'online' : 'offline'}">${d.online ? 'online' : formatTime(d.lastSeenAt)}</div>
          </div>
          <div class="btn-row">
            ${audioBtn}
            ${videoBtn}
            <button class="btn btn-small btn-outline settings-btn" data-id="${d.id}">Settings</button>
          </div>
        </div>`;
    }).join('');

    // Attach broadcast panel listeners if present
    attachBroadcastPanelListeners();
  }

  function renderGridView(kiosks, broadcastPanel) {
    // 2x2 grid of video feeds
    const activeKiosks = Array.from(gridViewingIds).map(id => kiosks.find(k => k.id === id)).filter(Boolean);
    const availableKiosks = kiosks.filter(k => !gridViewingIds.has(k.id));

    let gridHtml = broadcastPanel;
    gridHtml += `
      <div class="grid-controls panel" style="margin-bottom:12px">
        <h3>Grid View (${activeKiosks.length}/4)</h3>
        <div class="grid-available">
          ${availableKiosks.map(k => `
            <button class="btn btn-small btn-outline add-to-grid" data-id="${k.id}">+ ${k.label}</button>
          `).join('')}
        </div>
      </div>
      <div class="video-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
        ${activeKiosks.map(k => `
          <div class="grid-cell" data-id="${k.id}">
            <video class="grid-video" id="grid-video-${k.id}" autoplay playsinline></video>
            <div class="grid-overlay">
              <span class="grid-label">${k.label}</span>
              <button class="btn btn-small btn-danger remove-from-grid" data-id="${k.id}">×</button>
            </div>
          </div>
        `).join('')}
        ${activeKiosks.length < 4 ? `
          <div class="grid-cell empty" style="display:flex;align-items:center;justify-content:center;background:#1a1a1a;border:2px dashed #444">
            <span style="color:#888">Click + to add camera</span>
          </div>
        `.repeat(4 - activeKiosks.length) : ''}
      </div>
    `;

    // Also show list of kiosks below grid for audio controls
    gridHtml += '<div class="panel"><h3>Audio Controls</h3>' + kiosks.map(d => {
      const type = sourceTypeFor(d.id);
      const audioOk = hasAudio(type);
      const inGrid = gridViewingIds.has(d.id);
      const audioBtn = audioOk
        ? `<button class="btn btn-small ${inGrid ? 'btn-danger' : 'btn-outline'} audio-btn" data-id="${d.id}">${inGrid ? 'Stop Audio' : 'Audio'}</button>`
        : `<button class="btn btn-small btn-disabled audio-btn" disabled data-id="${d.id}">Audio</button>`;

      return `
        <div class="device-item" data-id="${d.id}">
          <div class="device-info">
            <div class="device-name">${d.label}</div>
          </div>
          <div class="btn-row">
            ${audioBtn}
            ${!inGrid && kiosks.filter(k => gridViewingIds.has(k.id)).length < 4
              ? `<button class="btn btn-small btn-outline add-to-grid" data-id="${d.id}">+ Grid</button>`
              : ''}
            <button class="btn btn-small btn-outline settings-btn" data-id="${d.id}">Settings</button>
          </div>
        </div>`;
    }).join('') + '</div>';

    deviceList.innerHTML = gridHtml;

    // Attach video streams to grid cells
    activeKiosks.forEach(k => {
      const stream = streams[k.id];
      const videoEl = document.getElementById(`grid-video-${k.id}`);
      if (stream && videoEl) {
        videoEl.srcObject = stream;
        videoEl.muted = true;
        videoEl.play().catch(() => {});
      }
    });

    // Attach listeners for grid
    attachGridListeners();
  }

  // ─── Broadcast Functions ────────────────────────────────

  function attachBroadcastPanelListeners() {
    const preview = document.getElementById('broadcastPreview');
    const camSel = document.getElementById('broadcastCamera');
    const micSel = document.getElementById('broadcastMic');
    const resSel = document.getElementById('broadcastResolution');
    const frSel = document.getElementById('broadcastFramerate');
    const btn = document.getElementById('toggleBroadcastBtn');
    
    if (!btn) return;

    btn.addEventListener('click', toggleBroadcast);
    camSel?.addEventListener('change', startBroadcastPreview);
    micSel?.addEventListener('change', startBroadcastPreview);
    resSel?.addEventListener('change', startBroadcastPreview);
    frSel?.addEventListener('change', startBroadcastPreview);
  }

  async function startBroadcastPreview() {
    const camSel = document.getElementById('broadcastCamera');
    const micSel = document.getElementById('broadcastMic');
    const resSel = document.getElementById('broadcastResolution');
    const frSel = document.getElementById('broadcastFramerate');
    const preview = document.getElementById('broadcastPreview');
    
    if (!camSel || !preview) return;

    const videoDevice = camSel.value;
    const audioDevice = micSel?.value || 'default';
    const resolution = resSel?.value || '720p';
    const frameRate = parseInt(frSel?.value || '30');

    // Stop existing preview
    if (localBroadcastStream) {
      localBroadcastStream.getTracks().forEach(t => t.stop());
      localBroadcastStream = null;
    }

    const DIMS = { '480p': [640, 480], '720p': [1280, 720], '1080p': [1920, 1080] };
    const [w, h] = DIMS[resolution] || DIMS['720p'];

    const constraints = {
      video: {
        deviceId: { exact: videoDevice },
        width: { ideal: w },
        height: { ideal: h },
        frameRate: { ideal: frameRate },
      },
      audio: audioDevice !== 'default' ? { deviceId: { exact: audioDevice } } : true,
    };

    try {
      localBroadcastStream = await navigator.mediaDevices.getUserMedia(constraints);
      preview.srcObject = localBroadcastStream;
      preview.play().catch(() => {});
      console.log('[base] Broadcast preview started');
    } catch (err) {
      console.error('[base] Broadcast preview failed:', err);
    }
  }

  // Ensure a base-station broadcast media stream exists, acquiring one with
  // sensible defaults if needed. Unlike startBroadcastPreview this does NOT
  // depend on the Broadcast panel's <select>/<video> DOM being present, so it
  // can be used by FaceTalk (triggered from the monitor overlay).
  async function ensureBroadcastStream() {
    if (localBroadcastStream) return localBroadcastStream;
    try {
      localBroadcastStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: true,
      });
      console.log('[base] Broadcast stream acquired for FaceTalk');
    } catch (err) {
      console.error('[base] ensureBroadcastStream failed:', err);
      localBroadcastStream = null;
    }
    return localBroadcastStream;
  }

  async function toggleBroadcast() {
    const btn = document.getElementById('toggleBroadcastBtn');
    if (!btn) return;

    if (isBroadcasting) {
      // Stop broadcasting
      await stopBroadcast();
      btn.textContent = 'Start Broadcast';
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-primary');
    } else {
      // Start broadcasting
      await startBroadcast();
      btn.textContent = 'Stop Broadcast';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-danger');
    }
  }

  async function startBroadcast() {
    const camSel = document.getElementById('broadcastCamera');
    const micSel = document.getElementById('broadcastMic');
    const resSel = document.getElementById('broadcastResolution');
    const frSel = document.getElementById('broadcastFramerate');
    
    if (!localBroadcastStream) {
      await startBroadcastPreview();
      // Wait a bit for stream to be ready
      await new Promise(r => setTimeout(r, 500));
    }

    if (!localBroadcastStream) {
      showToast('Failed to start broadcast: no media stream');
      return;
    }

    broadcastSourceId = 'broadcast-' + deviceId + '-' + Date.now();
    broadcastStream = localBroadcastStream;
    isBroadcasting = true;

    // Publish broadcast source
    sig.broadcastSource(broadcastSourceId, 'Base Station Broadcast', 'video+audio');

    // Update base config
    sig.setConfig(deviceId, {
      broadcastSourceId: broadcastSourceId,
      isBroadcasting: true,
    });

    showToast('Broadcast started');
    console.log('[base] Broadcast started:', broadcastSourceId);
  }

  async function stopBroadcast() {
    isBroadcasting = false;
    
    // Unpublish broadcast source
    if (broadcastSourceId) {
      sig.unbroadcastSource(broadcastSourceId);
      broadcastSourceId = null;
    }

    // Close all broadcast peer connections
    broadcastSubscribers.forEach(kioskId => {
      rtc.closeBroadcastPeerConnection(kioskId);
    });
    broadcastSubscribers.clear();

    // Stop local stream
    if (localBroadcastStream) {
      localBroadcastStream.getTracks().forEach(t => t.stop());
      localBroadcastStream = null;
      broadcastStream = null;
    }

    // Update base config
    sig.setConfig(deviceId, {
      broadcastSourceId: undefined,
      isBroadcasting: false,
    });

    showToast('Broadcast stopped');
    console.log('[base] Broadcast stopped');
  }

  // ─── Grid View Functions ────────────────────────────────

  function attachGridListeners() {
    // Grid cell videos are already attached in renderGridView
    // This is for any additional grid-specific listeners
  }

  function addToGrid(kioskId) {
    if (gridViewingIds.size >= 4) {
      showToast('Grid is full (max 4)');
      return;
    }
    gridViewingIds.add(kioskId);
    
    // Subscribe to this kiosk if not already
    if (!subscribed.has(kioskId)) {
      subscribed.add(kioskId);
      sig.subscribeSource(kioskId);
    }
    
    renderDevices();
  }

  function removeFromGrid(kioskId) {
    gridViewingIds.delete(kioskId);
    
    // Unsubscribe from this kiosk
    if (subscribed.has(kioskId)) {
      subscribed.delete(kioskId);
      sig.unsubscribeSource(kioskId);
      rtc.closePeerConnection(kioskId);
      delete streams[kioskId];
    }
    
    renderDevices();
  }

  // ─── Display/Audio Mode Functions ───────────────────────
  // (Display/Audio mode is now set from the per-device Settings panel via
  // sig.setDisplayConfig, so no list-level setters are needed here.)

  function startView(peerId, mode) {
    console.log('[view] start', peerId, mode);
    if (viewingId === peerId && viewMode === mode) { stopView(); return; }
    if (devices.find(d => d.id === peerId && d.type !== 'kiosk')) return;

    const type = sourceTypeFor(peerId);
    // Fall back to audio if video was requested but no video stream exists
    if (mode === 'video' && !hasVideo(type)) {
      console.log('[view] no video available, falling back to audio');
      mode = 'audio';
    }

    stopView();
    viewingId = peerId;
    viewMode = mode;

    subscribed.add(peerId);
    console.log('[view] subscribing', peerId);
    sig.subscribeSource(peerId);

    showMonitor();
    renderDevices();
    attachMonitorStream();

    // Begin connection-quality polling for this peer.
    if (statsStop) { statsStop(); statsStop = null; }
    statsStop = rtc.startStats(peerId, updateQuality);
  }

  function stopView() {
    const oldId = viewingId;
    console.log('[view] stop', oldId);
    if (oldId) {
      rtc.closePeerConnection(oldId);
      if (subscribed.has(oldId)) {
        subscribed.delete(oldId);
        sig.unsubscribeSource(oldId);
      }
    }
    viewingId = null;
    viewMode = null;
    recovering = false;
    if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
    if (audioSourceNode) {
      try { audioSourceNode.disconnect(); } catch {}
      audioSourceNode = null;
    }
    monitorVideo.srcObject = null;
    monitorVideo.muted = true;
    monitorError.classList.add('hidden');
    hideMonitorControls();
    showHome();
    renderDevices();

    // Tear down talkback + FaceTalk + quality polling tied to the closed view.
    if (talkingTo) stopTalk(talkingTo);
    if (faceTalkingTo) stopFaceTime(faceTalkingTo);
    if (statsStop) { statsStop(); statsStop = null; }
    if (monitorQuality) monitorQuality.textContent = '';
  }

  function showMonitor() {
    // Keep the device list visible — only reveal the monitor feed
    monitorFeed.classList.remove('hidden');
    monitorError.classList.add('hidden');
    showMonitorStatus(null);
    showMonitorControls(); // reveal controls when a feed opens
  }

  // ─── Monitor overlay auto-hide ──────────────────────
  // Controls are hidden until the user taps the video, then fade in and
  // auto-hide after 5s of inactivity (tapping again re-shows + resets timer).
  let monitorControlsTimer = null;
  function showMonitorControls() {
    const overlay = document.querySelector('.monitor-overlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    if (monitorControlsTimer) clearTimeout(monitorControlsTimer);
    monitorControlsTimer = setTimeout(() => {
      overlay.classList.remove('visible');
      monitorControlsTimer = null;
    }, 5000);
  }
  function hideMonitorControls() {
    const overlay = document.querySelector('.monitor-overlay');
    if (overlay) overlay.classList.remove('visible');
    if (monitorControlsTimer) { clearTimeout(monitorControlsTimer); monitorControlsTimer = null; }
  }

  // ─── Fullscreen ────────────────────────────────────
  function toggleFullscreen() {
    const el = monitorFeed;
    if (!el) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) {
      // iOS Safari only supports fullscreen on the <video> element itself.
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (monitorVideo.webkitEnterFullscreen) monitorVideo.webkitEnterFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  }

  function showHome() {
    monitorFeed.classList.add('hidden');
    // homeView is never hidden — the device list stays on screen
  }

  // ─── Watch recovery ────────────────────────────────

  function recoverWatch() {
    if (!viewingId || recovering) return;
    recovering = true;
    console.log('[view] recovering', viewingId);
    showMonitorStatus('Reconnecting…');
    const pc = rtc.peerConnections.get(viewingId);
    if (pc) pc._restarting = true; // prevent webrtc.js internal ICE-restart racing us
    rtc.closePeerConnection(viewingId);
    subscribed.delete(viewingId);
    sig.subscribeSource(viewingId);

    if (recoverTimer) clearTimeout(recoverTimer);
    recoverTimer = setTimeout(() => {
      if (recovering) {
        recovering = false;
        showMonitorStatus(null);
        monitorError.textContent = 'Stream lost. Device may be offline.';
        monitorError.classList.remove('hidden');
        renderDevices();
      }
    }, RECOVER_TIMEOUT);
  }

  function watchdog() {
    if (!viewingId || !viewMode || recovering) return;
    const type = sourceTypeFor(viewingId);
    if (!type) return;
    const last = lastActivity[viewingId] || 0;
    const deadFor = Date.now() - last;
    if (deadFor > WATCH_DEAD_MS) {
      // Expected track set: only declare dead if the missing tracks are ones we expect
      const expectVideo = hasVideo(type);
      const expectAudio = hasAudio(type);
      const stream = streams[viewingId];
      const gotVideo = stream ? stream.getVideoTracks().length > 0 : false;
      const gotAudio = stream ? stream.getAudioTracks().length > 0 : false;
      const noExpectedActivity =
        (expectVideo && !gotVideo && !gotAudio) || // video-only/av but no tracks
        (expectAudio && !gotAudio && !gotVideo) ||
        (expectVideo && expectAudio && !gotVideo && !gotAudio);
      if (noExpectedActivity) {
        recoverWatch();
      }
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'stopMonitorBtn') { stopView(); return; }
    if (t.id === 'monitorTalkBtn') { toggleTalk(); return; }
    if (t.id === 'monitorFaceTalkBtn') { toggleFaceTime(); return; }
    if (t.id === 'monitorMuteBtn') { toggleMute(); return; }
    if (t.id === 'monitorFullscreenBtn') { toggleFullscreen(); return; }
    if (t.id === 'answerCallBtn') { answerCall(); return; }
    if (t.id === 'dismissCallBtn') { dismissCall(); return; }

    const audioBtn = t.closest('.audio-btn');
    if (audioBtn && !audioBtn.disabled) { startView(audioBtn.dataset.id, 'audio'); return; }

    const videoBtn = t.closest('.video-btn');
    if (videoBtn && !videoBtn.disabled) { startView(videoBtn.dataset.id, 'video'); return; }

    const settingsBtn = t.closest('.settings-btn');
    if (settingsBtn) {
      const id = settingsBtn.dataset.id;
      if (configDeviceId === id && !configPanel.classList.contains('hidden')) {
        configPanel.classList.add('hidden');
        configDeviceId = null;
      } else {
        const d = devices.find(dev => dev.id === id);
        if (d) showConfig(d);
      }
      return;
    }

    // Grid view buttons
    const addToGridBtn = t.closest('.add-to-grid');
    if (addToGridBtn) { addToGrid(addToGridBtn.dataset.id); return; }

    const removeFromGridBtn = t.closest('.remove-from-grid');
    if (removeFromGridBtn) { removeFromGrid(removeFromGridBtn.dataset.id); return; }

    // Broadcast controls
    if (t.id === 'toggleBroadcastBtn') { toggleBroadcast(); return; }
    if (t.id === 'broadcastCamera') { startBroadcastPreview(); return; }
    if (t.id === 'broadcastMic') { startBroadcastPreview(); return; }
  });

  function showConfig(device) {
    configPanel.classList.remove('hidden');
    configDeviceId = device.id;
    configTitle.textContent = device.label + ' Settings';
    const caps = capabilitiesByDevice[device.id];
    const cfg = device.config || {};
    const displayMode = cfg.displayMode || 'self';
    const audioMode = cfg.audioMode || 'mute';

    let cameraRow;
    if (caps && caps.videoDevices && caps.videoDevices.length) {
      const opts = caps.videoDevices.map(v =>
        `<option value="${v.id}" ${cfg.videoDevice === v.id ? 'selected' : ''}>${v.label || v.id}</option>`
      ).join('');
      cameraRow = `
        <div class="config-row">
          <label>Camera</label>
          <select id="cfg-camera">${opts}</select>
        </div>`;
    } else {
      cameraRow = `
        <div class="config-row">
          <label>Camera</label>
          <select id="cfg-camera">
            <option value="front" ${cfg.camera !== 'rear' ? 'selected' : ''}>Front</option>
            <option value="rear" ${cfg.camera === 'rear' ? 'selected' : ''}>Rear</option>
          </select>
        </div>`;
    }

    let audioSourceRow = '';
    if (caps && caps.audioDevices && caps.audioDevices.length) {
      const opts = caps.audioDevices.map(a =>
        `<option value="${a.id}" ${cfg.audioDevice === a.id ? 'selected' : ''}>${a.label || a.id}</option>`
      ).join('');
      audioSourceRow = `
        <div class="config-row">
          <label>Microphone</label>
          <select id="cfg-audioDevice">${opts}</select>
        </div>`;
    }

    const alertEnabled = cfg.audioAlertEnabled !== false; // default on
    const alertThreshold = (cfg.audioAlertThresholdDb != null) ? cfg.audioAlertThresholdDb : -40;
    const hasAudioCap = hasAudio(sourceTypeFor(device.id)) ||
      (caps && caps.audioDevices && caps.audioDevices.length > 0);

    configForm.innerHTML = `
      <div class="config-row">
        <label>Label</label>
        <input type="text" id="cfg-label" value="${device.label}">
      </div>
      ${cameraRow}
      ${audioSourceRow}
      <div class="config-row">
        <label>Resolution</label>
        <select id="cfg-resolution">
          <option value="480p" ${cfg.resolution === '480p' ? 'selected' : ''}>480p</option>
          <option value="720p" ${cfg.resolution !== '480p' && cfg.resolution !== '1080p' ? 'selected' : ''}>720p</option>
          <option value="1080p" ${cfg.resolution === '1080p' ? 'selected' : ''}>1080p</option>
        </select>
      </div>
      <div class="config-row">
        <label>Frame Rate</label>
        <select id="cfg-framerate">
          <option value="15" ${cfg.frameRate === 15 ? 'selected' : ''}>15 fps</option>
          <option value="24" ${cfg.frameRate !== 15 && cfg.frameRate !== 30 ? 'selected' : ''}>24 fps</option>
          <option value="30" ${cfg.frameRate === 30 ? 'selected' : ''}>30 fps</option>
        </select>
      </div>
      <div class="config-row">
        <label>Display Mode</label>
        <select id="cfg-displayMode">
          <option value="self" ${displayMode === 'self' ? 'selected' : ''}>Self</option>
          <option value="blank" ${displayMode === 'blank' ? 'selected' : ''}>Blank</option>
          <option value="base" ${displayMode === 'base' ? 'selected' : ''}>Base</option>
        </select>
      </div>
      <div class="config-row">
        <label>Audio Mode</label>
        <select id="cfg-audioMode">
          <option value="self" ${audioMode === 'self' ? 'selected' : ''}>Self</option>
          <option value="mute" ${audioMode === 'mute' ? 'selected' : ''}>Mute</option>
          <option value="base" ${audioMode === 'base' ? 'selected' : ''}>Base</option>
        </select>
      </div>
      <div class="config-row">
        <label>Keep Awake</label>
        <div class="toggle-switch ${cfg.keepAwake !== false ? 'active' : ''}" id="cfg-keepAwake"></div>
      </div>
      ${hasAudioCap ? `
      <div class="config-row">
        <label>Audio Alert</label>
        <div class="toggle-switch ${alertEnabled ? 'active' : ''}" id="cfg-audioAlert"></div>
      </div>
      <div class="config-row">
        <label>Alert Threshold (dB)</label>
        <input type="number" id="cfg-audioThreshold" value="${alertThreshold}">
      </div>` : ''}
      <button id="removeDeviceBtn" class="btn btn-danger" style="margin-top:12px">Remove device</button>
      <button id="saveConfigBtn" class="btn btn-primary" style="margin-top:12px">Save</button>
    `;
    configForm.querySelectorAll('.toggle-switch').forEach(el => {
      el.addEventListener('click', () => el.classList.toggle('active'));
    });
    document.getElementById('saveConfigBtn').addEventListener('click', () => {
      const payload = {
        label: document.getElementById('cfg-label').value,
        resolution: document.getElementById('cfg-resolution').value,
        frameRate: parseInt(document.getElementById('cfg-framerate').value),
        keepAwake: document.getElementById('cfg-keepAwake').classList.contains('active'),
      };
      const usingVideoCaps = caps && caps.videoDevices && caps.videoDevices.length;
      if (usingVideoCaps) {
        payload.videoDevice = document.getElementById('cfg-camera').value;
      } else {
        payload.camera = document.getElementById('cfg-camera').value;
      }
      if (caps && caps.audioDevices && caps.audioDevices.length) {
        payload.audioDevice = document.getElementById('cfg-audioDevice').value;
      }
      if (hasAudioCap) {
        payload.audioAlertEnabled = document.getElementById('cfg-audioAlert').classList.contains('active');
        payload.audioAlertThresholdDb = parseFloat(document.getElementById('cfg-audioThreshold').value);
      }
      sig.setConfig(device.id, payload);
      // Persist + apply the display/audio mode live (kiosk applies via SET_DISPLAY_CONFIG)
      const newDisplay = document.getElementById('cfg-displayMode').value;
      const newAudio = document.getElementById('cfg-audioMode').value;
      sig.setDisplayConfig(device.id, newDisplay, newAudio);
      configPanel.classList.add('hidden');
    });
    document.getElementById('removeDeviceBtn').addEventListener('click', () => {
      if (confirm('Remove ' + device.label + ' from the list?')) {
        sig.removeDevice(device.id);
        configPanel.classList.add('hidden');
      }
    });
  }

  // ─── WebRTC ──

  rtc.onRemoteTrack = (peerId, stream, track) => {
    streams[peerId] = stream;
    lastActivity[peerId] = Date.now();
    if (peerId === viewingId) {
      if (recovering) {
        recovering = false;
        if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
        showMonitorStatus(null);
        monitorError.classList.add('hidden');
      }
      attachMonitorStream();
    }
  };

  rtc.onConnectionStateChange = (peerId, state) => {
    console.log('[webrtc] peer', peerId, 'connection state:', state);
    if (peerId === 'broadcast-' + faceTalkingTo) { ftDbgState.pc = state; renderFtDebug(); }
    if (peerId === viewingId && (state === 'failed' || state === 'disconnected' || state === 'closed')) {
      recoverWatch();
    }
  };

  rtc.onIceConnectionStateChange = (peerId, state) => {
    console.log('[webrtc] peer', peerId, 'ice state:', state);
    if (peerId === 'broadcast-' + faceTalkingTo) { ftDbgState.ice = state; renderFtDebug(); }
    if (peerId === viewingId && (state === 'failed' || state === 'disconnected' || state === 'closed')) {
      recoverWatch();
    }
  };

  rtc.onPeerDisconnected = (peerId) => {
    if (peerId === viewingId) recoverWatch();
  };

  // ─── Signaling ──

  function init() {
    localStorage.setItem('hearth_baseDeviceId', deviceId);
    sig.deviceId = deviceId;
    sig.deviceType = 'base';
    sig.deviceLabel = 'Base Station';
    sig.connect();

    // Tap the monitor feed to reveal the controls (they auto-hide after 5s).
    if (monitorFeed) {
      monitorFeed.addEventListener('click', (e) => {
        // Ignore taps that land on the controls themselves (buttons/slider),
        // so interacting with them doesn't restart the hide timer unexpectedly.
        if (e.target.closest('.monitor-overlay')) return;
        showMonitorControls();
      });
    }

    setInterval(watchdog, 2000);

    sig.on('open', () => {
      connectionDot.className = 'status-dot reconnecting';
      sig.joinRoom('default', deviceId);
      ftDbgState.wsMethod = sig.useSSE ? 'SSE' : 'WS';
      ftDbgState.wsUp = true;
      renderFtDebug();
    });

    sig.on('welcome', (data) => {
      deviceId = data.deviceId;
      localStorage.setItem('hearth_baseDeviceId', deviceId);
      connectionDot.className = 'status-dot online';
      sources = data.sources || [];
      devices = data.recentlySeenDevices || [];
      renderDevices();
    });

    sig.on('close', () => {
      connectionDot.className = 'status-dot offline';
      ftDbgState.wsUp = false;
      renderFtDebug();
    });

    sig.on('sourceAdded', (source) => {
      const existing = sources.find(s => s.id === source.id);
      if (existing) {
        existing.type = source.type;
        existing.label = source.label;
      } else {
        sources.push(source);
        showToast('Source online: ' + (source.label || source.id));
      }
      
      // Auto-subscribe to broadcast sources from other bases
      if (source.isBroadcast && source.publisherId !== deviceId) {
        console.log('[base] Broadcast source added from', source.publisherId, '- subscribing');
        sig.subscribeSource(source.publisherId);
      }
      
      renderDevices();
    });

    sig.on('sourceRemoved', (data) => {
      const removed = sources.find(s => s.id === data.sourceId);
      const pubId = removed ? removed.publisherId : data.sourceId;
      sources = sources.filter(s => s.id !== data.sourceId);
      delete streams[data.sourceId];
      delete streams[pubId];
      subscribed.delete(pubId);
      if (pubId === viewingId) {
        rtc.closePeerConnection(viewingId);
        if (audioSourceNode) {
          try { audioSourceNode.disconnect(); } catch {}
          audioSourceNode = null;
        }
        viewingId = null;
        viewMode = null;
        recovering = false;
        if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; }
        monitorVideo.srcObject = null;
        showHome();
      }
      renderDevices();
    });

    // Handle subscriber joining our broadcast (kiosk wants to receive our stream)
    sig.on('subscriberJoined', (data) => {
      if (data.isBroadcast && isBroadcasting) {
        const kioskId = data.subscriberId;
        console.log('[base] Kiosk', kioskId, 'subscribed to our broadcast');
        broadcastSubscribers.add(kioskId);
        // Create a broadcast peer connection for this kiosk
        const pc = rtc.createBroadcastPeerConnection(kioskId);
        // Add our broadcast tracks — onnegotiationneeded (perfect negotiation)
        // fires automatically and sends the offer, so no explicit offer call.
        if (broadcastStream) {
          broadcastStream.getTracks().forEach(track => {
            pc.addTrack(track, broadcastStream);
          });
          const t = broadcastStream.getTracks();
          ftDbgState.tracks = t.filter(x => x.kind === 'video').length + 'v ' +
            t.filter(x => x.kind === 'audio').length + 'a';
        }
        if (kioskId === faceTalkingTo) { ftDbgState.pc = 'subscribed'; renderFtDebug(); }
      }
    });

    sig.on('capabilities', (data) => {
      capabilitiesByDevice[data.deviceId] = {
        videoDevices: data.videoDevices || [],
        audioDevices: data.audioDevices || [],
      };
      renderDevices();
    });

    sig.on('doorbell', (data) => {
      console.log('[base] DOORBELL from', data.from, data.label);
      showIncomingCall(data);
      showToast('🔔 ' + (data.label || data.from) + ' is calling');
    });

    sig.on('audioPeak', (data) => {
      audioState[data.deviceId] = {
        levelDb: data.levelDb,
        alerting: !!data.peak,
      };
      // Update the dB readout + alert highlight in place. Do NOT call
      // renderDevices() here — it rebuilds the whole device list and would
      // destroy a <select> (display/audio dropdown) that the operator is
      // currently interacting with, making it impossible to change the value.
      updateAudioMeterUi(data.deviceId);
    });

    sig.on('deviceRemoved', (data) => {
      const id = data.deviceId;
      devices = devices.filter(d => d.id !== id);
      delete capabilitiesByDevice[id];
      delete audioState[id];
      if (id === viewingId) {
        stopView();
      }
      renderDevices();
    });

    sig.on('deviceStatus', (data) => {
      const wasKnown = devices.some(dev => dev.id === data.deviceId);
      let d = devices.find(dev => dev.id === data.deviceId);
      if (d) {
        d.online = data.status === 'online';
        d.lastSeenAt = data.lastSeenAt || Date.now();
        if (data.label) d.label = data.label;
        if (data.type) d.type = data.type;
        if (data.config) d.config = data.config;
      } else if (data.status === 'online' && data.type) {
        devices.push({
          id: data.deviceId,
          label: data.label || data.deviceId,
          type: data.type,
          lastSeenAt: data.lastSeenAt || Date.now(),
          online: true,
          config: data.config || {},
        });
        if (!wasKnown && data.type === 'kiosk') {
          showToast('Device joined: ' + (data.label || data.deviceId));
        }
      }
      if (data.deviceId === viewingId && data.status === 'offline') {
        monitorError.textContent = 'Kiosk went offline.';
        monitorError.classList.remove('hidden');
      }
      renderDevices();
    });

    sig.on('error', (err) => {
      console.error('[signaling] ERROR:', err);
      const msg = (err && (err.message || err.code)) || 'Unknown error';
      monitorError.textContent = 'Cannot connect: ' + msg + '. The kiosk may be offline.';
      monitorError.classList.remove('hidden');
    });

    sig.on('configResult', (data) => {
      if (data.config) {
        const d = devices.find(dev => dev.id === data.targetDeviceId);
        if (d) d.config = data.config;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
