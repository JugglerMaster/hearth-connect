class SignalingClient {
  constructor(url) {
    this.url = url || this.getServerUrl();
    this.ws = null;
    this.deviceId = localStorage.getItem('hearth_deviceId') || null;
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

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
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

      // If we have a stored deviceId, auto-join the room
      if (this.deviceId && this.roomId) {
        this.joinRoom(this.roomId, this.deviceId);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('Signaling: bad message', err);
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.emit('close');

      if (!this.intentionalClose) {
        console.log('Signaling: disconnected, reconnecting...');
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('Signaling: error', err);
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
    this.connected = false;
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
        localStorage.setItem('hearth_deviceId', this.deviceId);
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

      case 'CONFIG_UPDATED':
        this.emit('configUpdated', msg.payload);
        break;

      case 'CONFIG_RESULT':
        this.emit('configResult', msg.payload);
        break;

      case 'DEVICE_STATUS':
        this.emit('deviceStatus', msg.payload);
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Signaling: cannot send, not connected');
      return false;
    }

    const msg = JSON.stringify({ type, payload });
    this.ws.send(msg);
    return true;
  }

  // ─── API Methods ─────────────────────────────────────

  joinRoom(roomId, deviceId) {
    this.roomId = roomId;
    this.send('JOIN_ROOM', { roomId, deviceId, deviceType: this.deviceType, label: this.deviceLabel });
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

  sendOffer(to, sdp) {
    this.send('OFFER', { to, sdp });
  }

  sendAnswer(to, sdp) {
    this.send('ANSWER', { to, sdp });
  }

  sendIceCandidate(to, candidate) {
    this.send('ICE_CANDIDATE', { to, candidate });
  }

  requestIceRestart(to) {
    this.send('ICE_RESTART', { to });
  }

  setConfig(targetDeviceId, config) {
    this.send('SET_CONFIG', { targetDeviceId, config });
  }

  getConfig() {
    this.send('GET_CONFIG');
  }

  requestTalk(targetPublisherId) {
    this.send('REQUEST_TALK', { targetPublisherId });
  }

  stopTalk(targetPublisherId) {
    this.send('STOP_TALK', { targetPublisherId });
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
