(function () {
  'use strict';

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_baseDeviceId') || 'base-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  let sources = [];
  let devices = [];
  let monitoringId = null;
  let subscribed = new Set();
  let streams = {};

  const connectionDot = document.getElementById('connectionDot');
  const monitorFeed = document.getElementById('monitorFeed');
  const monitorVideo = document.getElementById('monitorVideo');
  const monitorLabel = document.getElementById('monitorLabel');
  const stopMonitorBtn = document.getElementById('stopMonitorBtn');
  const videoGrid = document.getElementById('videoGrid');
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

  function attachVideo(peerId, stream) {
    const el = document.getElementById('v-' + peerId);
    if (el && el.srcObject !== stream) {
      el.srcObject = stream;
      el.play().catch(() => {});
    }
  }

  function renderDevices() {
    const kiosks = devices.filter(d => d.type === 'kiosk' && d.id !== deviceId);
    if (kiosks.length === 0) {
      deviceList.innerHTML = '<p class="hint" style="padding:12px">No kiosks connected</p>';
    } else {
      deviceList.innerHTML = kiosks.map(d => `
        <div class="device-item" data-id="${d.id}">
          <div>
            <div class="device-name">${d.label}</div>
            <div class="device-last-seen">${d.online ? 'online' : formatTime(d.lastSeenAt)}</div>
          </div>
          <button class="btn btn-small ${monitoringId === d.id ? 'btn-danger' : 'btn-outline'} monitor-btn">${monitoringId === d.id ? 'Stop' : 'Monitor'}</button>
        </div>
      `).join('');
    }
  }

  function renderGrid() {
    if (monitoringId) return;

    monitorFeed.classList.add('hidden');
    videoGrid.classList.remove('hidden');

    const live = sources.filter(s => s.status === 'live');
    if (live.length === 0) {
      videoGrid.innerHTML = '<div class="empty-state"><p>No kiosks connected</p></div>';
      return;
    }

    videoGrid.innerHTML = live.map(s => `
      <div class="video-tile">
        <video id="v-${s.publisherId}" autoplay playsinline muted></video>
        <div class="video-tile-label">${s.label}</div>
      </div>
    `).join('');

    // Re-attach any streams we already have
    live.forEach(s => {
      if (streams[s.publisherId]) {
        attachVideo(s.publisherId, streams[s.publisherId]);
      }
      // Subscribe if not already subscribed
      if (!subscribed.has(s.publisherId)) {
        subscribed.add(s.publisherId);
        sig.subscribeSource(s.publisherId);
      }
    });
  }

  function renderMonitor() {
    if (!monitoringId) return;

    videoGrid.classList.add('hidden');
    monitorFeed.classList.remove('hidden');
    const src = sources.find(s => s.publisherId === monitoringId);
    monitorLabel.textContent = src ? src.label : 'Unknown';

    if (streams[monitoringId]) {
      monitorVideo.srcObject = streams[monitoringId];
      monitorVideo.play().catch(() => {});
    }
  }

  function startMonitor(peerId) {
    console.log('[monitor] start', peerId);
    if (monitoringId === peerId) { stopMonitor(); return; }
    if (devices.find(d => d.id === peerId && d.type !== 'kiosk')) return;

    stopMonitor();
    monitoringId = peerId;

    // Always subscribe fresh for monitor — don't trust cached subscription
    subscribed.add(peerId);
    console.log('[monitor] subscribing to', peerId);
    sig.subscribeSource(peerId);

    renderDevices();
    renderMonitor();
  }

  function stopMonitor() {
    const oldId = monitoringId;
    console.log('[monitor] stop', oldId);
    if (oldId) {
      rtc.closePeerConnection(oldId);
      subscribed.delete(oldId);
    }
    monitoringId = null;
    monitorVideo.srcObject = null;
    renderDevices();
    renderGrid();
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.monitor-btn');
    if (btn) {
      const item = btn.closest('.device-item');
      if (item) startMonitor(item.dataset.id);
      return;
    }

    if (e.target.id === 'stopMonitorBtn') {
      stopMonitor();
      return;
    }

    const item = e.target.closest('.device-item');
    if (item && !e.target.closest('button')) {
      const d = devices.find(dev => dev.id === item.dataset.id);
      if (d && d.type === 'kiosk') showConfig(d);
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
        <label>Resolution</label>
        <select id="cfg-resolution">
          <option value="480p">480p</option>
          <option value="720p" selected>720p</option>
          <option value="1080p">1080p</option>
        </select>
      </div>
      <div class="config-row">
        <label>Frame Rate</label>
        <select id="cfg-framerate">
          <option value="15">15 fps</option>
          <option value="24" selected>24 fps</option>
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
    if (peerId === monitoringId) {
      monitorVideo.srcObject = stream;
      monitorVideo.play().catch(() => {});
    } else {
      attachVideo(peerId, stream);
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
      renderGrid();
    });

    sig.on('close', () => {
      connectionDot.className = 'status-dot offline';
    });

    sig.on('sourceAdded', (source) => {
      if (!sources.find(s => s.id === source.id)) {
        sources.push(source);
        renderGrid();
      }
      renderDevices();
    });

    sig.on('sourceRemoved', (data) => {
      sources = sources.filter(s => s.id !== data.sourceId);
      delete streams[data.sourceId];
      subscribed.delete(data.sourceId);
      if (monitoringId) {
        rtc.closePeerConnection(monitoringId);
        monitoringId = null;
        monitorVideo.srcObject = null;
      }
      renderDevices();
      renderGrid();
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
      renderDevices();
    });

    sig.on('error', (err) => {
      console.error('[signaling] ERROR:', err);
    });

    sig.on('configResult', (data) => console.log('config result:', data));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
