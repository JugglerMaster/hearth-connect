class WebRTCManager {
  constructor(signaling) {
    this.sig = signaling;
    this.localStream = null;
    this.peerConnections = new Map(); // peerId → RTCPeerConnection
    this.remoteStreams = new Map();   // peerId → MediaStream

    // For base station broadcasting to multiple kiosks
    this.broadcastPcs = new Map();    // kioskId → RTCPeerConnection (base→kiosk)

    // ICE servers
    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    };

    // Bind signaling events
    this.sig.on('offer', (data) => this.handleOffer(data));
    this.sig.on('answer', (data) => this.handleAnswer(data));
    this.sig.on('iceCandidate', (data) => this.handleIceCandidate(data));
  }

  // ─── Local Media ─────────────────────────────────────

  async startCamera(constraints) {
    if (this.localStream) {
      this.stopCamera();
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      return this.localStream;
    } catch (err) {
      console.error('getUserMedia failed:', err);
      throw err;
    }
  }

  // Acquire video only (independent of audio) — used for degraded/graceful capture
  async startVideo(constraints) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error('getUserMedia (video) failed:', err);
      throw err;
    }
  }

  // Acquire audio only (independent of video)
  async startAudio(constraints) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error('getUserMedia (audio) failed:', err);
      throw err;
    }
  }

  stopCamera() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
  }

  async startMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return stream;
    } catch (err) {
      console.error('getUserMedia (mic) failed:', err);
      throw err;
    }
  }

  // ─── Peer Connections (Standard: kiosk↔base monitoring) ────────────────────────

  createPeerConnection(peerId, direction = 'send') {
    if (this.peerConnections.has(peerId)) {
      console.log('[webrtc] replacing existing pc for', peerId);
    }
    this.closePeerConnection(peerId);

    const pc = new RTCPeerConnection(this.iceServers);
    this.peerConnections.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sig.sendIceCandidate(peerId, event.candidate.toJSON());
      }
    };

    pc.ontrack = (event) => {
      let stream = this.remoteStreams.get(peerId);
      if (!stream) {
        stream = new MediaStream();
        this.remoteStreams.set(peerId, stream);
      }
      stream.addTrack(event.track);
      console.log('[webrtc] ontrack', peerId, 'track kind:', event.track.kind, 'stream tracks:', stream.getTracks().length);
      this.onRemoteTrack(peerId, stream, event.track);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onConnectionStateChange(peerId, state);

      if (state === 'failed') {
        console.warn(`ICE failed for ${peerId}, attempting restart...`);
        this.attemptIceRestart(peerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.onIceConnectionStateChange(peerId, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' && pc.connectionState === undefined) {
        console.warn('[webrtc] ICE failed for', peerId, '(iOS<13 path), attempting restart...');
        this.attemptIceRestart(peerId);
      }
    };

    if (this.localStream && direction === 'send') {
      this.addTracksToPeer(pc);
    }

    return pc;
  }

  addTracksToPeer(pc) {
    if (!this.localStream) return;
    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }
  }

  // Add/remove senders so the pc's tracks exactly match the current localStream.
  syncTracksToPeer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc || !this.localStream) return;
    const wanted = new Set(this.localStream.getTracks());
    for (const sender of pc.getSenders()) {
      if (sender.track && !wanted.has(sender.track)) {
        try { pc.removeTrack(sender); } catch (e) { console.error('removeTrack failed', e); }
      }
    }
    for (const track of wanted) {
      if (!pc.getSenders().some(s => s.track === track)) {
        pc.addTrack(track, this.localStream);
      }
    }
  }

  addAudioTrackToPeer(peerId, audioStream) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) return;

    for (const track of audioStream.getAudioTracks()) {
      pc.addTrack(track, audioStream);
    }
  }

  closePeerConnection(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }
    this.remoteStreams.delete(peerId);
  }

  closeAll() {
    for (const peerId of this.peerConnections.keys()) {
      this.closePeerConnection(peerId);
    }
  }

  // ─── Broadcast Peer Connections (Base → Kiosk) ───────────────────────────────

  createBroadcastPeerConnection(kioskId) {
    if (this.broadcastPcs.has(kioskId)) {
      console.log('[webrtc] replacing existing broadcast pc for', kioskId);
    }
    this.closeBroadcastPeerConnection(kioskId);

    const pc = new RTCPeerConnection(this.iceServers);
    this.broadcastPcs.set(kioskId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sig.sendIceCandidate(kioskId, event.candidate.toJSON());
      }
    };

    // Broadcast PCs are send-only from base perspective
    pc.ontrack = (event) => {
      // Base doesn't expect incoming tracks on broadcast PC, but handle just in case
      let stream = this.remoteStreams.get(`broadcast-${kioskId}`);
      if (!stream) {
        stream = new MediaStream();
        this.remoteStreams.set(`broadcast-${kioskId}`, stream);
      }
      stream.addTrack(event.track);
      console.log('[webrtc] broadcast ontrack', kioskId, event.track.kind);
      this.onRemoteTrack(`broadcast-${kioskId}`, stream, event.track);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onConnectionStateChange(`broadcast-${kioskId}`, state);
      if (state === 'failed') {
        console.warn(`Broadcast ICE failed for ${kioskId}, attempting restart...`);
        this.attemptBroadcastIceRestart(kioskId);
      }
    };

    // Add local stream tracks if available
    if (this.localStream) {
      this.addTracksToPeer(pc);
    }

    return pc;
  }

  closeBroadcastPeerConnection(kioskId) {
    const pc = this.broadcastPcs.get(kioskId);
    if (pc) {
      pc.close();
      this.broadcastPcs.delete(kioskId);
    }
    this.remoteStreams.delete(`broadcast-${kioskId}`);
  }

  closeAllBroadcastPcs() {
    for (const kioskId of this.broadcastPcs.keys()) {
      this.closeBroadcastPeerConnection(kioskId);
    }
  }

  async createBroadcastOffer(kioskId) {
    const pc = this.broadcastPcs.get(kioskId);
    if (!pc) {
      console.warn('[webrtc] createBroadcastOffer: no pc for', kioskId);
      return;
    }

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: false,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription(offer);
      console.log('[webrtc] createBroadcastOffer for', kioskId, 'sdp length:', offer.sdp ? offer.sdp.length : 0);
      this.sig.sendOffer(kioskId, offer);
    } catch (err) {
      console.error('[webrtc] createBroadcastOffer failed for', kioskId, err);
      throw err;
    }
  }

  async attemptBroadcastIceRestart(kioskId) {
    const pc = this.broadcastPcs.get(kioskId);
    if (!pc) return;
    if (pc._restarting) return;
    pc._restarting = true;

    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.sig.sendOffer(kioskId, offer);

      setTimeout(() => {
        if (pc) pc._restarting = false;
      }, 10000);
    } catch (err) {
      console.error('Broadcast ICE restart failed:', err);
      this.closeBroadcastPeerConnection(kioskId);
      this.onPeerDisconnected(`broadcast-${kioskId}`);
    }
  }

  // ─── Offer / Answer (Standard) ──────────────────────────────────

  async createOffer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) {
      console.warn('[webrtc] createOffer: no pc for', peerId);
      return;
    }

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(offer);
      console.log('[webrtc] createOffer for', peerId, 'sdp length:', offer.sdp ? offer.sdp.length : 0);
      this.sig.sendOffer(peerId, offer);
    } catch (err) {
      console.error('[webrtc] createOffer failed for', peerId, err);
      throw err;
    }
  }

  async handleOffer(data) {
    const { from, sdp, isBroadcast } = data;
    console.log('[webrtc] handleOffer from', from, 'isBroadcast:', isBroadcast, 'sdp length:', sdp && sdp.sdp ? sdp.sdp.length : 0);

    if (isBroadcast) {
      // Kiosk receiving broadcast offer from base
      const pc = this.createPeerConnection(from, 'recv');
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sig.sendAnswer(from, answer);
      } catch (err) {
        console.error('handleBroadcastOffer failed:', err);
      }
    } else {
      // Standard: base receiving offer from kiosk
      const pc = this.createPeerConnection(from, 'recv');
      if (this.additionalAudioStream) {
        this.addAudioTrackToPeer(from, this.additionalAudioStream);
      }

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sig.sendAnswer(from, answer);
      } catch (err) {
        console.error('handleOffer failed:', err);
      }
    }
  }

  async handleAnswer(data) {
    const { from, sdp } = data;
    console.log('[webrtc] handleAnswer from', from);
    // Check both standard and broadcast PCs
    let pc = this.peerConnections.get(from);
    if (!pc) {
      pc = this.broadcastPcs.get(from);
    }
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.error('handleAnswer failed:', err);
    }
  }

  async handleIceCandidate(data) {
    const { from, candidate } = data;
    // Check both standard and broadcast PCs
    let pc = this.peerConnections.get(from);
    if (!pc) {
      pc = this.broadcastPcs.get(from);
    }
    if (!pc || !candidate) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('addIceCandidate failed:', err);
    }
  }

  // ─── ICE Restart (Standard) ─────────────────────────────────────

  async attemptIceRestart(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) return;

    if (pc._restarting) return;
    pc._restarting = true;

    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.sig.sendOffer(peerId, offer);

      setTimeout(() => {
        if (pc) pc._restarting = false;
      }, 10000);
    } catch (err) {
      console.error('ICE restart failed:', err);
      this.closePeerConnection(peerId);
      this.onPeerDisconnected(peerId);
    }
  }

  // ─── Callbacks (override these) ──────────────────────

  onRemoteTrack(peerId, stream, track) {
    // Override in page-specific logic
  }

  onConnectionStateChange(peerId, state) {
    // Override in page-specific logic
  }

  onIceConnectionStateChange(peerId, state) {
    // Override in page-specific logic
  }

  onPeerDisconnected(peerId) {
    // Override in page-specific logic
  }

  // ─── Talkback ────────────────────────────────────────

  async enableTalkback(targetPeerId) {
    try {
      const audioStream = await this.startMic();
      this.additionalAudioStream = audioStream;

      const pc = this.peerConnections.get(targetPeerId);
      if (pc) {
        this.addAudioTrackToPeer(targetPeerId, audioStream);
      }
      return audioStream;
    } catch (err) {
      console.error('enableTalkback failed:', err);
      throw err;
    }
  }

  disableTalkback(targetPeerId) {
    if (this.additionalAudioStream) {
      this.additionalAudioStream.getTracks().forEach(t => t.stop());
      this.additionalAudioStream = null;
    }
  }

  toggleCamera(on) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => {
      t.enabled = on;
    });
  }

  toggleMic(on) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => {
      t.enabled = on;
    });
  }

  // ─── Helpers ────────────────────────────────────────

  getRemoteStream(peerId) {
    return this.remoteStreams.get(peerId);
  }

  getBroadcastStream(kioskId) {
    return this.remoteStreams.get(`broadcast-${kioskId}`);
  }

  hasPeerConnection(peerId) {
    return this.peerConnections.has(peerId);
  }

  hasBroadcastPeerConnection(kioskId) {
    return this.broadcastPcs.has(kioskId);
  }
}