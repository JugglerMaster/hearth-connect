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
      console.log('Signaling: connected');
      this.emit('open');
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
      this.connected = false;
      console.error('Signaling: disconnected', 'code=' + event.code, 'reason=' + (event.reason || ''), 'clean=' + event.wasClean);
      this.emit('close', { code: event.code, reason: event.reason });

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
      console.log('Signaling (SSE): connected connId=' + this.connId);
      this.emit('open');
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
      case 'WELCOME':
        this.deviceId = msg.payload.deviceId;
        this.roomId = msg.payload.roomId;
        this.emit('welcome', msg.payload);
        break;

      case 'ERROR':
        console.error('Server error:', msg.payload);
        this.emit('error', msg.payload);
        break;

      case 'SOURCE_ADDED':
        this.emit('sourceAdded', msg.payload);
        break;

      case 'SOURCE_REMOVED':
        this.emit('sourceRemoved', msg.payload);
        break;

      case 'SUBSCRIBER_JOINED':
        this.emit('subscriberJoined', msg.payload);
        break;

      case 'SUBSCRIBER_LEFT':
        this.emit('subscriberLeft', msg.payload);
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
    }
  }

  // ─── Send ────────────────────────────────────────────

  send(type, payload = {}) {
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

  // ─── API Methods ─────────────────────────────────────

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
