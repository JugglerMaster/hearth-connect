(function () {
  'use strict';

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_kioskDeviceId');
  let cameraSourceId = null;
  let subscriberCount = 0;
  let wakeLock = null;

  const video = document.getElementById('cameraFeed');
  const connectionDot = document.getElementById('connectionDot');
  const deviceLabel = document.getElementById('deviceLabel');
  const debugCamStatus = document.getElementById('debugCamStatus');
  const debugTracks = document.getElementById('debugTracks');
  const debugSubs = document.getElementById('debugSubs');
  const debugEvent = document.getElementById('debugEvent');

  function logEvent(msg) {
    if (debugEvent) debugEvent.textContent = 'ev:' + msg;
    console.log('[kiosk] ' + msg);
  }

  async function startCamera() {
    try {
      debugCamStatus.textContent = 'cam:starting';

      const stream = await rtc.startCamera({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });

      debugTracks.textContent = 'tracks:' + stream.getVideoTracks().length + 'v ' + stream.getAudioTracks().length + 'a';
      debugCamStatus.textContent = 'cam:running';

      video.srcObject = stream;
      video.play().catch(e => {
        console.error('play failed:', e);
        debugCamStatus.textContent = 'cam:play-err';
      });

      cameraSourceId = 'cam-' + Date.now();
      sig.publishSource(cameraSourceId, 'Kiosk', 'video+audio');

      rtc.onConnectionStateChange = (peerId, state) => {
        console.log('[kiosk] peer', peerId, 'state:', state);
      };
      rtc.onIceConnectionStateChange = (peerId, state) => {
        console.log('[kiosk] peer', peerId, 'ice:', state);
      };

      for (const [id, pc] of rtc.peerConnections) {
        rtc.addTracksToPeer(pc);
      }
    } catch (err) {
      console.error('Camera failed:', err);
      debugCamStatus.textContent = 'cam:err-' + err.name;
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
