(function () {
  'use strict';

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_baseDeviceId') || 'base-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  let sources = [];
  let devices = [];
  let viewingId = null;
  let viewMode = null; // 'video' | 'audio'
  let subscribed = new Set();
  let streams = {};

  const connectionDot = document.getElementById('connectionDot');
  const monitorFeed = document.getElementById('monitorFeed');
  const monitorVideo = document.getElementById('monitorVideo');
  const monitorLabel = document.getElementById('monitorLabel');
  const monitorMode = document.getElementById('monitorMode');
  const monitorError = document.getElementById('monitorError');
  const monitorPlaceholder = document.getElementById('monitorPlaceholder');
  const stopMonitorBtn = document.getElementById('stopMonitorBtn');
  const homeView = document.getElementById('homeView');
  const deviceList = document.getElementById('deviceList');
  const configPanel = document.getElementById('configPanel');
  const configForm = document.getElementById('configForm');
  const configTitle = document.getElementById('configTitle');

  function formatTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  function attachMonitorStream() {
    if (!viewingId) return;
    const stream = streams[viewingId];
    if (!stream) return;
    monitorVideo.srcObject = stream;
    monitorVideo.muted = false;
    monitorVideo.play().catch(() => {});
    applyViewMode();
  }

  function applyViewMode() {
    if (!viewingId) return;
    const stream = streams[viewingId];
    if (!stream) return;
    const vTracks = stream.getVideoTracks();
    if (viewMode === 'audio') {
      vTracks.forEach(t => { t.enabled = false; });
      monitorVideo.classList.add('hidden');
      monitorPlaceholder.classList.remove('hidden');
      monitorMode.textContent = '🔊 Listening';
    } else {
      vTracks.forEach(t => { t.enabled = true; });
      monitorVideo.classList.remove('hidden');
      monitorPlaceholder.classList.add('hidden');
      monitorMode.textContent = '📹 Watching';
    }
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
      return `
        <div class="device-item" data-id="${d.id}">
          <div class="device-info">
            <div class="device-name">${d.label}</div>
            <div class="device-last-seen ${d.online ? 'online' : 'offline'}">${d.online ? 'online' : formatTime(d.lastSeenAt)}</div>
          </div>
          <div class="btn-row">
            <button class="btn btn-small ${aActive ? 'btn-danger' : 'btn-outline'} audio-btn" data-id="${d.id}">${aActive ? 'Stop' : 'Audio'}</button>
            <button class="btn btn-small ${vActive ? 'btn-danger' : 'btn-outline'} video-btn" data-id="${d.id}">${vActive ? 'Stop' : 'Video'}</button>
            <button class="btn btn-small btn-outline settings-btn" data-id="${d.id}">Settings</button>
          </div>
        </div>`;
    }).join('');
  }

  function startView(peerId, mode) {
    console.log('[view] start', peerId, mode);
    if (viewingId === peerId && viewMode === mode) { stopView(); return; }
    if (devices.find(d => d.id === peerId && d.type !== 'kiosk')) return;

    stopView();
    viewingId = peerId;
    viewMode = mode;

    if (!subscribed.has(peerId)) {
      subscribed.add(peerId);
      console.log('[view] subscribing', peerId);
      sig.subscribeSource(peerId);
    }

    showMonitor();
    renderDevices();
    attachMonitorStream();
    // Unmute within the user gesture so iOS Safari allows audio playback
    monitorVideo.muted = false;
    monitorVideo.play().catch(() => {});
  }

  function stopView() {
    const oldId = viewingId;
    console.log('[view] stop', oldId);
    if (oldId) {
      rtc.closePeerConnection(oldId);
      subscribed.delete(oldId);
    }
    viewingId = null;
    viewMode = null;
    monitorVideo.srcObject = null;
    monitorVideo.muted = true;
    monitorError.classList.add('hidden');
    showHome();
    renderDevices();
  }

  function showMonitor() {
    homeView.classList.add('hidden');
    monitorFeed.classList.remove('hidden');
    const src = sources.find(s => s.publisherId === viewingId);
    monitorLabel.textContent = src ? src.label : 'Unknown';
    monitorError.classList.add('hidden');
  }

  function showHome() {
    monitorFeed.classList.add('hidden');
    homeView.classList.remove('hidden');
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'stopMonitorBtn') { stopView(); return; }

    const audioBtn = t.closest('.audio-btn');
    if (audioBtn) { startView(audioBtn.dataset.id, 'audio'); return; }

    const videoBtn = t.closest('.video-btn');
    if (videoBtn) { startView(videoBtn.dataset.id, 'video'); return; }

    const settingsBtn = t.closest('.settings-btn');
    if (settingsBtn) {
      const d = devices.find(dev => dev.id === settingsBtn.dataset.id);
      if (d) showConfig(d);
      return;
    }
  });

  function showConfig(device) {
    configPanel.classList.remove('hidden');
    configTitle.textContent = device.label + ' Settings';
    configForm.innerHTML = `
      <div class="config-row">
        <label>Label</label>
        <input type="text" id="cfg-label" value="${device.label}">
      </div>
      <div class="config-row">
        <label>Camera</label>
        <select id="cfg-camera">
          <option value="front">Front</option>
          <option value="rear">Rear</option>
        </select>
      </div>
      <div class="config-row">
        <label>Resolution</label>
        <select id="cfg-resolution">
          <option value="480p">480p</option>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
        </select>
      </div>
      <div class="config-row">
        <label>Frame Rate</label>
        <select id="cfg-framerate">
          <option value="15">15 fps</option>
          <option value="24">24 fps</option>
          <option value="30">30 fps</option>
        </select>
      </div>
      <div class="config-row">
        <label>Two-way Audio</label>
        <div class="toggle-switch active" id="cfg-twoWay"></div>
      </div>
      <div class="config-row">
        <label>Keep Awake</label>
        <div class="toggle-switch active" id="cfg-keepAwake"></div>
      </div>
      <button id="saveConfigBtn" class="btn btn-primary" style="margin-top:12px">Save</button>
    `;
    configForm.querySelectorAll('.toggle-switch').forEach(el => {
      el.addEventListener('click', () => el.classList.toggle('active'));
    });
    document.getElementById('saveConfigBtn').addEventListener('click', () => {
      sig.setConfig(device.id, {
        label: document.getElementById('cfg-label').value,
        camera: document.getElementById('cfg-camera').value,
        resolution: document.getElementById('cfg-resolution').value,
        frameRate: parseInt(document.getElementById('cfg-framerate').value),
        twoWayAudioEnabled: document.getElementById('cfg-twoWay').classList.contains('active'),
        keepAwake: document.getElementById('cfg-keepAwake').classList.contains('active'),
      });
    });
  }

  // ─── WebRTC ──

  rtc.onRemoteTrack = (peerId, stream) => {
    streams[peerId] = stream;
    if (peerId === viewingId) {
      attachMonitorStream();
    }
  };

  rtc.onConnectionStateChange = (peerId, state) => {
    console.log('[webrtc] peer', peerId, 'connection state:', state);
  };

  rtc.onIceConnectionStateChange = (peerId, state) => {
    console.log('[webrtc] peer', peerId, 'ice state:', state);
  };

  // ─── Signaling ──

  function init() {
    localStorage.setItem('hearth_baseDeviceId', deviceId);
    sig.deviceId = deviceId;
    sig.deviceType = 'base';
    sig.deviceLabel = 'Base Station';
    sig.connect();

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
      if (!sources.find(s => s.id === source.id)) {
        sources.push(source);
      }
      renderDevices();
    });

    sig.on('sourceRemoved', (data) => {
      const removed = sources.find(s => s.id === data.sourceId);
      const pubId = removed ? removed.publisherId : data.sourceId;
      sources = sources.filter(s => s.id !== data.sourceId);
      delete streams[data.sourceId];
      subscribed.delete(pubId);
      if (pubId === viewingId) {
        rtc.closePeerConnection(viewingId);
        viewingId = null;
        viewMode = null;
        monitorVideo.srcObject = null;
        showHome();
      }
      renderDevices();
    });

    sig.on('deviceStatus', (data) => {
      let d = devices.find(dev => dev.id === data.deviceId);
      if (d) {
        d.online = data.status === 'online';
        d.lastSeenAt = data.lastSeenAt || Date.now();
        if (data.label) d.label = data.label;
        if (data.type) d.type = data.type;
      } else if (data.status === 'online' && data.type) {
        devices.push({
          id: data.deviceId,
          label: data.label || data.deviceId,
          type: data.type,
          lastSeenAt: data.lastSeenAt || Date.now(),
          online: true,
        });
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
