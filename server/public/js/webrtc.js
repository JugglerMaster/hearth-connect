class WebRTCManager {
  constructor(signaling) {
    this.sig = signaling;
    this.localStream = null;
    this.peerConnections = new Map(); // peerId → RTCPeerConnection
    this.remoteStreams = new Map();   // peerId → MediaStream

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

  // ─── Peer Connections ────────────────────────────────

  createPeerConnection(peerId, direction = 'send') {
    // Close existing if any
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
    };

    // If we have a local stream, add tracks
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

  // ─── Offer / Answer ──────────────────────────────────

  async createOffer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) return;

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sig.sendOffer(peerId, offer);
    } catch (err) {
      console.error('createOffer failed:', err);
    }
  }

  async handleOffer(data) {
    const { from, sdp } = data;
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

  async handleAnswer(data) {
    const { from, sdp } = data;
    const pc = this.peerConnections.get(from);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.error('handleAnswer failed:', err);
    }
  }

  async handleIceCandidate(data) {
    const { from, candidate } = data;
    const pc = this.peerConnections.get(from);
    if (!pc || !candidate) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('addIceCandidate failed:', err);
    }
  }

  // ─── ICE Restart ─────────────────────────────────────

  async attemptIceRestart(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) return;

    // Only attempt restart once to avoid loops
    if (pc._restarting) return;
    pc._restarting = true;

    try {
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      this.sig.sendOffer(peerId, offer);

      // Reset restart flag after timeout
      setTimeout(() => {
        if (pc) pc._restarting = false;
      }, 10000);
    } catch (err) {
      console.error('ICE restart failed:', err);
      // Fall back to full reconnect
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
}
