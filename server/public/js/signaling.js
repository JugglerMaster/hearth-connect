// iOS ≤12 has an unreliable WebSocket stack (closes with code 1006 even over
// TLS 1.2 with compression disabled). For those clients we use Server-Sent
// Events (server→client) plus fetch POST (client→server) instead.
function isLegacyIOS() {
  const m = navigator.userAgent.match(/OS (\d+)_(\d+)_?(\d+)? like Mac OS X/);
  if (!m) return false;
  return parseInt(m[1], 10) < 13;
}

class SignalingClient {
  constructor(url) {
    this.url = url || this.getServerUrl();
    this.ws = null;
    this.es = null;
    this.connId = null;
    this.useSSE = isLegacyIOS();
    this.deviceId = null;
    this.roomId = null;
    this.connected = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.listeners = {};
    this.intentionalClose = false;

    // Reconnection backoff state
    this.backoffMin = 1000;
    this.backoffMax = 30000;
    this.backoffFactor = 2;

    // ─── Device authorization (hub pairing) ──────────────
    // The hub requires an AUTH message as the first frame on every socket.
    // The credential token is issued exactly once, when the owner taps Approve
    // on the hub, and lives in localStorage from then on (once-and-done).
    // `open` is only emitted after AUTH_OK, so every existing joinRoom() call
    // site keeps working unchanged.
    this.authToken = this._loadToken();
    this.authed = false;
    this.authState = 'new';      // new | pending | denied | authed
    this.authPending = null;     // { pendingId, code, expiresAt }
    this.outbox = [];            // sends queued until AUTH_OK
    this.authFallbackTimer = null;
    this.authOverlay = null;
  }

  getServerUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  // ─── Connection ──────────────────────────────────────

  genConnId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  connect() {
    if (this.useSSE) return this.connectSSE();

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.intentionalClose = false;

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error('WebSocket creation failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      console.log('Signaling: socket open, authenticating');
      this._sendAuth();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('Signaling: bad message', err);
      }
    };

    this.ws.onclose = (event) => {
      const wasAuthed = this.authed;
      this.connected = false;
      this.authed = false;
      this._clearAuthFallback();
      console.error('Signaling: disconnected', 'code=' + event.code, 'reason=' + (event.reason || ''), 'clean=' + event.wasClean);
      this.emit('close', { code: event.code, reason: event.reason });

      // Hub auth-gate close codes:
      //   4003 denied by the owner  -> stop retrying, show the overlay
      //   4004 unknown/revoked token -> drop the stored token, re-pair as new
      //   4008 pairing expired      -> retry (a fresh pending row appears)
      //   4009 sent a message before AUTH (should not happen with this client)
      if (event.code === 4004) {
        this._clearToken();
        console.log('Signaling: credential rejected, will re-pair');
      } else if (event.code === 4003) {
        this.authState = 'denied';
        this._showAuthOverlay('denied', { reason: event.reason || 'denied' });
        return;
      } else if (!wasAuthed && (event.code === 4008 || event.code === 4009)) {
        this.reconnectAttempt = 0; // pairing retries should not back off
      }

      if (!this.intentionalClose) {
        console.log('Signaling: disconnected, reconnecting...');
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('Signaling: error', err && (err.code || err.message) || err);
    };
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.connected = false;
  }

  // ─── SSE (legacy iOS ≤12) connection ────────────────
  // Downstream (server→client) uses EventSource; upstream (client→server)
  // uses fetch POST to /api/signal. EventSource's built-in reconnect is
  // disabled — we manage reconnection ourselves with backoff so a new
  // connId is issued each time (the server drops the old transport on close).

  connectSSE() {
    // Don't stack connections or reconnect timers.
    if (this.reconnectTimer) return;
    if (this.es && this.es.readyState !== EventSource.CLOSED) return;
    this.intentionalClose = false;

    this.connId = this.genConnId();

    try {
      this.es = new EventSource('/api/events?connId=' + encodeURIComponent(this.connId));
    } catch (err) {
      console.error('EventSource creation failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.es.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      console.log('Signaling (SSE): stream open connId=' + this.connId + ', authenticating');
      this._sendAuth();
    };

    this.es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('Signaling (SSE): bad message', err);
      }
    };

    this.es.onerror = () => {
      // EventSource auto-reconnects, but we close it and run our own backoff
      // so a fresh connId is issued. Treat as a disconnect.
      this.connected = false;
      if (this.es) { this.es.close(); this.es = null; }
      console.error('Signaling (SSE): stream error/closed connId=' + this.connId);
      this.emit('close', { code: null, reason: 'sse' });
      if (!this.intentionalClose) this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.intentionalClose || this.reconnectTimer) return;

    const delay = Math.min(
      this.backoffMin * Math.pow(this.backoffFactor, this.reconnectAttempt),
      this.backoffMax
    );

