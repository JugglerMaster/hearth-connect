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

  // Watch recovery state
  let recovering = false;
  let recoverTimer = null;
  const WATCH_DEAD_MS = 8000;
  const RECOVER_TIMEOUT = 10000;

  const connectionDot = document.getElementById('connectionDot');
  const monitorFeed = document.getElementById('monitorFeed');
  const monitorVideo = document.getElementById('monitorVideo');
  const monitorLabel = document.getElementById('monitorLabel');
  const monitorMode = document.getElementById('monitorMode');
  const monitorError = document.getElementById('monitorError');
  const monitorStatus = document.getElementById('monitorStatus');
  const monitorPlaceholder = document.getElementById('monitorPlaceholder');
  const stopMonitorBtn = document.getElementById('stopMonitorBtn');
  const monitorVolume = document.getElementById('monitorVolume');
  const toast = document.getElementById('toast');
  const homeView = document.getElementById('homeView');
  const deviceList = document.getElementById('deviceList');
  const configPanel = document.getElementById('configPanel');
  const configForm = document.getElementById('configForm');
  const configTitle = document.getElementById('configTitle');
  let configDeviceId = null;

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
      monitorMode.textContent = '🔊 Listening';
      return;
    }
    // Video mode:
    if (vTracks.length === 0) {
      // Video track not arrived yet (tracks fire as separate ontrack events).
      // Keep waiting — do NOT downgrade viewMode, just show a connecting state.
      monitorVideo.classList.add('hidden');
      monitorPlaceholder.classList.remove('hidden');
      monitorMode.textContent = '📹 Connecting…';
      return;
    }
    monitorVideo.classList.remove('hidden');
    monitorPlaceholder.classList.add('hidden');
    monitorMode.textContent = '📹 Watching';
  }

  function renderDevices() {
    const kiosks = devices.filter(d => d.type === 'kiosk' && d.id !== deviceId);
    if (kiosks.length === 0) {
      deviceList.innerHTML = '<p class="hint" style="padding:12px">No kiosks connected</p>';
      return;
    }
    deviceList.innerHTML = kiosks.map(d => {
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
  }

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
    showMonitorStatus(null);
    showHome();
    renderDevices();
  }

  function showMonitor() {
    // Keep the device list visible — only reveal the monitor feed
    monitorFeed.classList.remove('hidden');
    const src = sources.find(s => s.publisherId === viewingId);
    monitorLabel.textContent = src ? src.label : 'Unknown';
    monitorError.classList.add('hidden');
    showMonitorStatus(null);
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
  });

  function showConfig(device) {
    configPanel.classList.remove('hidden');
    configDeviceId = device.id;
    configTitle.textContent = device.label + ' Settings';
    const caps = capabilitiesByDevice[device.id];
    const cfg = device.config || {};

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
        <label>Two-way Audio</label>
        <div class="toggle-switch ${cfg.twoWayAudioEnabled !== false ? 'active' : ''}" id="cfg-twoWay"></div>
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
        twoWayAudioEnabled: document.getElementById('cfg-twoWay').classList.contains('active'),
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
      // Optimistically update local cache so reopening shows current values.
      device.config = Object.assign({}, device.config || {}, payload);
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
    if (peerId === viewingId && (state === 'failed' || state === 'disconnected' || state === 'closed')) {
      recoverWatch();
    }
  };

  rtc.onIceConnectionStateChange = (peerId, state) => {
    console.log('[webrtc] peer', peerId, 'ice state:', state);
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

    setInterval(watchdog, 2000);

    sig.on('open', () => {
      connectionDot.className = 'status-dot reconnecting';
      sig.joinRoom('default', deviceId);
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

    sig.on('capabilities', (data) => {
      capabilitiesByDevice[data.deviceId] = {
        videoDevices: data.videoDevices || [],
        audioDevices: data.audioDevices || [],
      };
      renderDevices();
    });

    sig.on('audioPeak', (data) => {
      audioState[data.deviceId] = {
        levelDb: data.levelDb,
        alerting: !!data.peak,
      };
      renderDevices();
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

    sig.on('configResult', (data) => console.log('config result:', data));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
