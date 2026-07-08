(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_deviceId');
  let roomId = localStorage.getItem('hearth_roomId');
  let sources = [];
  let devices = {};
  let activePeerConnections = {};

  // ─── DOM refs ────────────────────────────────────────

  const $ = id => document.getElementById(id);
  const setupScreen = $('setupScreen');
  const controlScreen = $('controlScreen');
  const roomIdInput = $('roomIdInput');
  const createRoomBtn = $('createRoomBtn');
  const baseRoomLabel = $('baseRoomLabel');
  const baseConnectionDot = $('baseConnectionDot');
  const videoGrid = $('videoGrid');
  const deviceList = $('deviceList');
  const configPanel = $('configPanel');
  const configForm = $('configForm');
  const configPanelTitle = $('configPanelTitle');
  const presetList = $('presetList');
  const viewerList = $('viewerList');
  const pairingTokenBtn = $('pairingTokenBtn');
  const pairingCodeDisplay = $('pairingCodeDisplay');
  const addPresetBtn = $('addPresetBtn');
  const inviteViewerBtn = $('inviteViewerBtn');

  // ─── Init ────────────────────────────────────────────

  function init() {
    deviceId = localStorage.getItem('hearth_deviceId') || 'base-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    roomId = localStorage.getItem('hearth_roomId');

    sig.deviceId = deviceId;
    sig.deviceType = 'base';
    sig.deviceLabel = 'Base Station';

    // Show setup if no room saved, otherwise go straight to control
    if (roomId) {
      sig.roomId = roomId;
      sig.connect();
      showControlScreen();
    } else {
      showSetupScreen();
    }

    // ─── Signaling events ────────────────────────────

    sig.on('open', () => {
      baseConnectionDot.className = 'status-dot reconnecting';
      if (roomId) {
        sig.joinRoom(roomId, deviceId);
      }
    });

    sig.on('welcome', (data) => {
      roomId = data.roomId;
      localStorage.setItem('hearth_roomId', roomId);
      baseRoomLabel.textContent = roomId;
      baseConnectionDot.className = 'status-dot online';
      sources = data.sources || [];
      renderVideoGrid();
      renderDeviceList();
      showControlScreen();
    });

    sig.on('close', () => {
      baseConnectionDot.className = 'status-dot offline';
    });

    sig.on('sourceAdded', (source) => {
      sources.push(source);
      renderVideoGrid();
      renderDeviceList();
    });

    sig.on('sourceRemoved', (data) => {
      sources = sources.filter(s => s.id !== data.sourceId);
      const peerId = data.sourceId || data.sourceId;
      rtc.closePeerConnection(peerId);
      renderVideoGrid();
      renderDeviceList();
    });

    sig.on('deviceStatus', (data) => {
      renderDeviceList();
    });

    sig.on('offer', async (data) => {
      // Handle incoming WebRTC offer from a publisher
      await rtc.handleOffer(data);
    });

    sig.on('iceCandidate', (data) => {
      rtc.handleIceCandidate(data);
    });

    // When a subscriber joins, we may need to create an offer
    sig.on('subscriberJoined', async (data) => {
      // Create a peer connection to this subscriber
      const peerId = data.subscriberId;
      rtc.createPeerConnection(peerId, 'send');
      await rtc.createOffer(peerId);
    });

    sig.on('subscriberLeft', (data) => {
      rtc.closePeerConnection(data.subscriberId);
    });

    sig.on('configResult', (data) => {
      console.log('Config result:', data);
    });

    // ─── UI events ───────────────────────────────────

    createRoomBtn.addEventListener('click', handleCreateRoom);
    roomIdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleCreateRoom();
    });

    pairingTokenBtn.addEventListener('click', generatePairingToken);
    addPresetBtn.addEventListener('click', showAddPresetDialog);
    inviteViewerBtn.addEventListener('click', inviteViewer);
  }

  // ─── Room Creation ───────────────────────────────────

  function handleCreateRoom() {
    const room = roomIdInput.value.trim().toLowerCase().replace(/\s+/g, '-');
    if (!room) return;

    roomId = room;
    localStorage.setItem('hearth_roomId', room);
    showControlScreen();
    sig.connect();
    sig.on('open', () => {
      sig.joinRoom(room, deviceId);
    });
  }

  // ─── Pairing Token ───────────────────────────────────

  function generatePairingToken() {
    const token = 'HEARTH-' + Math.random().toString(36).slice(2, 6).toUpperCase() +
                  '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    pairingCodeDisplay.textContent = token;
    pairingCodeDisplay.classList.remove('hidden');
    pairingTokenBtn.textContent = 'Hide Code';

    // Toggle visibility
    pairingTokenBtn.onclick = () => {
      pairingCodeDisplay.classList.toggle('hidden');
    };

    // Auto-hide after 5 minutes
    setTimeout(() => {
      pairingCodeDisplay.classList.add('hidden');
    }, 300000);
  }

  // ─── Video Grid ──────────────────────────────────────

  function renderVideoGrid() {
    const activeSources = sources.filter(s => s.status === 'live');

    if (activeSources.length === 0) {
      videoGrid.innerHTML = `
        <div class="empty-state">
          <p>No cameras connected</p>
          <p class="hint">Click "Add Camera" and enter the code on a camera device</p>
        </div>`;
      return;
    }

    videoGrid.innerHTML = activeSources.map(source => `
      <div class="video-tile" data-source-id="${source.id}">
        <video id="video-${source.id}" autoplay playsinline muted></video>
        <div class="video-tile-label">${source.label}</div>
      </div>
    `).join('');

    // Subscribe to each source if we haven't already
    activeSources.forEach(source => {
      const peerId = source.publisherId;
      if (!rtc.peerConnections.has(peerId)) {
        // Subscribe and create offer
        sig.subscribeSource(peerId);
      }
    });
  }

  // ─── Device List ─────────────────────────────────────

  function renderDeviceList() {
    // This uses the sources + any known devices from the server
    deviceList.innerHTML = sources.map(source => `
      <div class="device-item">
        <div>
          <div class="device-name">${source.label}</div>
          <div class="device-type">${source.publisherId}</div>
        </div>
        <span class="status-dot ${source.status === 'live' ? 'online' : 'offline'}"></span>
      </div>
    `).join('') || '<p class="hint" style="padding:12px">No devices yet</p>';

    // Click on device opens config panel
    deviceList.querySelectorAll('.device-item').forEach((item, index) => {
      item.addEventListener('click', () => {
        const source = sources[index];
        if (source) {
          showConfigPanel(source);
        }
      });
    });
  }

  // ─── Config Panel ────────────────────────────────────

  function showConfigPanel(source) {
    configPanel.classList.remove('hidden');
    configPanelTitle.textContent = `${source.label} Settings`;

    configForm.innerHTML = `
      <div class="config-row">
        <label>Label</label>
        <input type="text" id="cfg-label" value="${source.label}">
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
        <label>Night Mode</label>
        <div class="toggle-switch" id="cfg-nightMode"></div>
      </div>
      <div class="config-row">
        <label>Torch</label>
        <div class="toggle-switch" id="cfg-torch"></div>
      </div>
      <div class="config-row">
        <label>Microphone Sensitivity</label>
        <input type="range" id="cfg-mic" min="0" max="1" step="0.1" value="0.8">
      </div>
      <div class="config-row">
        <label>Speaker Volume</label>
        <input type="range" id="cfg-speaker" min="0" max="1" step="0.1" value="0.5">
      </div>
      <div class="config-row">
        <label>Two-way Audio</label>
        <div class="toggle-switch active" id="cfg-twoWay"></div>
      </div>
      <div class="config-row">
        <label>Stream Enabled</label>
        <div class="toggle-switch active" id="cfg-stream"></div>
      </div>
      <div class="config-row">
        <label>Keep Awake</label>
        <div class="toggle-switch active" id="cfg-keepAwake"></div>
      </div>
      <button id="saveConfigBtn" class="btn btn-primary" style="margin-top:12px">Save Settings</button>
    `;

    // Toggle switch handler
    configForm.querySelectorAll('.toggle-switch').forEach(el => {
      el.addEventListener('click', () => {
        el.classList.toggle('active');
      });
    });

    document.getElementById('saveConfigBtn').addEventListener('click', () => {
      const config = {
        label: document.getElementById('cfg-label').value,
        resolution: document.getElementById('cfg-resolution').value,
        frameRate: parseInt(document.getElementById('cfg-framerate').value),
        nightMode: document.getElementById('cfg-nightMode').classList.contains('active'),
        torch: document.getElementById('cfg-torch').classList.contains('active'),
        micSensitivity: parseFloat(document.getElementById('cfg-mic').value),
        speakerVolume: parseFloat(document.getElementById('cfg-speaker').value),
        twoWayAudioEnabled: document.getElementById('cfg-twoWay').classList.contains('active'),
        streamEnabled: document.getElementById('cfg-stream').classList.contains('active'),
        keepAwake: document.getElementById('cfg-keepAwake').classList.contains('active'),
      };

      sig.setConfig(source.publisherId, config);
    });
  }

  // ─── Presets ─────────────────────────────────────────

  function showAddPresetDialog() {
    const name = prompt('Preset name (e.g. Nighttime, Naptime):');
    if (!name) return;

    const item = document.createElement('div');
    item.className = 'preset-item';
    item.innerHTML = `
      <span>${name}</span>
      <button class="btn btn-outline btn-small apply-preset">Apply</button>
    `;
    presetList.appendChild(item);

    item.querySelector('.apply-preset').addEventListener('click', () => {
      // In a full impl, this would apply the preset's config to all cameras
      // For now, show a message
      console.log(`Apply preset: ${name}`);
    });
  }

  // ─── Viewer Invite ───────────────────────────────────

  function inviteViewer() {
    const url = `${location.origin}/viewer.html`;
    const msg = prompt('Share this viewer URL:', url);
    if (msg) {
      // Copy to clipboard
      navigator.clipboard.writeText(url).catch(() => {});
    }
  }

  // ─── Screens ─────────────────────────────────────────

  function showSetupScreen() {
    setupScreen.classList.remove('hidden');
    controlScreen.classList.add('hidden');
  }

  function showControlScreen() {
    setupScreen.classList.add('hidden');
    controlScreen.classList.remove('hidden');
  }

  // ─── Start ───────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);
})();
