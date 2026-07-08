(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_deviceId');
  let roomId = localStorage.getItem('hearth_roomId');
  let streaming = false;
  let wakeLock = null;

  // ─── DOM refs ────────────────────────────────────────

  const $ = id => document.getElementById(id);
  const pairingScreen = $('pairingScreen');
  const statusScreen = $('statusScreen');
  const pairingCode = $('pairingCode');
  const pairBtn = $('pairBtn');
  const pairError = $('pairError');
  const startBtn = $('startStreamBtn');
  const stopBtn = $('stopStreamBtn');
  const localVideo = $('localVideo');
  const videoPreview = $('videoPreview');
  const connectionDot = $('connectionDot');
  const deviceLabel = $('deviceLabel');
  const roomName = $('roomName');
  const streamStatus = $('streamStatus');
  const wakeLockStatus = $('wakeLockStatus');
  const roomLabel = $('roomLabel');
  const disconnectBtn = $('disconnectBtn');

  // ─── Initial State ───────────────────────────────────

  function init() {
    if (deviceId && roomId) {
      showStatusScreen();
      sig.deviceId = deviceId;
      sig.roomId = roomId;
    } else {
      showPairingScreen();
    }

    sig.deviceType = 'camera';
    sig.deviceLabel = localStorage.getItem('hearth_deviceLabel') || 'Camera';

    // Connect signaling
    sig.connect();

    // ─── Signaling events ────────────────────────────

    sig.on('open', () => {
      connectionDot.className = 'status-dot reconnecting';
    });

    sig.on('welcome', (data) => {
      deviceId = data.deviceId;
      roomId = data.roomId;
      localStorage.setItem('hearth_deviceId', deviceId);
      localStorage.setItem('hearth_roomId', roomId);
      roomLabel.textContent = roomId;
      roomName.textContent = roomId;
      deviceLabel.textContent = sig.deviceLabel || 'Camera';
      connectionDot.className = 'status-dot online';
      showStatusScreen();
      applyConfig(data.config);
    });

    sig.on('close', () => {
      connectionDot.className = 'status-dot offline';
    });

    sig.on('configUpdated', (data) => {
      applyConfig(data.config);
    });

    sig.on('talkEnabled', () => {
      // A viewer wants to talk back
      // The server already handles notifying, but we could show a visual
      console.log('Talkback enabled');
    });

    sig.on('talkDisabled', () => {
      console.log('Talkback disabled');
    });

    // ─── UI events ───────────────────────────────────

    pairBtn.addEventListener('click', handlePair);
    pairingCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handlePair();
    });

    startBtn.addEventListener('click', startStream);
    stopBtn.addEventListener('click', stopStream);
    disconnectBtn.addEventListener('click', handleDisconnect);
  }

  // ─── Pairing ─────────────────────────────────────────

  function handlePair() {
    const code = pairingCode.value.trim().toUpperCase();
    if (!code) {
      pairError.textContent = 'Enter a pairing code';
      pairError.classList.remove('hidden');
      return;
    }

    pairBtn.disabled = true;
    pairError.classList.add('hidden');

    sig.pairDevice(code, 'camera', 'Nursery Camera');
    sig.on('error', (err) => {
      if (err.code === 'INVALID_TOKEN') {
        pairError.textContent = 'Invalid or expired code. Generate a new one from the Base Station.';
        pairError.classList.remove('hidden');
        pairBtn.disabled = false;
      }
    });
  }

  // ─── Streaming ───────────────────────────────────────

  async function startStream() {
    if (streaming) return;

    try {
      // Use rear camera by default; config can override
      const stream = await rtc.startCamera({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });

      localVideo.srcObject = stream;
      videoPreview.classList.remove('hidden');
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      streaming = true;
      streamStatus.textContent = 'Streaming';

      // Publish our source to the room
      sig.publishSource('cam-' + Date.now(), 'Camera', 'video+audio');

      // Request wake lock to keep screen on
      requestWakeLock();

    } catch (err) {
      console.error('Failed to start stream:', err);
      streamStatus.textContent = 'Camera access denied';
    }
  }

  function stopStream() {
    rtc.stopCamera();
    localVideo.srcObject = null;
    videoPreview.classList.add('hidden');
    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    streaming = false;
    streamStatus.textContent = 'Idle';

    // Unpublish all sources
    sig.unpublishSource('*'); // server handles wildcard as "all"
    releaseWakeLock();
  }

  // ─── Wake Lock ───────────────────────────────────────

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
          wakeLockStatus.textContent = 'Released';
        });
        wakeLockStatus.textContent = 'Active';
      }
    } catch {
      wakeLockStatus.textContent = 'Unavailable';
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release();
      wakeLock = null;
      wakeLockStatus.textContent = 'Inactive';
    }
  }

  // ─── Config ──────────────────────────────────────────

  function applyConfig(config) {
    if (!config) return;

    // Apply camera config in real-time
    if (config.label) {
      sig.deviceLabel = config.label;
      localStorage.setItem('hearth_deviceLabel', config.label);
      deviceLabel.textContent = config.label;
    }

    // If stream should be on/off
    if (config.streamEnabled === false && streaming) {
      stopStream();
    } else if (config.streamEnabled === true && !streaming) {
      startStream();
    }

    // Wake lock
    if (config.keepAwake === false) {
      releaseWakeLock();
      wakeLockStatus.textContent = 'Disabled';
    } else if (config.keepAwake === true && streaming) {
      requestWakeLock();
    }

    // Camera switch requires restart
    if (config.camera && streaming) {
      stopStream();
      startStream();
    }
  }

  // ─── Screens ─────────────────────────────────────────

  function showPairingScreen() {
    pairingScreen.classList.remove('hidden');
    statusScreen.classList.add('hidden');
  }

  function showStatusScreen() {
    pairingScreen.classList.add('hidden');
    statusScreen.classList.remove('hidden');
  }

  function handleDisconnect() {
    stopStream();
    sig.disconnect();
    localStorage.removeItem('hearth_deviceId');
    localStorage.removeItem('hearth_roomId');
    localStorage.removeItem('hearth_deviceLabel');
    deviceId = null;
    roomId = null;
    showPairingScreen();
    // Reconnect signaling for fresh start
    sig.connect();
  }

  // ─── Go ──────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);
})();
