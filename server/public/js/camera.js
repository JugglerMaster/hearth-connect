(function () {
  'use strict';

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_kioskDeviceId');
  let cameraSourceId = null;
  let publishedType = null;
  let subscriberCount = 0;
  const subscribers = new Set();
  let wakeLock = null;
  let cameraStarted = false;

  // ─── Persistent device settings (localStorage) ──────────
  // Each kiosk remembers the last settings it had, restored on load even
  // before the server connection is established. Base-station changes that
  // arrive over signaling are merged in and re-saved here.
  const SETTINGS_KEY = 'hearth_kioskSettings';

  function defaultSettings() {
    const base = {
      camera: 'front',
      resolution: '720p',
      frameRate: 30,
      nightMode: false,
      torch: false,
      micSensitivity: 0.8,
      speakerVolume: 0.5,
      twoWayAudioEnabled: true,
      showFeed: false,
      keepAwake: true,
    };
    // iOS ≤12 is slow — default its new devices to 480p.
    if (isLegacyIOS()) base.resolution = '480p';
    return base;
  }

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch { saved = {}; }
    return Object.assign(defaultSettings(), saved);
  }

  function saveSettings(cfg) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg));
    } catch { /* storage unavailable — ignore */ }
  }

  let currentConfig = loadSettings();

  let localVideoStream = null;
  let localAudioStream = null;
  let hasVideo = false;
  let hasAudio = false;

  let audioCtx = null;
  let analyser = null;
  let audioMeterTimer = null;
  let audioMeterTickCount = 0;
  let smoothRms = 0;            // exponential moving average of RMS

  const video = document.getElementById('cameraFeed');
  const connectionDot = document.getElementById('connectionDot');
  const deviceLabel = document.getElementById('deviceLabel');
  const debugCamStatus = document.getElementById('debugCamStatus');
  const debugTracks = document.getElementById('debugTracks');
  const debugSubs = document.getElementById('debugSubs');
  const debugDbLevel = document.getElementById('debugDbLevel');
  const debugEvent = document.getElementById('debugEvent');
  const debugMethod = document.getElementById('debugMethod');
  const cameraError = document.getElementById('cameraError');
  const cameraErrorMsg = document.getElementById('cameraErrorMsg');
  const retryCameraBtn = document.getElementById('retryCameraBtn');
  const enableCamOverlay = document.getElementById('enableCamOverlay');
  const enableCamBtn = document.getElementById('enableCamBtn');

  function logEvent(msg) {
    if (debugEvent) debugEvent.textContent = 'ev:' + msg;
    console.log('[kiosk] ' + msg);
  }

  // Surface uncaught errors on-device (no Safari dev tools on iPad Air).
  window.addEventListener('error', function (e) {
    const detail = e && e.message ? e.message : 'unknown error';
    const where = e && e.filename ? ' @' + e.filename + ':' + e.lineno : '';
    console.error('[kiosk] window error' + where + ': ' + detail);
    logEvent('ERR:' + detail);
  });
  window.addEventListener('unhandledrejection', function (e) {
    const reason = e && e.reason ? (e.reason.message || String(e.reason)) : 'unhandled rejection';
    console.error('[kiosk] unhandledrejection:', reason);
    logEvent('REJ:' + reason);
  });

  const DIMS = { '480p': [640, 480], '720p': [1280, 720], '1080p': [1920, 1080] };

  function buildVideoConstraints(config) {
    const res = (config && config.resolution) || '720p';
    const cam = (config && config.camera) || 'front';
    const fr = (config && config.frameRate) || 24;
    const dims = DIMS[res] || DIMS['720p'];
    if (config && config.videoDevice) {
      return {
        video: {
          deviceId: { exact: config.videoDevice },
          width: { ideal: dims[0] },
          height: { ideal: dims[1] },
          frameRate: { ideal: fr },
        },
      };
    }
    return {
      video: {
        facingMode: cam === 'rear' ? 'environment' : 'user',
        width: { ideal: dims[0] },
        height: { ideal: dims[1] },
        frameRate: { ideal: fr },
      },
    };
  }

  function buildAudioConstraints(config) {
    if (config && config.audioDevice) {
      return { audio: { deviceId: { exact: config.audioDevice } } };
    }
    return { audio: true };
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

  function stopLocalMedia() {
    if (localVideoStream) { localVideoStream.getTracks().forEach(t => t.stop()); localVideoStream = null; }
    if (localAudioStream) { localAudioStream.getTracks().forEach(t => t.stop()); localAudioStream = null; }
    hasVideo = false;
    hasAudio = false;
    stopAudioAnalyser();
    if (rtc.localStream) { rtc.localStream.getTracks().forEach(t => t.stop()); rtc.localStream = null; }
  }

  function currentSourceType() {
    if (hasVideo && hasAudio) return 'video+audio';
    if (hasVideo) return 'video-only';
    if (hasAudio) return 'audio-only';
    return 'none';
  }

  function publishCurrentSource() {
    const type = currentSourceType();
    if (type === 'none') {
      if (publishedType && cameraSourceId) {
        sig.unpublishSource(cameraSourceId);
        publishedType = null;
      }
      return;
    }
    if (!cameraSourceId) cameraSourceId = 'cam-' + Date.now();
    // Only re-broadcast when the published type actually changes. A resolution/framerate
    // change swaps tracks on existing peer connections (syncPeerTracks) without disturbing
    // an active watch session.
    if (type !== publishedType) {
      if (publishedType) sig.unpublishSource(cameraSourceId);
      sig.publishSource(cameraSourceId, sig.deviceLabel || 'Kiosk', type);
      publishedType = type;
    }
  }

  // ─── Audio threshold analyser ─────────────────────────

  function stopAudioAnalyser() {
    if (audioMeterTimer) { clearInterval(audioMeterTimer); audioMeterTimer = null; }
    if (analyser) { try { analyser.disconnect(); } catch {} analyser = null; }
  }

  function setupAudioAnalyser() {
    stopAudioAnalyser();
    if (!hasAudio || !localAudioStream) return;
    const track = localAudioStream.getAudioTracks()[0];
    if (!track) return;
    try {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      const src = audioCtx.createMediaStreamSource(localAudioStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      audioMeterTickCount = 0;
      smoothRms = 0;
      audioMeterTimer = setInterval(audioMeterTick, 250);
    } catch (e) {
      console.error('[kiosk] analyser setup failed', e);
    }
  }

  function audioMeterTick() {
    if (!analyser || !hasAudio) return;
    const n = analyser.fftSize;
    let rms;
    if (typeof analyser.getFloatTimeDomainData === 'function') {
      const buf = new Float32Array(n);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      rms = Math.sqrt(sum / buf.length);
    } else {
      // iOS ≤12 only exposes the byte variant (values 0–255, centered at 128).
      const bytes = new Uint8Array(n);
      analyser.getByteTimeDomainData(bytes);
      let sum = 0;
      for (let i = 0; i < bytes.length; i++) {
        const v = (bytes[i] - 128) / 128;
        sum += v * v;
      }
      rms = Math.sqrt(sum / bytes.length);
    }
    // Exponential moving average — smooths fast fluctuations without allocating
    // arrays or causing GC pressure on memory-constrained iOS devices.
    const alpha = 0.3;
    smoothRms = alpha * rms + (1 - alpha) * smoothRms;
    let db = 20 * Math.log10(smoothRms);
    if (!isFinite(db) || !isFinite(smoothRms)) db = -100;

    if (debugDbLevel) debugDbLevel.textContent = 'audio:' + (db < -70 ? '---' : db.toFixed(0) + 'dB');

    audioMeterTickCount++;
    const alertEnabled = currentConfig.audioAlertEnabled !== false;
    const threshold = (currentConfig.audioAlertThresholdDb != null) ? currentConfig.audioAlertThresholdDb : -40;

    // Throttled meter update (~1Hz): report whether audio is above threshold
    if (alertEnabled && audioMeterTickCount % 4 === 0) {
      const isAbove = db > threshold;
      sig.send('AUDIO_PEAK', { deviceId: sig.deviceId, levelDb: db, peak: isAbove, ts: Date.now() });
    }
  }

  // ─── Device enumeration / capabilities ────────────────

  function guessFacing(d) {
    const lbl = (d.label || '').toLowerCase();
    if (lbl.includes('back') || lbl.includes('rear') || lbl.includes('environment')) return 'environment';
    if (lbl.includes('front') || lbl.includes('facetime') || lbl.includes('user')) return 'user';
    return null;
  }

  async function reportCapabilities() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = all
        .filter(d => d.kind === 'videoinput')
        .map(d => ({ id: d.deviceId, label: d.label || 'Camera', facingMode: guessFacing(d) }));
      const audioDevices = all
        .filter(d => d.kind === 'audioinput')
        .map(d => ({ id: d.deviceId, label: d.label || 'Microphone' }));
      sig.send('CAPABILITIES', { deviceId: sig.deviceId, videoDevices, audioDevices });
    } catch (e) {
      console.error('[kiosk] enumerateDevices failed', e);
    }
  }

  // ─── Media acquisition ────────────────────────────────

  async function startMedia() {
    try {
      hideCameraError();
      debugCamStatus.textContent = 'cam:starting';

      stopLocalMedia();

      // Eagerly create AudioContext while still in the user gesture (iOS 12).
      // On legacy iOS, AudioContext created outside a gesture starts suspended
      // and produces silence, so the peak detector never fires.
      if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
      }

      // Single combined getUserMedia — splitting into separate video/audio
      // calls breaks audio on iOS ≤12 (the audio track arrives dead).
      const constraints = Object.assign(
        {},
        buildVideoConstraints(currentConfig),
        buildAudioConstraints(currentConfig),
      );
      let stream;
      try {
        stream = await rtc.startCamera(constraints);
      } catch (e) {
        // If the combined call fails, try video-only as a degraded path.
        try {
          stream = await rtc.startVideo(buildVideoConstraints(currentConfig));
        } catch (e2) {
          showCameraError(e2);
          return;
        }
      }

      localVideoStream = new MediaStream(stream.getVideoTracks());
      localAudioStream = new MediaStream(stream.getAudioTracks());
      hasVideo = localVideoStream.getVideoTracks().length > 0;
      hasAudio = localAudioStream.getAudioTracks().length > 0;
      if (!hasAudio) logEvent('noAudio');
      if (!hasVideo) logEvent('noVideo');

      if (!hasVideo && !hasAudio) {
        showCameraError(new Error('No camera or microphone available'));
        return;
      }

      const merged = new MediaStream();
      if (localVideoStream) localVideoStream.getVideoTracks().forEach(t => merged.addTrack(t));
      if (localAudioStream) localAudioStream.getAudioTracks().forEach(t => merged.addTrack(t));
      rtc.localStream = merged;

      debugTracks.textContent = 'tracks:' + merged.getVideoTracks().length + 'v ' + merged.getAudioTracks().length + 'a';
      debugCamStatus.textContent = hasVideo && hasAudio ? 'cam:running'
        : hasVideo ? 'cam:video-only' : 'cam:audio-only';

      video.srcObject = merged;
      video.play().catch(e => {
        console.error('play failed:', e);
        debugCamStatus.textContent = 'cam:play-err';
      });

      publishCurrentSource();
      setupAudioAnalyser();

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

      // Offer to any subscribers that joined before media was ready
      for (const subId of subscribers) {
        offerToSubscriber(subId);
      }

      reportCapabilities();
    } catch (err) {
      console.error('Media failed:', err);
      showCameraError(err);
    }
  }

  // Swap the media tracks on already-established peer connections
  // (used when camera/resolution/framerate/device changes at runtime)
  function syncPeerTracks() {
    for (const [id] of rtc.peerConnections) {
      rtc.syncTracksToPeer(id);
    }
  }

  async function restartMediaWithConfig() {
    try {
      hideCameraError();
      debugCamStatus.textContent = 'cam:restart';
      await startMedia();
      syncPeerTracks();
      logEvent('mediaRestarted');
    } catch (err) {
      console.error('Media restart failed:', err);
      showCameraError(err);
    }
  }

  function offerToSubscriber(peerId) {
    if (!rtc.localStream) return;
    // Always close any existing connection before creating a new one.
    // The base station may have closed its end but the kiosk's state
    // might not have updated yet, causing it to skip the offer.
    const existingPc = rtc.peerConnections.get(peerId);
    if (existingPc) {
      existingPc.close();
      rtc.peerConnections.delete(peerId);
    }
    const pc = rtc.createPeerConnection(peerId, 'send');
    console.log('[kiosk] created send pc for', peerId, 'tracks:', rtc.localStream.getTracks().length);
    rtc.createOffer(peerId).catch(err => {
      logEvent('offerErr:' + err.name);
      console.error('[kiosk] createOffer for', peerId, err);
    });
  }

  // iOS ≤12 requires a user gesture before the camera permission prompt can
  // appear. iOS 13+ relaxed this, so those devices can auto-start as before.
  function isLegacyIOS() {
    const ua = navigator.userAgent;
    const m = ua.match(/OS (\d+)_(\d+)_?(\d+)? like Mac OS X/);
    if (!m) return false;
    return parseInt(m[1], 10) < 13;
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
      startMedia();
    });

    if (enableCamBtn) enableCamBtn.addEventListener('click', enableCamera);

    // Legacy iOS (≤12) must surface the camera prompt from a user gesture,
    // so show the tap-to-enable overlay up front. Modern iOS auto-starts.
    if (isLegacyIOS() && enableCamOverlay) {
      enableCamOverlay.classList.remove('hidden');
    }

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', reportCapabilities);
    }

    sig.on('open', () => {
      connectionDot.className = 'status-dot reconnecting';
      if (debugMethod) debugMethod.textContent = 'method:' + (sig.useSSE ? 'SSE' : 'WS');
      logEvent(sig.useSSE ? 'sse:open' : 'ws:open');
      sig.joinRoom('default', deviceId);
    });

    sig.on('welcome', async (data) => {
      deviceId = data.deviceId;
      localStorage.setItem('hearth_kioskDeviceId', deviceId);
      deviceLabel.textContent = sig.deviceLabel;
      connectionDot.className = 'status-dot online';
      applyConfig(data.config);
      logEvent('welcome:' + data.deviceId.slice(-4));
      if (isLegacyIOS()) {
        // iOS ≤12: camera start is gated behind the "Tap to enable camera"
        // button so the permission prompt appears inside a user gesture.
        if (!cameraStarted && enableCamOverlay) {
          enableCamOverlay.classList.remove('hidden');
        } else if (cameraStarted) {
          // Reconnected after a permission-dialog drop or network blip: the
          // local stream is still alive, so re-publish it and re-offer to any
          // watchers. Reset publishedType so the source is actually re-sent.
          publishedType = null;
          publishCurrentSource();
          for (const subId of subscribers) offerToSubscriber(subId);
        }
      } else {
        // Modern iOS (13+): auto-start as before, no gesture required.
        startMedia();
        requestWakeLock();
      }
    });

    sig.on('close', (info) => {
      connectionDot.className = 'status-dot offline';
      const code = info && info.code;
      publishedType = null;
      if (debugMethod) debugMethod.textContent = 'method:' + (sig.useSSE ? 'SSE' : 'WS');
      logEvent((sig.useSSE ? 'sse:close' : 'ws:close') + (code != null ? ':' + code : ''));
    });

    sig.on('configUpdated', (data) => {
      applyConfig(data.config);
    });

    sig.on('subscriberJoined', (data) => {
      subscriberCount++;
      debugSubs.textContent = 'subs:' + subscriberCount;
      logEvent('subJoined:' + data.subscriberId.slice(-4));
      const peerId = data.subscriberId;
      subscribers.add(peerId);
      if (!rtc.localStream) {
        logEvent('NO-LOCALSTREAM');
        console.log('[kiosk] WARN: no localStream for', peerId, '- will offer once media starts');
        return;
      }
      offerToSubscriber(peerId);
    });

    sig.on('subscriberLeft', (data) => {
      subscriberCount = Math.max(0, subscriberCount - 1);
      debugSubs.textContent = 'subs:' + subscriberCount;
      console.log('[kiosk] subscriberLeft from', data.subscriberId, 'total:', subscriberCount);
      subscribers.delete(data.subscriberId);
      rtc.closePeerConnection(data.subscriberId);
    });

    // Modern iOS (13+): open the signaling socket on load, as before.
    // Legacy iOS (≤12): defer the connect until the user taps "enable camera"
    // — a user gesture. Opening a WebSocket on page load without a gesture is
    // unreliable on old WebKit and the connection closes instantly (ws:close).
    if (!isLegacyIOS()) {
      sig.connect();
    }
  }

  function applyConfig(config) {
    if (!config) return;

    // First-time: a freshly granted permission fills in device labels
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      reportCapabilities();
    }

    if (config.label) {
      sig.deviceLabel = config.label;
      localStorage.setItem('hearth_deviceLabel', config.label);
      deviceLabel.textContent = config.label;
    }

    // Merge only defined keys so a partial update (e.g. from the base
    // station) doesn't clobber locally-known settings, then persist.
    const defined = {};
    for (const k of Object.keys(config)) {
      if (config[k] !== undefined) defined[k] = config[k];
    }
    const prevVideoDevice = currentConfig.videoDevice;
    const prevAudioDevice = currentConfig.audioDevice;
    const changed =
      defined.resolution !== undefined && defined.resolution !== currentConfig.resolution ||
      defined.frameRate !== undefined && defined.frameRate !== currentConfig.frameRate ||
      defined.camera !== undefined && defined.camera !== currentConfig.camera ||
      defined.videoDevice !== undefined && defined.videoDevice !== prevVideoDevice ||
      defined.audioDevice !== undefined && defined.audioDevice !== prevAudioDevice;

    currentConfig = Object.assign({}, currentConfig, defined);
    saveSettings(currentConfig);

    if (changed && rtc.localStream) {
      console.log('[kiosk] media config changed, restarting:', currentConfig);
      restartMediaWithConfig();
    }
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }

  // iOS requires a user gesture before the camera permission prompt can appear.
  // This is invoked from the on-screen button so getUserMedia runs in a gesture.
  function enableCamera() {
    cameraStarted = true;
    if (enableCamOverlay) enableCamOverlay.classList.add('hidden');
    requestWakeLock();
    // getUserMedia MUST run inside this user gesture (the tap) or iOS 12 blocks
    // the prompt. iOS 12 also terminates the WebSocket while the native
    // permission dialog pauses the WebView, so (re)establish the socket only
    // AFTER the dialog is dismissed (startMedia's promise settles).
    startMedia().finally(() => {
      // The native permission dialog may pause the WebView and drop the
      // signaling connection on old WebKit (iOS ≤12). If it did, reconnect —
      // the 'welcome' handler will re-publish the still-live local stream.
      // If the connection survived, just (re)publish on it.
      if (!sig.connected) {
        sig.connect();
      } else {
        publishCurrentSource();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
