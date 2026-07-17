(function () {
  'use strict';

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  // ─── localStorage keys (renamed from "kiosk" → "monitor") ──────────
  // Migrate any previous "kiosk" keys so existing devices keep their id/label/settings.
  function migrateKey(oldKey, newKey) {
    try {
      const v = localStorage.getItem(oldKey);
      if (v !== null && localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, v);
        localStorage.removeItem(oldKey);
      }
    } catch {}
  }
  migrateKey('hearth_kioskDeviceId', 'hearth_monitorDeviceId');
  migrateKey('hearth_kioskSettings', 'hearth_monitorSettings');
  migrateKey('hearth_deviceLabel', 'hearth_monitorLabel');
  let deviceId = localStorage.getItem('hearth_monitorDeviceId');
  let cameraSourceId = null;
  let publishedType = null;
  let subscriberCount = 0;
  const subscribers = new Set();
  let wakeLock = null;
  let cameraStarted = false;

  // Broadcast state
  let broadcastPeerId = null;  // Base station ID we're receiving broadcast from
  let broadcastStream = null;  // Remote stream from base broadcast
  let broadcastAudioActive = false; // base is sending a "Broadcast Message" announcement
  let baseVideoActive = false; // Base is pushing its camera to us (FaceTalk/broadcast)

  // ─── Persistent device settings (localStorage) ──────────
  // Each kiosk remembers the last settings it had, restored on load even
  // before the server connection is established. Base-station changes that
  // arrive over signaling are merged in and re-saved here.
  const SETTINGS_KEY = 'hearth_monitorSettings';

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
      displayMode: 'blank',
      audioMode: 'mute',
      broadcastDisabled: false,
      audioAlertEnabled: true,
      audioAlertThresholdDb: -40,
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
  const remoteAudio = document.getElementById('remoteAudio');
  const ftDebug = document.getElementById('ftDebug');

  // Debug readout for the base station → monitor audio/video (FaceTalk/broadcast)
  // link, shown at the top of the video area. Tracks the signaling transport
  // plus the incoming broadcast RTCPeerConnection + received track state.
  const ftDbgState = {
    wsMethod: '--',
    wsUp: false,
    base: null,       // base station deviceId sending us the broadcast
    display: '--',    // current display mode
    audio: '--',      // current audio mode
    pc: '--',         // broadcast PC connection state
    ice: '--',        // broadcast PC ICE state
    tracks: '--',     // tracks received on the broadcast stream
  };
  function renderFtDebug() {
    if (!ftDebug) return;
    const d = ftDbgState;
    ftDebug.textContent =
      'ft:' + (d.base ? 'RX←' + d.base.slice(-4) : 'idle') +
      '  ws:' + d.wsMethod + (d.wsUp ? '↑' : '↓') +
      '  disp:' + d.display + '/' + d.audio +
      '  pc:' + d.pc + '  ice:' + d.ice +
      '  tracks:' + d.tracks;
  }

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
    // Always enable echo cancellation / noise suppression / auto-gain. Without
    // echoCancellation the kiosk's mic re-captures audio played out its own
    // speaker (base talkback / FaceTalk), creating a delayed echo loop back to
    // the base. These are the WebRTC defaults but must be set explicitly.
    const proc = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (config && config.audioDevice) {
      return { audio: { deviceId: { exact: config.audioDevice }, ...proc } };
    }
    return { audio: proc };
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
      sig.publishSource(cameraSourceId, sig.deviceLabel || 'Monitor', type);
      publishedType = type;
    }
  }

  // ─── Broadcast & Display Config ──────────────────────────

  function subscribeToBroadcast(baseId) {
    if (broadcastPeerId === baseId) return; // Already subscribed
    broadcastPeerId = baseId;
    sig.subscribeBroadcast(baseId);
    console.log('[kiosk] subscribed to broadcast from', baseId);
  }

  function unsubscribeFromBroadcast() {
    if (broadcastPeerId) {
      sig.unsubscribeBroadcast(broadcastPeerId);
      // Broadcast PCs live in a separate map (broadcastPcs) and MUST be closed
      // via closeBroadcastPeerConnection — closePeerConnection only touches the
      // monitor-PC map, so the stale broadcast PC used to linger and the NEXT
      // broadcast reused a dead connection ("worked once then stopped").
      rtc.closeBroadcastPeerConnection(broadcastPeerId);
      if (broadcastStream) {
        broadcastStream.getTracks().forEach(t => t.stop());
        broadcastStream = null;
      }
      // Only re-apply the display config if we had actually swapped the <video>
      // to the base's FaceTalk feed. An AUDIO-ONLY announcement never touches
      // the video element, so re-applying here would blank a live camera
      // preview (displayMode 'blank' → srcObject=null) that the announcement
      // never disturbed.
      const wasShowingBaseVideo = baseVideoActive;
      baseVideoActive = false;
      broadcastAudioActive = false;
      broadcastPeerId = null;
      if (wasShowingBaseVideo) {
        applyDisplayConfig(currentConfig.displayMode || 'self', currentConfig.audioMode || 'mute');
      }
      ftDbgState.base = null;
      ftDbgState.pc = '--';
      ftDbgState.ice = '--';
      ftDbgState.tracks = '--';
      renderFtDebug();
    }
  }

  function applyDisplayConfig(displayMode, audioMode) {
    console.log('[kiosk] applyDisplayConfig:', displayMode, audioMode);
    
    const video = document.getElementById('cameraFeed');
    if (!video) return;

    switch (displayMode) {
      case 'self':
        // While the base is pushing its camera (FaceTalk/broadcast), that
        // overrides the device's display setting — keep showing the base feed.
        if (baseVideoActive && broadcastStream) {
          video.srcObject = broadcastStream;
          video.muted = true;
          video.play().catch(() => {});
          break;
        }
        // Show local camera (muted)
        if (rtc.localStream) {
          video.srcObject = rtc.localStream;
          video.muted = true; // No self-audio
          video.play().catch(() => {});
        }
        break;
      case 'blank':
        // FaceTalk video wins over "blank" — while the base is pushing its
        // camera (FaceTalk/broadcast) we always show it, regardless of the
        // device's display setting.
        if (baseVideoActive && broadcastStream) {
          video.srcObject = broadcastStream;
          video.muted = true;
          video.play().catch(() => {});
          break;
        }
        // Truly blank the screen. "blank" is an explicit owner choice (e.g.
        // privacy: don't mirror the room on the wall panel) and is distinct
        // from "self", which shows the local preview. The monitor keeps
        // publishing its camera/mic — only the on-device preview is hidden.
        video.srcObject = null;
        break;
      case 'base':
        // Show base station's broadcast stream. Keep the <video> element muted —
        // the base's audio track is routed through the separate <audio> element
        // (remoteAudio) in onRemoteTrack, so unmuting here would double-play it.
        if (broadcastStream) {
          video.srcObject = broadcastStream;
          video.muted = true;
          video.play().catch(() => {});
        }
        break;
    }

    // Handle audio mode
    // Note: Audio is handled via the video element's audio tracks
    // 'self' = no audio (muted), 'mute' = no audio, 'base' = base audio
    if (audioMode === 'base' && broadcastStream) {
      // Audio will play through video element
      video.muted = false;
    } else {
      video.muted = true;
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
    const isAbove = db > threshold;

    // Always report the live level (~0.5Hz) so the base station's dB meter keeps
    // updating with the room sound without flooding signaling. The alert
    // HIGHLIGHT (peak) is gated on the kiosk's audioAlertEnabled setting —
    // disabling alerts must not freeze the meter (the previous behaviour left
    // the base stuck on the last reading).
    if (audioMeterTickCount % 8 === 0) {
      sig.send('AUDIO_PEAK', { deviceId: sig.deviceId, levelDb: db, peak: alertEnabled && isAbove, ts: Date.now() });
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

      // Enforce the configured display mode now that the local stream exists.
      // startMedia() attaches the local preview above, but a 'blank' display
      // mode must win and clear the <video> (and 'base' shows the broadcast
      // stream if one is already live). Without this, the on-device preview
      // always shows the local camera after every (re)start, so the
      // self/blank toggle never sticks. FaceTalk overrides are still honoured
      // because applyDisplayConfig checks baseVideoActive first.
      applyDisplayConfig(currentConfig.displayMode || 'self', currentConfig.audioMode || 'mute');

      publishCurrentSource();
      setupAudioAnalyser();

      rtc.onConnectionStateChange = (peerId, state) => {
        console.log('[kiosk] peer', peerId, 'state:', state);
        if (peerId.startsWith('broadcast-')) { ftDbgState.pc = state; renderFtDebug(); }
      };
      rtc.onIceConnectionStateChange = (peerId, state) => {
        console.log('[kiosk] peer', peerId, 'ice:', state);
        if (peerId.startsWith('broadcast-')) { ftDbgState.ice = state; renderFtDebug(); }
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
    localStorage.setItem('hearth_monitorDeviceId', deviceId);
    sig.deviceId = deviceId;
    sig.deviceType = 'kiosk';
    sig.deviceLabel = localStorage.getItem('hearth_monitorLabel') || 'Monitor';

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

    // Re-acquire keep-awake when returning to the foreground: the native Wake
    // Lock is auto-released on background, and the fallback video is paused by
    // iOS — so re-request whenever the page becomes visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && currentConfig.keepAwake) {
        requestWakeLock();
      }
    });

    sig.on('open', () => {
      connectionDot.className = 'status-dot reconnecting';
      if (debugMethod) debugMethod.textContent = 'method:' + (sig.useSSE ? 'SSE' : 'WS');
      logEvent(sig.useSSE ? 'sse:open' : 'ws:open');
      sig.joinRoom('default', deviceId);
      ftDbgState.wsMethod = sig.useSSE ? 'SSE' : 'WS';
      ftDbgState.wsUp = true;
      renderFtDebug();
    });

    sig.on('welcome', async (data) => {
      deviceId = data.deviceId;
      localStorage.setItem('hearth_monitorDeviceId', deviceId);
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
      ftDbgState.wsUp = false;
      renderFtDebug();
    });

    // ─── Remote (talkback / broadcast / announcement) audio + video ─────
    // The base station sends its own audio/video to us over a broadcast PC (or,
    // during a two-way call, the same monitor PC). We must attach those tracks
    // to playable elements — without this the base's voice/announcement never
    // reaches the kiosk speaker.
    let talkbackActive = false;       // base is actively talking to us
    let callActive = false;           // we are in a call with the base
    // baseVideoActive is module-scoped (see top) so applyDisplayConfig and
    // unsubscribeFromBroadcast — defined outside init() — can read it too.

    function applyRemoteAudio() {
      if (!remoteAudio) return;
      // Speaker volume from config (0..1). Applied live to the element.
      const vol = (currentConfig.speakerVolume != null) ? currentConfig.speakerVolume : 0.5;
      remoteAudio.volume = Math.max(0, Math.min(1, vol));
      // Play base audio only when it is allowed by the display/audio mode and
      // we are either in a call or the base has enabled talkback, OR the base
      // is broadcasting a "Broadcast Message" announcement (which overrides
      // the kiosk's mute so the announcement is always heard).
      const audioMode = currentConfig.audioMode || 'mute';
      const allowed = audioMode === 'base' || talkbackActive || callActive || broadcastAudioActive;
      remoteAudio.muted = !allowed;
      if (allowed) {
        remoteAudio.play().catch(() => {});
      }
    }

    rtc.onRemoteTrack = (peerId, stream, track) => {
      console.log('[kiosk] onRemoteTrack', peerId, track.kind);
      if (peerId.startsWith('broadcast-') || peerId === broadcastPeerId) {
        // Remember the base's broadcast stream so applyDisplayConfig('base')
        // can render it even if the display mode was switched after the
        // track arrived (otherwise the video silently never shows).
        broadcastStream = stream;
        // Reflect the base sender + received tracks in the debug readout.
        ftDbgState.base = peerId.replace(/^broadcast-/, '');
        ftDbgState.tracks = stream.getVideoTracks().length + 'v ' +
          stream.getAudioTracks().length + 'a';
        renderFtDebug();
        if (track.kind === 'video') {
          // While the base is pushing its camera (FaceTalk/broadcast), show it
          // unconditionally — this overrides the device's display-mode setting
          // so the monitor always reflects the base feed during FaceTalk.
          baseVideoActive = true;
          if (!callActive) {
            video.srcObject = stream;
            video.muted = true;
            video.play().catch(() => {});
          }
        } else if (track.kind === 'audio') {
          // A broadcast audio track = a "Broadcast Message" announcement. Mark
          // it active so applyRemoteAudio() overrides the kiosk's mute and the
          // announcement is actually heard (this is what made plain broadcasts
          // silently fail before — the kiosk stayed muted).
          broadcastAudioActive = true;
          remoteAudio.srcObject = stream;
          applyRemoteAudio();
        }
      } else {
        // Monitor PC: base→kiosk reverse audio during a call / talkback.
        if (track.kind === 'audio') {
          remoteAudio.srcObject = stream;
          applyRemoteAudio();
        }
      }
    };

    // Talkback: base tells us to enable (unmute) our speaker so we can hear it.
    sig.on('talkEnabled', (data) => {
      console.log('[kiosk] TALK_ENABLED from', data.from);
      talkbackActive = true;
      applyRemoteAudio();
    });
    sig.on('talkDisabled', (data) => {
      console.log('[kiosk] TALK_DISABLED from', data.from);
      talkbackActive = false;
      applyRemoteAudio();
    });

    // Call state relayed from the base (answer/hangup) — reflect it on screen.
    sig.on('callState', (data) => {
      console.log('[kiosk] CALL_STATE', data.state, 'from', data.from);
      if (data.state === 'connected') {
        callActive = true;
        applyRemoteAudio();
        showToast('Call connected');
      } else if (data.state === 'ended') {
        callActive = false;
        applyRemoteAudio();
        showToast('Call ended');
      }
    });

    function showToast(msg, ms = 3000) {
      // Lightweight toast reused from base — define locally for kiosk.
      const el = document.getElementById('kioskToast');
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), ms);
    }

    // NOTE: The doorbell button was removed from the monitor page. The DOORBELL
    // signaling message is still relayed by the server (SignalingHandler.handleDoorbell)
    // and is kept as a reusable building block for a future chime/announce feature.

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

    // Handle display/audio config from base station
    sig.on('setDisplayConfig', (data) => {
      console.log('[kiosk] setDisplayConfig:', data);
      applyDisplayConfig(data.displayMode, data.audioMode);
      // Re-apply speaker volume / audio-mode gating to any live remote audio.
      if (typeof applyRemoteAudio === 'function') applyRemoteAudio();
      ftDbgState.display = data.displayMode;
      ftDbgState.audio = data.audioMode;
      renderFtDebug();
    });

    // Handle broadcast subscriber joined (kiosk receiving base's broadcast)
    sig.on('subscriberJoined', (data) => {
      if (data.isBroadcast) {
        // Base station is sending its broadcast to us
        console.log('[kiosk] broadcast subscriberJoined from', data.subscriberId);
        broadcastPeerId = data.subscriberId;
        // Create a recv broadcast peer connection to receive base's broadcast.
        // (handleOffer will reuse this same PC when the offer arrives.)
        rtc.createBroadcastPeerConnection(broadcastPeerId, true);
        ftDbgState.base = broadcastPeerId;
        ftDbgState.pc = 'new';
        renderFtDebug();
      } else {
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
      }
    });

    // Handle source added - auto-subscribe to broadcasts, unless this kiosk
    // has system broadcasts disabled (set remotely by the base, or locally),
    // or the broadcast is targeted at a different device.
    sig.on('sourceAdded', (source) => {
      if (source.isBroadcast && source.publisherId !== deviceId) {
        if (source.targetDeviceId && source.targetDeviceId !== deviceId) {
          console.log('[kiosk] broadcast targeted elsewhere (' + source.targetDeviceId + ') — ignoring');
          return;
        }
        if (currentConfig.broadcastDisabled) {
          console.log('[kiosk] broadcasts disabled — ignoring broadcast source', source.id);
          return;
        }
        console.log('[kiosk] broadcast source added:', source.id, 'from', source.publisherId);
        subscribeToBroadcast(source.publisherId);
      }
    });

    // Handle source removed - if it was our broadcast source, tear it down.
    sig.on('sourceRemoved', (data) => {
      if (broadcastPeerId && data.sourceId) {
        console.log('[kiosk] broadcast source removed:', data.sourceId, '- unsubscribing');
        unsubscribeFromBroadcast();
      }
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
      localStorage.setItem('hearth_monitorLabel', config.label);
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

    // Re-apply keep-awake if the base toggled it (acquire or release live).
    if (defined.keepAwake !== undefined) {
      if (defined.keepAwake) requestWakeLock();
      else releaseWakeLock();
    }

    // If the display/audio mode changed via a full config update (not just the
    // dedicated SET_DISPLAY_CONFIG message), re-apply it so the on-device
    // preview respects self/blank/base even if the targeted message was missed.
    if ((defined.displayMode !== undefined || defined.audioMode !== undefined) && rtc.localStream) {
      applyDisplayConfig(currentConfig.displayMode || 'self', currentConfig.audioMode || 'mute');
    }

    if (changed && rtc.localStream) {
      console.log('[kiosk] media config changed, restarting:', currentConfig);
      restartMediaWithConfig();
    }
  }

  // Build a tiny silent WAV as a Blob URL. iOS only suppresses auto-lock while
  // media is genuinely *playing* (a muted video does not count), so we feed a
  // short inaudible clip to an <audio> element and loop it. 8-bit PCM at 8 kHz
  // keeps the blob tiny (~1 KB/s).
  function makeSilentWavUrl(seconds = 1, sampleRate = 8000) {
    const numSamples = seconds * sampleRate;
    const buffer = new ArrayBuffer(44 + numSamples);
    const view = new DataView(buffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true); // byte rate (mono, 8-bit)
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, numSamples, true);
    for (let i = 44; i < 44 + numSamples; i++) view.setUint8(i, 128); // silence
    return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  }

  // Keep-awake: prefer the Wake Lock API (iOS 16.4+). On older iOS (e.g. 15.x)
  // it's absent, so fall back to playing a tiny silent looping audio track —
  // media playback keeps the screen alive in the foreground. Bonus: the open
  // (non-muted) media session also survives a screen lock on iOS, so the
  // WebRTC audio track keeps flowing as an audio-only source while locked
  // (the camera stops, but mic audio continues). Gated on keepAwake.
  async function requestWakeLock() {
    if (!currentConfig.keepAwake) { releaseWakeLock(); return; }
    // 1. Native Wake Lock API (modern iOS/Chrome).
    if ('wakeLock' in navigator) {
      try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener?.('release', () => { wakeLock = null; });
        return;
      } catch { /* fall through to the audio fallback */ }
    }
    // 2. Fallback: silent looping audio (iOS < 16.4). Must NOT be muted — iOS
    //    ignores muted media for the purposes of suppressing auto-lock.
    const nsa = document.getElementById('noSleepAudio');
    if (nsa) {
      try {
        if (!nsa.src) nsa.src = makeSilentWavUrl();
        await nsa.play();
      } catch { /* needs a user gesture on some versions */ }
    }
  }

  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
    const nsa = document.getElementById('noSleepAudio');
    if (nsa) { try { nsa.pause(); } catch {} }
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
