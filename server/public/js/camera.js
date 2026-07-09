(function () {
  'use strict';

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_kioskDeviceId');
  let cameraSourceId = null;
  let subscriberCount = 0;
  let wakeLock = null;
  let currentConfig = {};

  const video = document.getElementById('cameraFeed');
  const connectionDot = document.getElementById('connectionDot');
  const deviceLabel = document.getElementById('deviceLabel');
  const debugCamStatus = document.getElementById('debugCamStatus');
  const debugTracks = document.getElementById('debugTracks');
  const debugSubs = document.getElementById('debugSubs');
  const debugEvent = document.getElementById('debugEvent');
  const cameraError = document.getElementById('cameraError');
  const cameraErrorMsg = document.getElementById('cameraErrorMsg');
  const retryCameraBtn = document.getElementById('retryCameraBtn');

  function logEvent(msg) {
    if (debugEvent) debugEvent.textContent = 'ev:' + msg;
    console.log('[kiosk] ' + msg);
  }

  const DIMS = { '480p': [640, 480], '720p': [1280, 720], '1080p': [1920, 1080] };

  function buildConstraints(config) {
    const cam = (config && config.camera) || 'front';
    const res = (config && config.resolution) || '720p';
    const fr = (config && config.frameRate) || 24;
    const dims = DIMS[res] || DIMS['720p'];
    return {
      video: {
        facingMode: cam === 'rear' ? 'environment' : 'user',
        width: { ideal: dims[0] },
        height: { ideal: dims[1] },
        frameRate: { ideal: fr },
      },
      audio: true,
    };
  }

  function showCameraError(err) {
    const name = err && err.name ? err.name : 'Unknown';
    debugCamStatus.textContent = 'cam:err-' + name;
    cameraErrorMsg.textContent = 'Could not access the camera/microphone (' + name + '). Check permissions and that no other app is using it.';
    cameraError.classList.remove('hidden');
    logEvent('camErr:' + name);
  }

  function hideCameraError() {
    cameraError.classList.add('hidden');
  }

  async function startCamera() {
    try {
      hideCameraError();
      debugCamStatus.textContent = 'cam:starting';

      const stream = await rtc.startCamera(buildConstraints(currentConfig));

      debugTracks.textContent = 'tracks:' + stream.getVideoTracks().length + 'v ' + stream.getAudioTracks().length + 'a';
      debugCamStatus.textContent = 'cam:running';

      video.srcObject = stream;
      video.play().catch(e => {
        console.error('play failed:', e);
        debugCamStatus.textContent = 'cam:play-err';
      });

      if (!cameraSourceId) {
        cameraSourceId = 'cam-' + Date.now();
        sig.publishSource(cameraSourceId, 'Kiosk', 'video+audio');
      }

      rtc.onConnectionStateChange = (peerId, state) => {
        console.log('[kiosk] peer', peerId, 'state:', state);
      };
      rtc.onIceConnectionStateChange = (peerId, state) => {
        console.log('[kiosk] peer', peerId, 'ice:', state);
      };

      // Add tracks to any subscribers that already exist
      for (const [id, pc] of rtc.peerConnections) {
        rtc.addTracksToPeer(pc);
      }
    } catch (err) {
      console.error('Camera failed:', err);
      showCameraError(err);
    }
  }

  // Swap the media tracks on already-established peer connections
  // (used when camera/resolution/framerate changes at runtime)
  function updatePeerTracks() {
    if (!rtc.localStream) return;
    const pools = { video: rtc.localStream.getVideoTracks(), audio: rtc.localStream.getAudioTracks() };
    let vi = 0, ai = 0;
    for (const [id, pc] of rtc.peerConnections) {
      for (const sender of pc.getSenders()) {
        const kind = sender.track ? sender.track.kind : null;
        if (!kind) continue;
        const pool = pools[kind];
        const idx = kind === 'video' ? vi++ : ai++;
        const next = pool[idx];
        if (next) sender.replaceTrack(next).catch(e => console.error('replaceTrack failed', e));
      }
    }
  }

  async function restartCameraWithConfig() {
    try {
      hideCameraError();
      debugCamStatus.textContent = 'cam:restart';
      if (rtc.localStream) rtc.stopCamera();
      const stream = await rtc.startCamera(buildConstraints(currentConfig));
      video.srcObject = stream;
      video.play().catch(() => {});
      debugTracks.textContent = 'tracks:' + stream.getVideoTracks().length + 'v ' + stream.getAudioTracks().length + 'a';
      debugCamStatus.textContent = 'cam:running';
      updatePeerTracks();
      logEvent('camRestarted');
    } catch (err) {
      console.error('Camera restart failed:', err);
      showCameraError(err);
    }
  }

  function init() {
    if (!deviceId) {
      deviceId = 'kiosk-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    }
    localStorage.setItem('hearth_kioskDeviceId', deviceId);
    sig.deviceId = deviceId;
    sig.deviceType = 'kiosk';
    sig.deviceLabel = localStorage.getItem('hearth_deviceLabel') || 'Kiosk';

    retryCameraBtn.addEventListener('click', () => {
      hideCameraError();
      startCamera();
    });

    sig.on('open', () => {
      connectionDot.className = 'status-dot reconnecting';
      sig.joinRoom('default', deviceId);
    });

    sig.on('welcome', async (data) => {
      deviceId = data.deviceId;
      localStorage.setItem('hearth_kioskDeviceId', deviceId);
      deviceLabel.textContent = sig.deviceLabel;
      connectionDot.className = 'status-dot online';
      applyConfig(data.config);
      startCamera();
      requestWakeLock();
    });

    sig.on('close', () => {
      connectionDot.className = 'status-dot offline';
    });

    sig.on('configUpdated', (data) => {
      applyConfig(data.config);
    });

    sig.on('subscriberJoined', (data) => {
      subscriberCount++;
      debugSubs.textContent = 'subs:' + subscriberCount;
      logEvent('subJoined:' + data.subscriberId.slice(-4));
      const peerId = data.subscriberId;
      if (!rtc.localStream) {
        logEvent('NO-LOCALSTREAM');
        console.log('[kiosk] WARN: no localStream for', peerId);
        return;
      }
      const pc = rtc.createPeerConnection(peerId, 'send');
      console.log('[kiosk] created send pc for', peerId, 'tracks:', rtc.localStream.getTracks().length);
      rtc.createOffer(peerId).catch(err => {
        logEvent('offerErr:' + err.name);
        console.error('[kiosk] createOffer failed for', peerId, err);
      });
    });

    sig.on('subscriberLeft', (data) => {
      subscriberCount = Math.max(0, subscriberCount - 1);
      debugSubs.textContent = 'subs:' + subscriberCount;
      console.log('[kiosk] subscriberLeft from', data.subscriberId, 'total:', subscriberCount);
      rtc.closePeerConnection(data.subscriberId);
    });

    sig.connect();
  }

  function applyConfig(config) {
    if (!config) return;
    if (config.label) {
      sig.deviceLabel = config.label;
      localStorage.setItem('hearth_deviceLabel', config.label);
      deviceLabel.textContent = config.label;
    }

    const changed =
      config.resolution !== currentConfig.resolution ||
      config.frameRate !== currentConfig.frameRate ||
      config.camera !== currentConfig.camera;

    currentConfig = Object.assign({}, currentConfig, config);

    if (changed && rtc.localStream) {
      console.log('[kiosk] camera config changed, restarting:', currentConfig);
      restartCameraWithConfig();
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }

  document.addEventListener('DOMContentLoaded', init);
})();
