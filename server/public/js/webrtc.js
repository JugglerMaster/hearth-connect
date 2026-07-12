// WebRTC connection manager — P2P mesh, one RTCPeerConnection per peer pair.
//
// Renegotiation model: "perfect negotiation" (RFC 8623). Every PC is given an
// onnegotiationneeded handler that drives offer/answer. Because both sides may
// call addTrack() / removeTrack() (talkback, camera/mic toggles) at any time,
// we let the browser fire onnegotiationneeded and rely on the politeness
// distinction + a makingOffer / ignoreOffer handshake to resolve glare.
//
// The server is a pure relay: it forwards OFFER / ANSWER / ICE_CANDIDATE /
// ICE_RESTART / RENEGOTIATE messages between two deviceIds unchanged.

class WebRTCManager {
  constructor(sig) {
    this.sig = sig;
    this.localStream = null;
    // peerId → RTCPeerConnection (kiosk↔base monitoring, both directions)
    this.peerConnections = new Map();
    // kioskId → RTCPeerConnection (base→kiosk broadcast)
    this.broadcastPcs = new Map();
    // peerId → MediaStream of remote tracks
    this.remoteStreams = new Map();
    // peerId → Array<RTCIceCandidateInit> queued until remote description is set
    this.pendingCandidates = new Map();
    // peerId → { makingOffer, ignoreOffer, isPolite, connected }
    this.pcMeta = new Map();

    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
      ],
    };

    // Bind signaling events
    this.sig.on('offer', (data) => this.handleOffer(data));
    this.sig.on('answer', (data) => this.handleAnswer(data));
    this.sig.on('iceCandidate', (data) => this.handleIceCandidate(data));
    this.sig.on('iceRestart', (data) => this.handleIceRestartRequest(data));
    this.sig.on('renegotiate', (data) => this.handleRenegotiateRequest(data));
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

  getOrCreateMeta(peerId, isPolite) {
    let m = this.pcMeta.get(peerId);
    if (!m) {
      m = { makingOffer: false, ignoreOffer: false, isPolite: !!isPolite, connected: false };
      this.pcMeta.set(peerId, m);
    }
    return m;
  }

  createPeerConnection(peerId, direction = 'send', isPolite = false) {
    if (this.peerConnections.has(peerId)) {
      console.log('[webrtc] reusing existing pc for', peerId);
      return this.peerConnections.get(peerId);
    }

    const meta = this.getOrCreateMeta(peerId, isPolite);
    const pc = new RTCPeerConnection(this.iceServers);
    this.peerConnections.set(peerId, pc);
    this.pendingCandidates.set(peerId, []);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sig.sendIceCandidate(peerId, event.candidate.toJSON());
      } else {
        console.log('[webrtc] ICE gathering complete for', peerId);
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

    // Perfect-negotiation: the only driver of offer/answer flow.
    pc.onnegotiationneeded = async () => {
      try {
        meta.makingOffer = true;
        await pc.setLocalDescription();
        // Where setLocalDescription() is called with no arguments the browser
        // creates the appropriate offer or answer and signals it. On modern
        // browsers pc.setLocalDescription() (no args) both creates and applies.
        this.sig.sendOffer(peerId, pc.localDescription);
      } catch (err) {
        console.error('[webrtc] negotiationneeded failed for', peerId, err);
      } finally {
        meta.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onConnectionStateChange(peerId, state);
      meta.connected = (state === 'connected');
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
      // Avoid duplicate senders for the same track
      if (!pc.getSenders().some(s => s.track === track)) {
        pc.addTrack(track, this.localStream);
      }
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

  closePeerConnection(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      try { pc.close(); } catch {}
      this.peerConnections.delete(peerId);
    }
    this.remoteStreams.delete(peerId);
    this.pendingCandidates.delete(peerId);
    this.pcMeta.delete(peerId);
  }

  closeAll() {
    for (const peerId of Array.from(this.peerConnections.keys())) {
      this.closePeerConnection(peerId);
    }
  }

  // ─── Broadcast Peer Connections (Base → Kiosk) ───────────────────────────────

  createBroadcastPeerConnection(kioskId, isPolite = false) {
    if (this.broadcastPcs.has(kioskId)) {
      console.log('[webrtc] reusing existing broadcast pc for', kioskId);
      return this.broadcastPcs.get(kioskId);
    }

    const meta = this.getOrCreateMeta(`broadcast-${kioskId}`, isPolite);
    const pc = new RTCPeerConnection(this.iceServers);
    this.broadcastPcs.set(kioskId, pc);
    this.pendingCandidates.set(`broadcast-${kioskId}`, []);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sig.sendIceCandidate(kioskId, event.candidate.toJSON(), true);
      }
    };

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

    pc.onnegotiationneeded = async () => {
      try {
        meta.makingOffer = true;
        await pc.setLocalDescription();
        this.sig.sendOffer(kioskId, pc.localDescription, true);
      } catch (err) {
        console.error('[webrtc] broadcast negotiationneeded failed for', kioskId, err);
      } finally {
        meta.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onConnectionStateChange(`broadcast-${kioskId}`, state);
      if (state === 'failed') {
        console.warn(`Broadcast ICE failed for ${kioskId}, attempting restart...`);
        this.attemptBroadcastIceRestart(kioskId);
      }
    };

    if (this.localStream) {
      this.addTracksToPeer(pc);
    }

    return pc;
  }

  closeBroadcastPeerConnection(kioskId) {
    const pc = this.broadcastPcs.get(kioskId);
    if (pc) {
      try { pc.close(); } catch {}
      this.broadcastPcs.delete(kioskId);
    }
    this.remoteStreams.delete(`broadcast-${kioskId}`);
    this.pendingCandidates.delete(`broadcast-${kioskId}`);
    this.pcMeta.delete(`broadcast-${kioskId}`);
  }

  closeAllBroadcastPcs() {
    for (const kioskId of Array.from(this.broadcastPcs.keys())) {
      this.closeBroadcastPeerConnection(kioskId);
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
      // Retry the restart once if it does not recover within the lock window.
      setTimeout(() => {
        if (pc && pc.connectionState !== 'connected') {
          this.attemptBroadcastIceRestart(kioskId);
        }
        if (pc) pc._restarting = false;
      }, 10000);
    } catch (err) {
      console.error('Broadcast ICE restart failed:', err);
      this.closeBroadcastPeerConnection(kioskId);
      this.onPeerDisconnected(`broadcast-${kioskId}`);
    }
  }

  // ─── Offer / Answer (Standard, perfect negotiation) ──────────────────────────

  async createOffer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (!pc) {
      console.warn('[webrtc] createOffer: no pc for', peerId);
      return;
    }
    // Let onnegotiationneeded drive the offer. If it hasn't fired (e.g. tracks
    // already present), nudge it by forcing a renegotiation.
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
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
      const peerId = from;
      const meta = this.getOrCreateMeta(`broadcast-${peerId}`, false);
      // Reuse existing broadcast PC if present (renegotiation, not a new call).
      let pc = this.broadcastPcs.get(peerId);
      if (!pc) {
        // Create a recv-oriented broadcast PC (no local tracks). We are the
        // answerer here, so we are the polite peer (yield on collision).
        pc = this.createBroadcastPeerConnection(peerId, true);
      }
      try {
        const offerCollision = pc.signalingState !== 'stable' || meta.makingOffer;
        meta.ignoreOffer = !meta.isPolite && offerCollision;
        if (meta.ignoreOffer) {
          console.warn('[webrtc] ignoring colliding broadcast offer from', from);
          return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await this.flushCandidates(`broadcast-${peerId}`);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sig.sendAnswer(from, answer, true);
      } catch (err) {
        console.error('handleBroadcastOffer failed:', err);
      }
      return;
    }

    // Standard: base receiving offer from kiosk (or kiosk receiving re-offer)
    const meta = this.getOrCreateMeta(from, false);
    // IMPORTANT: do NOT tear down an existing live PC on renegotiation. Reuse it
    // so an already-flowing monitor feed is not interrupted when the remote side
    // adds talkback audio.
    let pc = this.peerConnections.get(from);
    const isRenegotiation = !!pc;
    if (!pc) {
      // We are the answerer of the initial monitor offer → polite peer.
      pc = this.createPeerConnection(from, 'recv', true);
    }

    try {
      const offerCollision = pc.signalingState !== 'stable' || meta.makingOffer;
      meta.ignoreOffer = !meta.isPolite && offerCollision;
      if (meta.ignoreOffer) {
        console.warn('[webrtc] ignoring colliding offer from', from);
        return;
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this.flushCandidates(from);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sig.sendAnswer(from, answer);
    } catch (err) {
      console.error('handleOffer failed:', err);
    }
  }

  async handleAnswer(data) {
    const { from, sdp, isBroadcast } = data;
    console.log('[webrtc] handleAnswer from', from, 'isBroadcast:', !!isBroadcast);
    // When both a monitor PC and a broadcast PC exist for the same peer (e.g.
    // during FaceTalk), disambiguate using the isBroadcast flag so the answer is
    // applied to the correct connection.
    let pc, meta;
    if (isBroadcast) {
      pc = this.broadcastPcs.get(from);
      meta = this.pcMeta.get(`broadcast-${from}`);
    } else {
      pc = this.peerConnections.get(from) || this.broadcastPcs.get(from);
      meta = this.pcMeta.get(from) || this.pcMeta.get(`broadcast-${from}`);
    }
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this.flushCandidates(isBroadcast ? `broadcast-${from}` : from);
      if (meta) meta.ignoreOffer = false;
    } catch (err) {
      console.error('handleAnswer failed:', err);
    }
  }

  async handleIceCandidate(data) {
    const { from, candidate, isBroadcast } = data;
    let pc, key;
    if (isBroadcast) {
      pc = this.broadcastPcs.get(from);
      key = `broadcast-${from}`;
    } else {
      pc = this.peerConnections.get(from) || this.broadcastPcs.get(from);
      key = this.peerConnections.has(from) ? from : `broadcast-${from}`;
    }
    if (!pc || !candidate) return;

    // Queue candidates until remote description exists. setRemoteDescription /
    // setLocalDescription must be applied first or addIceCandidate throws.
    if (!pc.remoteDescription) {
      this.queueCandidate(key, candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('addIceCandidate failed:', err);
    }
  }

  queueCandidate(key, candidate) {
    let q = this.pendingCandidates.get(key);
    if (!q) { q = []; this.pendingCandidates.set(key, q); }
    q.push(candidate);
    console.log('[webrtc] queued ICE candidate for', key, '(remote description not ready)');
  }

  async flushCandidates(key) {
    const q = this.pendingCandidates.get(key);
    if (!q || q.length === 0) return;
    const pc = this.peerConnections.get(key) || this.broadcastPcs.get(key.replace(/^broadcast-/, ''));
    if (!pc || !pc.remoteDescription) return;
    console.log('[webrtc] flushing', q.length, 'queued ICE candidates for', key);
    const pending = q.splice(0, q.length);
    for (const c of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (err) {
        console.error('flush addIceCandidate failed:', err);
      }
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
        // Retry once if not recovered; clear lock regardless so it can fire again.
        if (pc && pc.connectionState !== 'connected') {
          this.attemptIceRestart(peerId);
        }
        if (pc) pc._restarting = false;
      }, 10000);
    } catch (err) {
      console.error('ICE restart failed:', err);
      this.closePeerConnection(peerId);
      this.onPeerDisconnected(peerId);
    }
  }

  // Remote peer detected ICE failure and asked us to restart.
  async handleIceRestartRequest(data) {
    const { from } = data;
    console.log('[webrtc] remote requested ICE restart from', from);
    await this.attemptIceRestart(from);
  }

  // Remote side changed its media set and asks us to renegotiate (mirror of
  // onnegotiationneeded on the other end). We trigger our own negotiation so
  // both sides converge.
  async handleRenegotiateRequest(data) {
    const { from } = data;
    const pc = this.peerConnections.get(from) || this.broadcastPcs.get(from);
    if (!pc) return;
    console.log('[webrtc] remote requested renegotiation from', from);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sig.sendOffer(from, offer);
    } catch (err) {
      console.error('renegotiate failed:', err);
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

  // ─── Talkback (full-duplex reverse audio) ─────────────
  // enableTalkback() acquires the mic and adds it as a track. onnegotiationneeded
  // then fires and renegotiates the existing PC so the audio actually flows.
  // This fixes the previous bug where addTrack() was called with no negotiation
  // handler, so the track was never offered.

  async enableTalkback(targetPeerId, audioStream) {
    try {
      const stream = audioStream || await this.startMic();
      this.additionalAudioStream = stream;

      let pc = this.peerConnections.get(targetPeerId);
      if (!pc) {
        // No connection yet — create one (recv-oriented, will be offered when
        // the remote side subscribes). Most callers will already have a PC.
        pc = this.createPeerConnection(targetPeerId, 'recv', false);
      }

      let added = false;
      for (const track of stream.getAudioTracks()) {
        if (!pc.getSenders().some(s => s.track === track)) {
          pc.addTrack(track, stream);
          added = true;
        }
      }
      if (!added) {
        console.log('[webrtc] talkback track already present for', targetPeerId);
      }
      // addTrack() triggers onnegotiationneeded → renegotiation. Nothing else
      // to do; the SDP exchange happens automatically.
      return stream;
    } catch (err) {
      console.error('enableTalkback failed:', err);
      throw err;
    }
  }

  disableTalkback(targetPeerId) {
    if (this.additionalAudioStream) {
      const pc = this.peerConnections.get(targetPeerId);
      if (pc) {
        for (const track of this.additionalAudioStream.getAudioTracks()) {
          const sender = pc.getSenders().find(s => s.track === track);
          if (sender) {
            try { pc.removeTrack(sender); } catch (e) { console.error('removeTalkback failed', e); }
          }
        }
      }
      this.additionalAudioStream.getTracks().forEach(t => t.stop());
      this.additionalAudioStream = null;
      // removeTrack() triggers onnegotiationneeded → renegotiation to drop audio.
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

  // ─── Connection quality stats (getStats) ──────────────

  // Poll getStats() for the given peer and report a summary. Returns a cleanup
  // function. cb receives { bitrateKbps, packetsLost, jitter, rttMs, state }.
  startStats(peerId, cb, intervalMs = 2000) {
    const key = `stats-${peerId}`;
    if (this[key]) return () => {};
    const pc = this.peerConnections.get(peerId) || this.broadcastPcs.get(peerId);
    if (!pc) return () => {};
    let lastBytes = 0;
    let lastTs = 0;
    const timer = setInterval(async () => {
      const conn = this.peerConnections.get(peerId) || this.broadcastPcs.get(peerId);
      if (!conn) { clearInterval(timer); this[key] = null; return; }
      try {
        const stats = await conn.getStats();
        let inboundBytes = 0, packetsLost = 0, jitter = 0, rttMs = 0, candidate = null;
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            inboundBytes += r.bytesReceived || 0;
            packetsLost += r.packetsLost || 0;
            jitter = r.jitter || 0;
          }
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            packetsLost += r.packetsLost || 0;
            jitter = r.jitter || 0;
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
            rttMs = r.currentRoundTripTime ? r.currentRoundTripTime * 1000 : 0;
            candidate = r;
          }
          if (r.type === 'remote-inbound-rtp') {
            rttMs = r.roundTripTime ? r.roundTripTime * 1000 : rttMs;
          }
        });
        const now = Date.now();
        let bitrateKbps = 0;
        if (lastTs) {
          const dt = (now - lastTs) / 1000;
          bitrateKbps = dt > 0 ? Math.round(((inboundBytes - lastBytes) * 8) / 1000 / dt) : 0;
        }
        lastBytes = inboundBytes;
        lastTs = now;
        cb({
          bitrateKbps,
          packetsLost,
          jitterMs: Math.round((jitter || 0) * 1000),
          rttMs: Math.round(rttMs),
          state: conn.connectionState,
          iceState: conn.iceConnectionState,
        });
      } catch (err) {
        console.error('[webrtc] getStats failed for', peerId, err);
      }
    }, intervalMs);
    this[key] = timer;
    return () => { clearInterval(timer); this[key] = null; };
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