    this.reconnectAttempt++;
    console.log(`Signaling: reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ─── Message Handling ────────────────────────────────

  handleMessage(msg) {
    this.emit('message', msg);

    switch (msg.type) {
      // ─── Authorization (hub pairing) ───────────────────
      case 'AUTH_OK':
        this._setAuthed(msg.payload || {});
        break;

      case 'AUTH_REQUIRED':
        this.authState = 'pending';
        this.authPending = msg.payload || {};
        this._clearAuthFallback();
        this._showAuthOverlay('pending', this.authPending);
        this.emit('authRequired', this.authPending);
        break;

      case 'AUTH_DENIED':
        this.authState = 'denied';
        this._clearAuthFallback();
        this._showAuthOverlay('denied', msg.payload || {});
        this.emit('authDenied', msg.payload || {});
        break;

      case 'AUTH_STATE':
        this.emit('authState', msg.payload || {});
        break;

      case 'AUTH_PENDING':
        this.emit('authPending', msg.payload || {});
        break;

      case 'AUTH_PENDING_RESOLVED':
        this.emit('authPendingResolved', msg.payload || {});
        break;

      case 'WELCOME':
        this.deviceId = msg.payload.deviceId;
        this.roomId = msg.payload.roomId;
        this.emit('welcome', msg.payload);
        break;

      case 'ERROR':
        if (msg.payload && msg.payload.code === 'AUTH_INVALID') {
          // The hub no longer knows our credential (revoked, or hub data was
          // cleared). Drop it; the 4004 close handler reconnects to re-pair.
          this._clearToken();
        }
        console.error('Server error:', msg.payload);
        this.emit('error', msg.payload);
        break;

      case 'SOURCE_ADDED':
        this.emit('sourceAdded', msg.payload);
        break;

      case 'SOURCE_REMOVED':
        this.emit('sourceRemoved', msg.payload);
        break;

      case 'PLAY_CLIP':
        this.emit('playClip', msg.payload);
        break;

      case 'SUBSCRIBER_JOINED':
        this.emit('subscriberJoined', msg.payload);
        break;

      case 'SUBSCRIBER_LEFT':
        this.emit('subscriberLeft', msg.payload);
        break;

      case 'SESSION_KICKED':
        this.emit('sessionKicked', msg.payload);
        break;

      case 'OFFER':
        this.emit('offer', msg.payload);
        break;

      case 'ANSWER':
        this.emit('answer', msg.payload);
        break;

      case 'ICE_CANDIDATE':
        this.emit('iceCandidate', msg.payload);
        break;

      case 'RENEGOTIATE':
        this.emit('renegotiate', msg.payload);
        break;

      case 'ICE_RESTART':
        this.emit('iceRestart', msg.payload);
        break;

      case 'CONFIG_UPDATED':
        this.emit('configUpdated', msg.payload);
        break;

      case 'CONFIG_RESULT':
        this.emit('configResult', msg.payload);
        break;

      case 'DEVICE_STATUS':
        this.emit('deviceStatus', msg.payload);
        break;

      case 'SET_DISPLAY_CONFIG':
        this.emit('setDisplayConfig', msg.payload);
        break;

      case 'CAPABILITIES':
        this.emit('capabilities', msg.payload);
        break;

      case 'AUDIO_PEAK':
        this.emit('audioPeak', msg.payload);
        break;

      case 'DEVICE_REMOVED':
        this.emit('deviceRemoved', msg.payload);
        break;

      case 'DOORBELL':
        this.emit('doorbell', msg.payload);
        break;

      case 'CALL_STATE':
        this.emit('callState', msg.payload);
        break;

      case 'TALK_ENABLED':
        this.emit('talkEnabled', msg.payload);
        break;

      case 'TALK_DISABLED':
        this.emit('talkDisabled', msg.payload);
        break;

      case 'HEARTBEAT':
        break; // silently consumed

      case 'SETTINGS_RESULT':
        this.emit('settingsResult', msg.payload);
        break;

      case 'SETTINGS_UPDATED':
        this.emit('settingsUpdated', msg.payload);
        break;

      case 'HA_CONNECTED':
        this.emit('haConnected', msg.payload);
        break;

      case 'HA_ERROR':
        this.emit('haError', msg.payload);
        break;

      case 'HA_FRAME':
        this.emit('haFrame', msg.payload);
        break;

      case 'HA_DISCONNECTED':
        this.emit('haDisconnected', msg.payload);
        break;
    }
  }

  // ─── Send ────────────────────────────────────────────

  send(type, payload = {}) {
    // Everything except AUTH is held until the hub authorizes this socket.
    // The server closes pre-auth sockets, so queueing is not just a nicety.
    if (type !== 'AUTH' && !this.authed) {
      if (this.outbox.length < 100) this.outbox.push({ type, payload });
      return true;
    }
    return this._transmit(type, payload);
  }

  _transmit(type, payload = {}) {
    if (this.useSSE) {
      if (!this.connId || !this.connected) {
        console.warn('Signaling (SSE): cannot send, not connected');
        return false;
      }
      fetch('/api/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connId: this.connId, type, payload }),
      }).catch((err) => {
        console.error('Signaling (SSE): POST failed', err);
      });
      return true;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Signaling: cannot send, not connected');
      return false;
    }

    const msg = JSON.stringify({ type, payload });
    this.ws.send(msg);
    return true;
  }

  _flushOutbox() {
    if (!this.outbox.length) return;
    const queued = this.outbox.splice(0, this.outbox.length);
    for (const m of queued) this._transmit(m.type, m.payload);
  }

  // ─── Authorization (hub pairing) ─────────────────────

  _loadToken() {
    try { return localStorage.getItem('hearth_authToken') || null; } catch (e) { return null; }
  }

  _storeToken(token) {
    this.authToken = token;
    try { localStorage.setItem('hearth_authToken', token); } catch (e) {}
  }

  _clearToken() {
    this.authToken = null;
    try { localStorage.removeItem('hearth_authToken'); } catch (e) {}
  }

  _sendAuth() {
    const payload = { deviceType: this.deviceType, label: this.deviceLabel };
    if (this.deviceId) payload.deviceId = this.deviceId;
    if (this.authToken) payload.token = this.authToken;
    this._transmit('AUTH', payload);

    // A server from before this feature (e.g. the Node reference build without
    // parity) never answers AUTH. Fall back to the old behaviour instead of
    // hanging forever.
    if (this.authFallbackTimer) clearTimeout(this.authFallbackTimer);
    this.authFallbackTimer = setTimeout(() => {
      this.authFallbackTimer = null;
      if (!this.authed) {
        console.warn('Signaling: no AUTH reply in 4s — assuming pre-auth server');
        this._setAuthed({ credentialId: 'legacy-server' });
      }
    }, 4000);
  }

  _clearAuthFallback() {
    if (this.authFallbackTimer) {
      clearTimeout(this.authFallbackTimer);
      this.authFallbackTimer = null;
    }
  }

  _setAuthed(payload) {
    const wasAuthed = this.authed;
    this.authed = true;
    this.connected = true;
    this.authState = 'authed';
    this.authPending = null;
    this.reconnectAttempt = 0;
    this._clearAuthFallback();
    if (payload && payload.token) this._storeToken(payload.token);
    this._hideAuthOverlay();
    console.log('Signaling: authorized (' + ((payload && payload.credentialId) || 'unknown') + ')');
    if (!wasAuthed) {
      this.emit('authOk', payload || {});
      this._flushOutbox();
      this.emit('open');
    }
  }

  retryAuth() {
    this.authState = 'new';
    this.authPending = null;
    this._hideAuthOverlay();
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.intentionalClose = false;
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this.connect();
  }

  _showAuthOverlay(kind, data) {
    try {
      if (!this.authOverlay) {
        const el = document.createElement('div');
        el.id = 'authOverlay';
        el.className = 'auth-overlay';
        document.body.appendChild(el);
        this.authOverlay = el;
      }
      const el = this.authOverlay;
      el.classList.remove('hidden');
      if (kind === 'pending') {
        const code = data && data.code ? String(data.code) : '------';
        el.innerHTML =
          '<div class="auth-card">' +
            '<div class="auth-spinner"></div>' +
            '<div class="auth-title">Waiting for approval</div>' +
            '<div class="auth-body">Approve this device on the hub.<br>Code <b class="auth-code">' + code + '</b></div>' +
            '<div class="auth-hint">Open the hub &rarr; Access &rarr; pending device.</div>' +
          '</div>';
      } else {
        const reason = (data && data.reason) || 'denied';
        const expired = reason === 'expired';
        el.innerHTML =
          '<div class="auth-card">' +
            '<div class="auth-title">' + (expired ? 'Approval expired' : 'Access denied') + '</div>' +
            '<div class="auth-body">' + (expired ? 'Requesting a new pairing code&hellip;' : 'The hub did not approve this device.') + '</div>' +
            '<button type="button" class="btn btn-primary" id="authRetryBtn">Try again</button>' +
          '</div>';
        const btn = el.querySelector('#authRetryBtn');
        if (btn) btn.onclick = () => this.retryAuth();
      }
    } catch (e) {
      // No DOM (unit tests run this file in a vm with a stub document).
    }
  }

  _hideAuthOverlay() {
    if (this.authOverlay) this.authOverlay.classList.add('hidden');
  }

  // ─── API Methods ─────────────────────────────────────

  approveDevice(pendingId) {
    this.send('AUTH_DECISION', { pendingId, approve: true });
  }

  denyDevice(pendingId) {
    this.send('AUTH_DECISION', { pendingId, approve: false });
  }

  revokeCredential(credentialId) {
    this.send('REVOKE_CREDENTIAL', { credentialId });
  }

  getAuthState() {
    this.send('GET_AUTH_STATE', {});
  }

  setRequiresApproval(on) {
    this.setSettings('auth', { requiresApproval: !!on });
  }

  joinRoom(roomId, deviceId, config) {
    this.roomId = roomId;
    const payload = { roomId, deviceId, deviceType: this.deviceType, label: this.deviceLabel, legacyIOS: isLegacyIOS() };
    if (config) payload.config = config;
    this.send('JOIN_ROOM', payload);
  }

  leaveRoom() {
    this.send('LEAVE_ROOM');
    this.roomId = null;
  }

  pairDevice(token, deviceType, label) {
    this.deviceType = deviceType;
    this.deviceLabel = label;
    this.send('PAIR_DEVICE', { token, deviceType, label });
  }

  publishSource(sourceId, label, type) {
    this.send('PUBLISH_SOURCE', { sourceId, label, type });
  }

  unpublishSource(sourceId) {
    this.send('UNPUBLISH_SOURCE', { sourceId });
  }

  subscribeSource(publisherId) {
    this.send('SUBSCRIBE_SOURCE', { publisherId });
  }

  unsubscribeSource(publisherId) {
    this.send('UNSUBSCRIBE_SOURCE', { publisherId });
  }

  sendOffer(to, sdp, isBroadcast = false) {
    const payload = { to, sdp };
    if (isBroadcast) payload.isBroadcast = true;
    this.send('OFFER', payload);
  }

  sendAnswer(to, sdp, isBroadcast = false) {
    const payload = { to, sdp };
    if (isBroadcast) payload.isBroadcast = true;
    this.send('ANSWER', payload);
  }

  sendIceCandidate(to, candidate, isBroadcast = false) {
    const payload = { to, candidate };
    if (isBroadcast) payload.isBroadcast = true;
    this.send('ICE_CANDIDATE', payload);
  }

  requestIceRestart(to) {
    this.send('ICE_RESTART', { to });
  }

  requestRenegotiate(to) {
    this.send('RENEGOTIATE', { to });
  }

  setConfig(targetDeviceId, config) {
    this.send('SET_CONFIG', { targetDeviceId, config });
  }

  getConfig(targetDeviceId) {
    this.send('GET_CONFIG', targetDeviceId ? { targetDeviceId } : {});
  }

  requestTalk(targetPublisherId) {
    this.send('REQUEST_TALK', { targetPublisherId });
  }

  stopTalk(targetPublisherId) {
    this.send('STOP_TALK', { targetPublisherId });
  }

  // ─── Server settings (HA integration) ───────────────────

  getSettings() {
    this.send('GET_SETTINGS', {});
  }

  setSettings(section, value) {
    this.send('SET_SETTINGS', { section, value });
  }

  // ─── Home Assistant relay ───────────────────────────────

  haConnect() {
    this.send('HA_CONNECT', {});
  }

  haFrame(payload) {
    this.send('HA_FRAME', payload);
  }

  haDisconnect() {
    this.send('HA_DISCONNECTED', {});
  }

  ringDoorbell(label) {
    this.send('DOORBELL', { label: label || '' });
  }

  sendCallState(targetDeviceId, state) {
    this.send('CALL_STATE', { targetDeviceId, state });
  }

  removeDevice(targetDeviceId) {
    this.send('REMOVE_DEVICE', { targetDeviceId });
  }

  broadcastSource(sourceId, label, type, targetDeviceId) {
    this.send('BROADCAST_SOURCE', { sourceId, label, type, targetDeviceId });
  }

  unbroadcastSource(sourceId) {
    this.send('UNBROADCAST_SOURCE', { sourceId });
  }

  subscribeBroadcast(publisherId) {
    this.send('SUBSCRIBE_BROADCAST', { publisherId });
  }

  unsubscribeBroadcast(publisherId) {
    this.send('UNSUBSCRIBE_BROADCAST', { publisherId });
  }

  // Record-then-play announcement (plan 18). The WAV is uploaded to /api/clip
  // over HTTP first; this only tells the server which endpoints should play it.
  broadcastClip(clipId, targetDeviceId) {
    this.send('BROADCAST_CLIP', { clipId, targetDeviceId });
  }

  setDisplayConfig(targetDeviceId, displayMode) {
    this.send('SET_DISPLAY_CONFIG', { targetDeviceId, displayMode });
  }

  // ─── Event System ────────────────────────────────────

  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
    return () => {
      this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    };
  }

  emit(event, data) {
    const cbs = this.listeners[event];
    if (cbs) {
      cbs.forEach(cb => cb(data));
    }
  }
}
