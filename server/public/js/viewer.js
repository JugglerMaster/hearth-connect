(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────

  const sig = new SignalingClient();
  const rtc = new WebRTCManager(sig);
  let deviceId = localStorage.getItem('hearth_deviceId');
  let roomId = localStorage.getItem('hearth_roomId');
  let sources = [];
  let focusedSourceId = null;
  let talkActive = false;
  let muted = false;

  // ─── DOM refs ────────────────────────────────────────

  const $ = id => document.getElementById(id);
  const setupScreen = $('viewerSetupScreen');
  const viewerScreen = $('viewerScreen');
  const roomInput = $('viewerRoomInput');
  const joinBtn = $('viewerJoinBtn');
  const joinError = $('viewerJoinError');
  const roomLabel = $('viewerRoomLabel');
  const connectionDot = $('viewerConnectionDot');
  const remoteVideo = $('remoteVideo');
  const noSourceOverlay = $('noSourceOverlay');
  const sourceList = $('sourceList');
  const talkBtn = $('talkBtn');
  const muteBtn = $('muteBtn');
  const fullscreenBtn = $('fullscreenBtn');
  const connectionStatus = $('viewerConnectionStatus');
  const audioStatus = $('viewerAudioStatus');

  // ─── Init ────────────────────────────────────────────

  function init() {
    deviceId = localStorage.getItem('hearth_deviceId');
    roomId = localStorage.getItem('hearth_roomId');

    sig.deviceId = deviceId;
    sig.deviceType = 'viewer';
    sig.deviceLabel = 'Viewer';

    if (roomId) {
      sig.roomId = roomId;
      sig.connect();
      showViewerScreen();
    } else {
      showSetupScreen();
    }

    // ─── Signaling events ────────────────────────────

    sig.on('open', () => {
      connectionDot.className = 'status-dot reconnecting';
      connectionStatus.textContent = 'Connecting...';
      if (roomId) {
        sig.joinRoom(roomId, deviceId);
      }
    });

    sig.on('welcome', (data) => {
      roomId = data.roomId;
      localStorage.setItem('hearth_roomId', roomId);
      localStorage.setItem('hearth_deviceId', data.deviceId);
      deviceId = data.deviceId;
      roomLabel.textContent = roomId;
      connectionDot.className = 'status-dot online';
      connectionStatus.textContent = 'Connected';

      sources = data.sources || [];
      renderSourceList();

      // Auto-subscribe to first source
      if (sources.length > 0) {
        focusSource(sources[0].publisherId);
      }

      showViewerScreen();
    });

    sig.on('close', () => {
      connectionDot.className = 'status-dot offline';
      connectionStatus.textContent = 'Disconnected';
    });

    sig.on('sourceAdded', (source) => {
      sources.push(source);
      renderSourceList();
      if (!focusedSourceId) {
        focusSource(source.publisherId);
      }
    });

    sig.on('sourceRemoved', (data) => {
      sources = sources.filter(s => s.id !== data.sourceId);
      renderSourceList();
      if (focusedSourceId === data.sourceId) {
        focusedSourceId = null;
        noSourceOverlay.classList.remove('hidden');
        remoteVideo.srcObject = null;
        if (sources.length > 0) {
          focusSource(sources[0].publisherId);
        }
      }
    });

    sig.on('offer', async (data) => {
      await rtc.handleOffer(data);
    });

    sig.on('answer', async (data) => {
      await rtc.handleAnswer(data);
    });

    sig.on('iceCandidate', (data) => {
      rtc.handleIceCandidate(data);
    });

    // ─── WebRTC callbacks ────────────────────────────

    rtc.onRemoteTrack = (peerId, stream, track) => {
      if (peerId === focusedSourceId) {
        if (!remoteVideo.srcObject || remoteVideo.srcObject !== stream) {
          remoteVideo.srcObject = stream;
          noSourceOverlay.classList.add('hidden');
        }
      }
    };

    rtc.onConnectionStateChange = (peerId, state) => {
      if (peerId === focusedSourceId) {
        switch (state) {
          case 'connected':
            connectionStatus.textContent = 'Streaming';
            break;
          case 'connecting':
            connectionStatus.textContent = 'Connecting...';
            break;
          case 'failed':
            connectionStatus.textContent = 'Connection lost, reconnecting...';
            break;
          case 'disconnected':
            connectionStatus.textContent = 'Disconnected';
            break;
        }
      }
    };

    // ─── UI events ───────────────────────────────────

    joinBtn.addEventListener('click', handleJoin);
    roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleJoin();
    });

    talkBtn.addEventListener('mousedown', startTalk);
    talkBtn.addEventListener('mouseup', stopTalk);
    talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTalk(); });
    talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTalk(); });

    muteBtn.addEventListener('click', toggleMute);
    fullscreenBtn.addEventListener('click', toggleFullscreen);
  }

  // ─── Join Room ───────────────────────────────────────

  function handleJoin() {
    const room = roomInput.value.trim().toLowerCase().replace(/\s+/g, '-');
    if (!room) return;

    if (!deviceId) {
      deviceId = 'viewer-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      localStorage.setItem('hearth_deviceId', deviceId);
    }

    roomId = room;
    localStorage.setItem('hearth_roomId', room);
    sig.deviceId = deviceId;
    sig.roomId = room;

    if (!sig.connected) {
      sig.connect();
      sig.on('open', () => {
        sig.joinRoom(roomId, deviceId);
      });
    } else {
      sig.joinRoom(roomId, deviceId);
    }
  }

  // ─── Source Switching ────────────────────────────────

  function focusSource(publisherId) {
    if (!publisherId) return;
    focusedSourceId = publisherId;

    // Subscribe to this publisher
    sig.subscribeSource(publisherId);

    // Create peer connection for receiving
    // The publisher will send us an offer when they see our subscription
    rtc.createPeerConnection(publisherId, 'recv');

    renderSourceList();
    connectionStatus.textContent = 'Subscribing...';
  }

  function renderSourceList() {
    sourceList.innerHTML = sources.map(source => `
      <div class="source-chip ${source.publisherId === focusedSourceId ? 'active' : ''}"
           data-publisher-id="${source.publisherId}">
        ${source.label}
      </div>
    `).join('');

    sourceList.querySelectorAll('.source-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        focusSource(chip.dataset.publisherId);
      });
    });
  }

  // ─── Talkback ────────────────────────────────────────

  async function startTalk() {
    if (talkActive || !focusedSourceId) return;

    try {
      await rtc.enableTalkback(focusedSourceId);
      sig.requestTalk(focusedSourceId);
      talkActive = true;
      talkBtn.style.background = 'var(--danger)';
      audioStatus.textContent = 'Talkback active';
    } catch {
      audioStatus.textContent = 'Mic access denied';
    }
  }

  function stopTalk() {
    if (!talkActive) return;
    rtc.disableTalkback(focusedSourceId);
    sig.stopTalk(focusedSourceId);
    talkActive = false;
    talkBtn.style.background = '';
    audioStatus.textContent = '';
  }

  // ─── Mute ────────────────────────────────────────────

  function toggleMute() {
    muted = !muted;
    remoteVideo.muted = muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
    audioStatus.textContent = muted ? 'Muted' : '';
  }

  // ─── Fullscreen ──────────────────────────────────────

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.body.requestFullscreen();
    }
  }

  // ─── Screens ─────────────────────────────────────────

  function showSetupScreen() {
    setupScreen.classList.remove('hidden');
    viewerScreen.classList.add('hidden');
  }

  function showViewerScreen() {
    setupScreen.classList.add('hidden');
    viewerScreen.classList.remove('hidden');
  }

  // ─── Start ───────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', init);
})();
