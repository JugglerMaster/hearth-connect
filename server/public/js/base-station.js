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

  // Simple "Broadcast Message" (audio-only announcement to all kiosks).
  let isAnnouncing = false;
  let announceStream = null;       // audio-only MediaStream for the announcement
  let announceSourceId = null;     // broadcast source id for the announcement
  // Press-and-hold bookkeeping: the button only broadcasts while held. The
  // `holding` flag gates startAnnounce; `gen`/`currentAnnounceGen` let a
  // release cancel an in-flight (async) start so a broadcast can't get stuck on.
  let announceHolding = false;
  let announceGen = 0;
  let currentAnnounceGen = 0;
  let announceWindowBound = false;  // window release handlers bound only once

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
  let recoverAttempts = 0;             // reset on successful track arrival
  const WATCH_DEAD_MS = 8000;
  const RECOVER_TIMEOUT = 10000;
  const MAX_RECOVER_ATTEMPTS = 4;      // fast retries before falling back to slow retry
  const RECOVER_RETRY_MS = 15000;      // slow background retry cadence after that

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
  const monitorFullscreenBtn = document.getElementById('monitorFullscreenBtn');
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
      renderControlButtons();
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
    renderControlButtons();
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
      // Respect the user's chosen target (default 'all' = every kiosk).
      sig.broadcastSource(faceTalkSourceId, 'Base Station FaceTalk', 'video+audio', broadcastTarget);

      // Switch the target kiosk to show/hear the base's broadcast.
      sig.setDisplayConfig(peerId, 'base', 'base');

      faceTalkingTo = peerId;
      ftDbgState.target = peerId;
      ftDbgState.sourceId = faceTalkSourceId;
      ftDbgState.pc = 'new';
      ftDbgState.ice = 'new';
      ftDbgState.tracks = '--';
      renderFtDebug();
      renderControlButtons();
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
    renderControlButtons();
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
    } else {
      applyVolume(mutedVolume);
    }
    renderControlButtons();
  }

  // ─── Connection-quality indicator (getStats) ──────────
  function updateQuality(stats) {
    // Treat live stats as proof the media path is alive and refresh the
    // watchdog's activity timestamp. Previously lastActivity was only set when a
    // track first ARRIVED, so after WATCH_DEAD_MS (8s) of a running view the
    // watchdog always thought the stream was dead and forced a needless
    // teardown/reconnect — which then failed to recover on any real WiFi blip.
    if (viewingId && stats && (stats.state === 'connected' || stats.iceState === 'connected' || stats.iceState === 'completed')) {
      lastActivity[viewingId] = Date.now();
    }
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

  // Volume button toggles the vertical slider open/closed.
  const volumeToggleBtn = document.getElementById('volumeToggleBtn');
  const volumeSliderWrap = document.getElementById('volumeSliderWrap');
  if (volumeToggleBtn && volumeSliderWrap) {
    volumeToggleBtn.addEventListener('click', () => {
      volumeSliderWrap.classList.toggle('hidden');
    });
  }

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
    // Show the broadcast controls whenever a monitor feed is NOT open. We used
    // to also require `bases.length === 0` ("only the first base may broadcast"),
    // but `bases` is derived from the server's recentlySeenDevices list, which
    // includes OFFLINE bases across a 24h window. Any stale base entry made the
    // panel disappear (missing on desktop, and vanishing ~60s after a
    // reconnecting base's DEVICE_STATUS arrived). Every base station is allowed
    // to broadcast, so just gate on the feed being closed.
    const feedOpen = viewingId || (monitorFeed && !monitorFeed.classList.contains('hidden'));
    let broadcastPanel = '';
    if (!feedOpen) {
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

  // Broadcast target selection: 'all' broadcasts to every kiosk; a deviceId
  // restricts the broadcast to that single kiosk. Stored here so both the
  // "Hold to Broadcast" announcement and FaceTalk respect the user's choice.
  let broadcastTarget = 'all';

  function buildBroadcastPanel() {
    // Build the target <select>: an "All devices" option plus one per kiosk.
    const kiosks = devices.filter(d => d.type === 'kiosk' && d.id !== deviceId);
    const options = ['<option value="all">All devices</option>']
      .concat(kiosks.map(k => `<option value="${k.id}">${k.label}</option>`))
      .join('');
    return `
      <div class="broadcast-panel panel">
        <h3>📢 Broadcast</h3>
        <p class="hint" style="margin-bottom:8px">Press and hold to send a voice message. Choose a device to target just that one, or all devices at once.</p>
        <label class="broadcast-target-label" for="broadcastTargetSelect">Send to</label>
        <select id="broadcastTargetSelect" class="broadcast-target-select" style="width:100%;margin-bottom:8px">
          ${options}
        </select>
        <button id="toggleBroadcastButton" class="btn btn-primary" style="width:100%">
          📢 Hold to Broadcast
        </button>
        <div id="broadcastStatus" class="monitor-status hidden" style="margin-top:8px"></div>
      </div>
    `;
  }

  // Keep the stored target in sync with the dropdown whenever the panel renders,
  // and bind the panel's listeners.
  function attachBroadcastPanelListeners() {
    const targetSel = document.getElementById('broadcastTargetSelect');
    if (targetSel) {
      // Restore the previously chosen target (survives re-renders).
      targetSel.value = broadcastTarget;
      targetSel.addEventListener('change', (e) => {
        broadcastTarget = (e.target.value) || 'all';
        console.log('[base] broadcast target set to', broadcastTarget);
      });
    }
    const btn = document.getElementById('toggleBroadcastButton');
    if (!btn) return;
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
      const zzz = (d.config && d.config.broadcastDisabled) ? ' <span class="broadcast-off" title="System broadcasts disabled">💤</span>' : '';
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
            <div class="device-name">${d.label}${zzz}${dbText ? `<span class="db-readout">${dbText}</span>` : ''}</div>
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
    const btn = document.getElementById('toggleBroadcastButton');
    if (!btn) return;

    // Press-and-hold: broadcast only while the button is physically pressed
    // (walkie-talkie style). Start on press, stop on release.
    const startHold = (e) => {
      // Ignore secondary pointers / right-clicks.
      if (e && e.button != null && e.button !== 0) return;
      if (e && e.cancelable) e.preventDefault();
      if (announceHolding) return; // already holding
      announceHolding = true;
      announceGen++;
      currentAnnounceGen = announceGen;
      startAnnounce();
    };
    const endHold = (e) => {
      if (!announceHolding) return; // not currently holding
      // Only preventDefault when we're actually ending a held broadcast. This
      // handler is bound at the WINDOW level, and calling preventDefault on
      // every touchend cancels iOS's synthesized `click`, which broke the
      // delegated audio/video/settings buttons on iPhone/iPad.
      if (e && e.cancelable) e.preventDefault();
      stopAnnounce();
    };

    btn.addEventListener('mousedown', startHold);
    btn.addEventListener('touchstart', startHold, { passive: false });
    btn.addEventListener('mouseup', endHold);
    btn.addEventListener('mouseleave', endHold);
    btn.addEventListener('touchend', endHold);
    btn.addEventListener('touchcancel', endHold);

    // Release anywhere (even outside the button, e.g. if the panel re-renders
    // mid-press) still stops the broadcast. Bind the window-level release
    // handlers only once — renderDevices() recreates the button and calls this
    // repeatedly, and button listeners die with the old element, but window
    // listeners would otherwise leak.
    if (!announceWindowBound) {
      announceWindowBound = true;
      window.addEventListener('mouseup', endHold);
      window.addEventListener('touchend', endHold);
    }
  }

  // Acquire an audio-only stream for the "Broadcast Message" button. Kept
  // separate from localBroadcastStream (FaceTalk's video+audio) so the two
  // features never fight over the same mic tracks.
  async function ensureAnnounceStream() {
    if (announceStream) return announceStream;
    try {
      announceStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      console.log('[base] Announce mic acquired');
    } catch (err) {
      console.error('[base] ensureAnnounceStream failed:', err);
      announceStream = null;
    }
    return announceStream;
  }

  // Ensure a base-station video+audio stream exists for FaceTalk (the manual
  // "send camera+mic" feature), acquiring one with sensible defaults if needed.
  async function ensureBroadcastStream() {
    if (localBroadcastStream) return localBroadcastStream;
    try {
      localBroadcastStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      console.log('[base] Broadcast stream acquired for FaceTalk');
    } catch (err) {
      console.error('[base] ensureBroadcastStream failed:', err);
      localBroadcastStream = null;
    }
    return localBroadcastStream;
  }

  // Start an audio-only broadcast. The server fans it out to every online
  // kiosk except this base; each kiosk auto-plays it as an announcement.
  // `holding`/`gen` let a release that arrives during the async getUserMedia
  // await cancel a broadcast that hasn't started yet (press-and-hold model).
  async function startAnnounce() {
    if (!announceStream) {
      await ensureAnnounceStream();
    }
    // The button may have been released (or re-pressed) while we awaited the
    // mic permission. Bail if we're no longer supposed to be broadcasting.
    if (!announceHolding || announceGen !== currentAnnounceGen) {
      if (announceStream) {
        announceStream.getTracks().forEach(t => t.stop());
        announceStream = null;
      }
      return;
    }
    if (!announceStream) {
      showToast('Microphone unavailable for broadcast');
      return;
    }

    announceSourceId = 'announce-' + deviceId + '-' + Date.now();
    isAnnouncing = true;

    // Publish an AUDIO-ONLY broadcast source (no camera). The kiosk(s) play it
    // regardless of its display/audio mode, so the announcement is never silent.
    // When broadcastTarget is a specific deviceId, the server only delivers the
    // SOURCE_ADDED to that kiosk.
    sig.broadcastSource(announceSourceId, 'Base Station Broadcast', 'audio-only', broadcastTarget);

    const status = document.getElementById('broadcastStatus');
    if (status) {
      status.textContent = 'Broadcasting… speak now';
      status.classList.remove('hidden');
    }
    const btn = document.getElementById('toggleBroadcastButton');
    if (btn) {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-danger');
      btn.textContent = '⏹ Broadcasting… release to stop';
    }
    showToast('Broadcasting message to all kiosks');
    console.log('[base] Announce started:', announceSourceId);
  }

  function stopAnnounce() {
    announceHolding = false;
    announceGen++;            // invalidate any in-flight startAnnounce
    currentAnnounceGen = announceGen;
    isAnnouncing = false;
    if (announceSourceId) {
      sig.unbroadcastSource(announceSourceId);
      announceSourceId = null;
    }
    // Tear down the per-kiosk broadcast peer connections we opened.
    broadcastSubscribers.forEach(kioskId => {
      rtc.closeBroadcastPeerConnection(kioskId);
    });
    broadcastSubscribers.clear();
    if (announceStream) {
      announceStream.getTracks().forEach(t => t.stop());
      announceStream = null;
    }
    const status = document.getElementById('broadcastStatus');
    if (status) status.classList.add('hidden');
    const btn = document.getElementById('toggleBroadcastButton');
    if (btn) {
      btn.classList.remove('btn-danger');
      btn.classList.add('btn-primary');
      btn.textContent = '📢 Hold to Broadcast';
    }
    showToast('Broadcast stopped');
    console.log('[base] Announce stopped');
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
    recoverAttempts = 0;
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

  // ─── Local self-video test ─────────────────────────
  // Grabs the base station's own camera and shows it in the monitor pane.
  // Pure local getUserMedia — no WebRTC — to confirm the monitor <video>
  // surface renders at all, independent of the signaling/peer pipeline.
  let selfTestStream = null;
  async function testSelfVideo() {
    if (selfTestStream) {
      selfTestStream.getTracks().forEach(t => t.stop());
      selfTestStream = null;
      monitorVideo.srcObject = null;
      stopView();
      showToast('Self-video test stopped');
      return;
    }
    try {
      selfTestStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' }, audio: false,
      });
    } catch (err) {
      console.error('[base] self-video test failed:', err);
      showToast('Camera error: ' + err.name);
      return;
    }
    viewingId = null;
    viewMode = 'video';
    showMonitor();
    monitorVideo.classList.remove('hidden');
    monitorPlaceholder.classList.add('hidden');
    monitorVideo.srcObject = selfTestStream;
    monitorVideo.muted = true;
    monitorVideo.play().catch(() => {});
    renderDevices();
    showToast('Showing base station camera');
  }

  // ─── Monitor overlay auto-hide ──────────────────────
  // Controls are hidden until the user taps the video, then fade in and
  // auto-hide after 5s of inactivity (tapping again re-shows + resets timer).
  let monitorControlsTimer = null;
  function showMonitorControls() {
    const overlay = document.querySelector('.monitor-overlay');
    if (!overlay) return;
    overlay.classList.add('visible');
    renderControlButtons();
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

  // ─── Control-button state (single source of truth) ──
  // Every control's pressed/active look is derived here from the real module
  // state (talkingTo / faceTalkingTo / monitorMuted / fsActive) and applied on
  // every change. Because nothing else mutates the buttons directly, the icons
  // can never drift out of sync, and turning one feature on never leaves
  // another stuck "on" — e.g. starting Talk while FaceTalk is sending video
  // keeps BOTH lit (audio is now flowing both ways), and stopping either
  // simply clears that one button.
  let fsActive = false;
  function setPressed(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', !!on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function renderControlButtons() {
    setPressed(monitorMuteBtn, monitorMuted);
    setPressed(monitorTalkBtn, !!talkingTo);
    setPressed(monitorFaceTalkBtn, !!faceTalkingTo);
    setPressed(monitorFullscreenBtn, fsActive);
  }

  // ─── Fullscreen ────────────────────────────────────
  function toggleFullscreen() {
    const el = monitorFeed;
    if (!el) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) {
      fsActive = true;
      // iOS Safari only supports fullscreen on the <video> element itself.
      if (el.requestFullscreen) el.requestFullscreen().catch(() => { fsActive = false; });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (monitorVideo.webkitEnterFullscreen) monitorVideo.webkitEnterFullscreen();
    } else {
      fsActive = false;
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    renderControlButtons();
  }

  // Keep fsActive in sync if the user leaves fullscreen by other means
  // (swipe/gesture on iOS, ESC on desktop) so the icon never gets stuck.
  function syncFsFromDom() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const now = !!fsEl;
    if (now !== fsActive) {
      fsActive = now;
      renderControlButtons();
    }
  }
  document.addEventListener('fullscreenchange', syncFsFromDom);
  document.addEventListener('webkitfullscreenchange', syncFsFromDom);

  // Exiting fullscreen on iOS/Safari leaves the <video> paused. If the exit was
  // triggered by our tap, we're still inside the user gesture, so play() can
  // restart immediately. For gesture-less exits (iOS swipe) play() rejects and
  // we fall back to the manual resume button. We also retry on the video's own
  // "ready" events (canplay/loadeddata/playing) so that if the stream was
  // still buffering when FS ended, playback resumes as soon as it's ready.
  const monitorResumeBtn = document.getElementById('monitorResumeBtn');
  let resumeArmed = false;

  function showResumeIfPaused() {
    if (!monitorResumeBtn) return;
    const paused = monitorVideo && monitorVideo.srcObject && monitorVideo.paused;
    monitorResumeBtn.classList.toggle('hidden', !paused);
  }

  // Attempt to (re)start playback. Resolves silently either way; on failure we
  // surface the manual resume button so the operator can replay with a tap.
  function attemptResume() {
    if (!monitorVideo || !monitorVideo.srcObject) return;
    const p = monitorVideo.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => showResumeIfPaused());
    }
  }

  // Called on every fullscreen-exit path. Arms auto-resume and takes an
  // immediate shot while any user-gesture window is still open.
  function armAutoResume() {
    if (!monitorVideo || !monitorVideo.srcObject) return;
    resumeArmed = true;
    attemptResume();
  }

  // "Ready" events: if we're armed and the video is still paused (buffering
  // when FS ended), try again now that the media is playable.
  function onMediaReady() {
    if (resumeArmed && monitorVideo && monitorVideo.paused) attemptResume();
  }

  if (monitorResumeBtn) {
    monitorResumeBtn.addEventListener('click', () => {
      monitorResumeBtn.classList.add('hidden');
      resumeArmed = false;
      if (monitorVideo) monitorVideo.play().catch(() => {});
    });
  }
  if (monitorVideo) {
    monitorVideo.addEventListener('pause', showResumeIfPaused);
    monitorVideo.addEventListener('play', () => {
      resumeArmed = false;
      if (monitorResumeBtn) monitorResumeBtn.classList.add('hidden');
    });
    monitorVideo.addEventListener('playing', () => {
      resumeArmed = false;
      if (monitorResumeBtn) monitorResumeBtn.classList.add('hidden');
    });
    // Retry auto-resume once the stream is ready to play after FS exit.
    monitorVideo.addEventListener('canplay', onMediaReady);
    monitorVideo.addEventListener('loadeddata', onMediaReady);
  }
  document.addEventListener('fullscreenchange', () => {
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) armAutoResume();
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) armAutoResume();
  });
  // The <video> also fires its own fullscreen end event under iOS's native path.
  document.addEventListener('DOMContentLoaded', () => {
    if (monitorVideo) monitorVideo.addEventListener('webkitendfullscreen', armAutoResume);
  });

  function showHome() {
    monitorFeed.classList.add('hidden');
    // homeView is never hidden — the device list stays on screen
  }

  // ─── Watch recovery ────────────────────────────────

  function recoverWatch() {
    if (!viewingId || recovering) return;
    recovering = true;
    recoverAttempts++;
    console.log('[view] recovering', viewingId, 'attempt', recoverAttempts);
    showMonitorStatus(recoverAttempts > 1 ? `Reconnecting… (${recoverAttempts})` : 'Reconnecting…');
    const pc = rtc.peerConnections.get(viewingId);
    if (pc) pc._restarting = true; // prevent webrtc.js internal ICE-restart racing us
    rtc.closePeerConnection(viewingId);
    subscribed.delete(viewingId);
    sig.subscribeSource(viewingId);

    if (recoverTimer) clearTimeout(recoverTimer);
    recoverTimer = setTimeout(() => {
      if (!recovering) return;
      recovering = false;
      if (!viewingId) return;
      // Keep retrying instead of giving up after one attempt — a transient WiFi
      // blip often needs a few rounds. Only surface the hard failure after
      // several tries, and keep retrying (slower) so it self-heals when the
      // network returns rather than sitting dead until the user intervenes.
      if (recoverAttempts < MAX_RECOVER_ATTEMPTS) {
        recoverWatch();
      } else {
        showMonitorStatus(null);
        monitorError.textContent = 'Stream lost — still retrying…';
        monitorError.classList.remove('hidden');
        renderDevices();
        // Slow background retry; onRemoteTrack clears this state on success.
        recoverTimer = setTimeout(() => { if (viewingId) recoverWatch(); }, RECOVER_RETRY_MS);
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
    // Use closest() so a tap that lands on the inner <svg>/<path> glyph (or any
    // nested element) still resolves to the owning button. Checking e.target.id
    // directly misses when the glyph is the event target — which is most taps
    // on these icon buttons.
    const icon = t.closest && t.closest('#stopMonitorBtn, #monitorTalkBtn, #monitorFaceTalkBtn, #monitorMuteBtn, #monitorFullscreenBtn, #testSelfVideoBtn');
    if (icon) {
      switch (icon.id) {
        case 'stopMonitorBtn': stopView(); break;
        case 'monitorTalkBtn': toggleTalk(); break;
        case 'monitorFaceTalkBtn': toggleFaceTime(); break;
        case 'monitorMuteBtn': toggleMute(); break;
        case 'monitorFullscreenBtn': toggleFullscreen(); break;
        case 'testSelfVideoBtn': testSelfVideo(); break;
      }
      return;
    }
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

    // Broadcast controls — press-and-hold is wired directly on the button in
    // attachBroadcastPanelListeners (mousedown/touchstart→start, up→stop), so
    // there is nothing to do here for clicks (it would double-trigger).
    if (t.id === 'toggleBroadcastButton') { return; }
  });

  function showConfig(device) {
    configPanel.classList.remove('hidden');
    configDeviceId = device.id;
    configTitle.textContent = device.label + ' Settings';

    // Render immediately from the locally cached config (so the panel opens
    // without a round-trip), then pull the kiosk's *authoritative* current
    // config from the server and refresh in place. This guarantees the panel
    // reflects reality (audio + video settings) even if our cache was stale
    // (e.g. the kiosk changed something, or we'd only ever received a partial
    // broadcast). The guarded refresh below won't clobber unsaved edits.
    renderConfigForm(device);
    sig.getConfig(device.id);
  }

  // Re-draw the settings form from a device's current config. Safe to call
  // again after a fresh CONFIG_RESULT arrives — it re-reads device.config, so
  // it always reflects the latest known server state for that kiosk.
  function renderConfigForm(device) {
    const caps = capabilitiesByDevice[device.id];
    const cfg = device.config || {};
    const displayMode = cfg.displayMode || 'self';
    const audioMode = cfg.audioMode || 'mute';
    const broadcastsDisabled = cfg.broadcastDisabled === true;

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
      <div class="config-row">
        <label>System Broadcasts</label>
        <div class="toggle-switch ${!broadcastsDisabled ? 'active' : ''}" id="cfg-broadcasts" title="When off, this kiosk will not receive 'Broadcast Message' voice announcements"></div>
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
        // "System Broadcasts" toggle is ON by default; OFF means the kiosk
        // opts out of receiving "Broadcast Message" voice announcements.
        broadcastDisabled: !document.getElementById('cfg-broadcasts').classList.contains('active'),
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
      recoverAttempts = 0; // media is flowing again — reset the recovery backoff
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
      if (!data.isBroadcast) return;
      // If we're broadcasting to a specific device, ignore subscribers that
      // aren't that device (defensive — the server already filters delivery).
      if (broadcastTarget !== 'all' && data.subscriberId !== broadcastTarget) {
        console.log('[base] ignoring broadcast subscriber', data.subscriberId, '(target is', broadcastTarget + ')');
        return;
      }
      // Either FaceTalk (video+audio, isBroadcasting) or a "Broadcast Message"
      // announcement (audio-only, isAnnouncing) — pick the active local stream.
      const outStream = announceStream || broadcastStream || localBroadcastStream;
      if (!outStream) return;
      const kioskId = data.subscriberId;
      console.log('[base] Kiosk', kioskId, 'subscribed to our broadcast');
      broadcastSubscribers.add(kioskId);
      // Create a broadcast peer connection for this kiosk
      const pc = rtc.createBroadcastPeerConnection(kioskId);
      // Add our broadcast tracks — onnegotiationneeded (perfect negotiation)
      // fires automatically and sends the offer, so no explicit offer call.
      outStream.getTracks().forEach(track => {
        pc.addTrack(track, outStream);
      });
      const t = outStream.getTracks();
      ftDbgState.tracks = t.filter(x => x.kind === 'video').length + 'v ' +
        t.filter(x => x.kind === 'audio').length + 'a';
      if (kioskId === faceTalkingTo) { ftDbgState.pc = 'subscribed'; renderFtDebug(); }
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
        // MERGE, don't replace: a Save fires SET_CONFIG (full) followed by
        // SET_DISPLAY_CONFIG (only displayMode/audioMode). The latter's
        // CONFIG_RESULT carries a partial config, so a blind assign would wipe
        // resolution/frameRate/broadcastDisabled/etc. from our cache.
        if (d) d.config = Object.assign({}, d.config, data.config);
        // If the settings panel is open for this device and the user hasn't
        // started editing, re-render so the kiosk's authoritative current
        // audio/video settings appear. We only refresh when the form still
        // matches the device (no unsaved "Save" in flight) to avoid clobbering
        // an open edit.
        if (d && configDeviceId === data.targetDeviceId && !configPanel.classList.contains('hidden')) {
          const labelInput = document.getElementById('cfg-label');
          const untouched = !labelInput ||
            labelInput.value === d.label ||
            labelInput.value === (d.config?.label || d.label);
          if (untouched) renderConfigForm(d);
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
