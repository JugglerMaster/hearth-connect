// hermes-verify for the device-authorization handshake in signaling.js.
//
// Runs the REAL client module in a Node vm with a fake WebSocket + fake DOM,
// no browser. Verifies the contract the hub server enforces:
//   1. AUTH is the first frame on every socket (with the stored token, if any).
//   2. Nothing else is transmitted before AUTH_OK — sends are queued.
//   3. AUTH_REQUIRED shows the pending overlay and does NOT fire 'open'.
//   4. AUTH_OK stores the one-time token, flushes the queue, fires 'open' once.
//   5. A revoked token (ERROR AUTH_INVALID + close 4004) is dropped and retried.
//   6. A 4003 denial stops the reconnect loop and shows the denied overlay.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const signalingSrc = fs.readFileSync(path.join(ROOT, 'server/public/js/signaling.js'), 'utf8');
const webrtcSrc = fs.readFileSync(path.join(ROOT, 'server/public/js/webrtc.js'), 'utf8');

// ─── controllable timers ───────────────────────────────────
let timers = [];
let nextTimer = 1;
function fakeSetTimeout(fn, ms) {
  const id = nextTimer++;
  timers.push({ id, fn, ms });
  return id;
}
function fakeClearTimeout(id) {
  timers = timers.filter((t) => t.id !== id);
}
function runTimers(ms) {
  const due = timers.filter((t) => ms === undefined || t.ms <= ms);
  timers = timers.filter((t) => !due.includes(t));
  due.forEach((t) => t.fn());
}

// ─── minimal DOM ───────────────────────────────────────────
function makeEl() {
  const el = {
    className: '',
    _html: '',
    style: {},
    _lastChild: null,
    appendChild(child) { el._lastChild = child; },
    addEventListener() {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) { el._html = v; },
    querySelector() { return null; },
  };
  return el;
}
const bodyEl = makeEl();
const document = {
  body: bodyEl,
  createElement() { return makeEl(); },
};

// ─── fake WebSocket ────────────────────────────────────────
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.last = this;
  }
  send(data) {
    // AUTH must be the first frame, always.
    assert.equal(this.readyState, FakeWebSocket.OPEN);
    this.sent.push(JSON.parse(data));
  }
  close(code, reason) {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '', wasClean: true });
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
  deliver(msg) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) });
  }
}

// ─── fake storage ──────────────────────────────────────────
function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    _store: store,
  };
}

// ─── sandbox ───────────────────────────────────────────────
// ─── fake WebRTC (for the media-handoff section) ─────────
const cryptoObj = { randomUUID: () => 'uuid-' + nextTimer++ };

class FakeRTCPeerConnection {
  constructor(iceServers) {
    this.iceServers = iceServers;
    this._connectionState = 'new';
    this._iceConnectionState = 'new';
    this.signalingState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.onicecandidate = null;
    this.ontrack = null;
    this.onnegotiationneeded = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
  }
  set connectionState(v) {
    this._connectionState = v;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }
  get connectionState() { return this._connectionState; }
  set iceConnectionState(v) {
    this._iceConnectionState = v;
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }
  get iceConnectionState() { return this._iceConnectionState; }
  getTransceivers() { return []; }
  getSenders() { return []; }
  addTrack() {}
  removeTrack() {}
  createOffer() { return Promise.resolve({ type: 'offer', sdp: 'v=0' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: 'v=0' }); }
  setLocalDescription(d) { this.localDescription = d; return Promise.resolve(d); }
  setRemoteDescription(d) { this.remoteDescription = d; return Promise.resolve(d); }
  getStats() { return Promise.resolve([]); }
  close() {}
}
class FakeRTCSessionDescription {
  constructor(sdp) { this.sdp = sdp; }
}
class FakeRTCIceCandidate {
  constructor(c) {
    this.candidate = c.candidate || c;
    this.sdpMid = c.sdpMid;
    this.sdpMLineIndex = c.sdpMLineIndex;
  }
}
class FakeMediaStream {
  constructor() { this._tracks = []; }
  getTracks() { return this._tracks; }
  addTrack(t) { this._tracks.push(t); }
}

const localStorage = makeStorage();
const sandbox = {
  WebSocket: FakeWebSocket,
  document,
  window: { crypto: cryptoObj },
  navigator: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36',
    mediaDevices: { getUserMedia: async () => new FakeMediaStream() },
  },
  localStorage,
  location: { protocol: 'https:', host: 'hub.local:8090' },
  console: { log() {}, warn() {}, error() {} },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  fetch: async () => ({}),
  JSON,
  crypto: cryptoObj,
  RTCPeerConnection: FakeRTCPeerConnection,
  RTCSessionDescription: FakeRTCSessionDescription,
  RTCIceCandidate: FakeRTCIceCandidate,
  MediaStream: FakeMediaStream,
};
vm.createContext(sandbox);
vm.runInContext(signalingSrc + webrtcSrc +
  '\n;globalThis.__SignalingClient = SignalingClient; globalThis.__WebRTCManager = WebRTCManager;', sandbox);
const SignalingClient = sandbox.__SignalingClient;
const WebRTCManager = sandbox.__WebRTCManager;

assert.ok(SignalingClient, 'SignalingClient should be defined');
assert.ok(WebRTCManager, 'WebRTCManager should be defined');

function tick() { timers = timers.filter((t) => t.ms > 4000); } // drop the 4s fallback

// ─── 1. pairing flow, no token ────────────────────────────
{
  localStorage.removeItem('hearth_authToken');
  const sig = new SignalingClient('wss://127.0.0.1:8090');
  sig.deviceId = 'kiosk-1';
  sig.deviceType = 'kiosk';
  sig.deviceLabel = 'Nursery';
  const events = [];
  sig.on('open', () => events.push('open'));
  sig.on('authRequired', (p) => events.push('authRequired:' + p.code));

  sig.connect();
  const ws = FakeWebSocket.last;
  ws.open();

  assert.equal(ws.sent.length, 1, 'exactly one frame before AUTH_OK');
  assert.equal(ws.sent[0].type, 'AUTH');
  assert.equal(ws.sent[0].payload.token, undefined);
  assert.equal(ws.sent[0].payload.deviceType, 'kiosk');
  assert.equal(ws.sent[0].payload.deviceId, 'kiosk-1');
  assert.equal(ws.sent[0].payload.label, 'Nursery');

  // Sends are queued, not transmitted, before authorization.
  sig.joinRoom('default', 'kiosk-1');
  sig.subscribeSource('pi-1');
  assert.equal(ws.sent.length, 1, 'JOIN_ROOM must be queued while pending');

  ws.deliver({ type: 'AUTH_REQUIRED', payload: { pendingId: 'p1', code: '123456', expiresAt: Date.now() + 300000 } });
  assert.equal(sig.authState, 'pending');
  assert.equal(events.includes('open'), false, "'open' must not fire before AUTH_OK");
  assert.ok(bodyEl._lastChild && bodyEl._lastChild.className === 'auth-overlay',
    'pending overlay should be mounted');
  assert.match(bodyEl._lastChild.innerHTML, /123456/);

  // Approval delivers the one-time token.
  ws.deliver({ type: 'AUTH_OK', payload: { credentialId: 'cred-1', token: 'tok-abc' } });
  assert.equal(localStorage.getItem('hearth_authToken'), 'tok-abc', 'token persisted');
  assert.equal(sig.authState, 'authed');
  assert.deepEqual(ws.sent.slice(1).map((m) => m.type), ['JOIN_ROOM', 'SUBSCRIBE_SOURCE'],
    'queued frames flush in order');
  assert.equal(events.filter((e) => e === 'open').length, 1, "'open' fires exactly once");
  assert.ok(bodyEl._lastChild.classList.contains('hidden'), 'overlay hidden after approval');
}

// ─── 2. returning device presents the stored token ────────
{
  const sig = new SignalingClient('wss://127.0.0.1:8090');
  sig.deviceType = 'base';
  sig.connect();
  const ws = FakeWebSocket.last;
  ws.open();
  assert.equal(ws.sent[0].type, 'AUTH');
  assert.equal(ws.sent[0].payload.token, 'tok-abc', 'stored token is presented');
  ws.deliver({ type: 'AUTH_OK', payload: { credentialId: 'cred-1' } });
  assert.equal(sig.authed, true);
}

// ─── 3. revoked token is dropped and re-paired ────────────
{
  const sig = new SignalingClient('wss://127.0.0.1:8090');
  sig.connect();
  const ws = FakeWebSocket.last;
  ws.open();
  assert.equal(ws.sent[0].payload.token, 'tok-abc');
  ws.deliver({ type: 'ERROR', payload: { code: 'AUTH_INVALID' } });
  assert.equal(localStorage.getItem('hearth_authToken'), null, 'revoked token cleared');
  ws.close(4004, 'AUTH_INVALID');
  assert.ok(timers.length > 0, 'should schedule a reconnect to re-pair');
  runTimers(1000);
  const ws2 = FakeWebSocket.last;
  assert.notEqual(ws2, ws, 'reconnected with a new socket');
  ws2.open();
  assert.equal(ws2.sent[0].payload.token, undefined, 'retries without the dead token');
}

// ─── 4. denial stops the reconnect loop ───────────────────
{
  const sig = new SignalingClient('wss://127.0.0.1:8090');
  const denied = [];
  sig.on('authDenied', (p) => denied.push(p));
  sig.connect();
  const ws = FakeWebSocket.last;
  ws.open();
  ws.deliver({ type: 'AUTH_DENIED', payload: { reason: 'denied' } });
  ws.close(4003, 'AUTH_DENIED');
  assert.equal(sig.authState, 'denied');
  assert.equal(denied.length, 1);
  assert.ok(bodyEl._lastChild.classList.contains('hidden') === false, 'denied overlay visible');
  // No backoff timer was armed for this socket (the only timers left over are
  // the 4s pre-auth fallbacks from earlier sections).
  assert.equal(timers.filter((t) => t.ms <= 1000).length, 0,
    'no auto-reconnect after an explicit denial');
}

// ─── 5. media handoff after AUTH_OK ──────────────────────
{
  localStorage.removeItem('hearth_authToken');
  const sig = new SignalingClient('wss://127.0.0.1:8090');
  sig.deviceId = 'kiosk-1';
  sig.deviceType = 'kiosk';
  sig.deviceLabel = 'Nursery';

  const connStates = [];
  const timeline = [];
  const openFired = [];
  class Sub extends WebRTCManager {
    onConnectionStateChange(peerId, state) { connStates.push({ peerId, state }); }
  }
  const wm = new Sub(sig);

  // Queue the room/sub frames while pending — they must flush after AUTH_OK.
  sig.joinRoom('default', 'kiosk-1');
  sig.subscribeSource('pi-1');

  // The page creates a monitor PC in response to 'open' (post-auth).
  sig.on('open', () => {
    openFired.push('open');
    timeline.push({ t: 'open' });
    wm.createPeerConnection('pi-1', 'recv', false);
  });

  sig.connect();
  const ws = FakeWebSocket.last;
  // Record the order of frames sent vs 'open'.
  const origSend = ws.send.bind(ws);
  ws.send = (data) => {
    timeline.push({ t: 'send', type: JSON.parse(data).type });
    origSend(data);
  };

  ws.open();
  ws.deliver({ type: 'AUTH_REQUIRED', payload: { pendingId: 'p1', code: '123456', expiresAt: Date.now() + 300000 } });
  ws.deliver({ type: 'AUTH_OK', payload: { credentialId: 'cred-1', token: 'tok-abc' } });

  // 5a. Full signaling connection after AUTH_OK.
  assert.equal(sig.authed, true, 'authed after AUTH_OK');
  assert.equal(sig.connected, true, 'socket connected after AUTH_OK');
  assert.equal(sig.authState, 'authed', 'authState authed');

  // 5b. Handoff order: every queued room/sub frame flushes BEFORE 'open'
  //     fires, so a media consumer that acts on 'open' never sees it before
  //     the room/sub are registered.
  const order = timeline.map((e) => (e.t === 'send' ? e.type : e.t));
  const openIdx = order.indexOf('open');
  assert.ok(openIdx !== -1, "'open' fired after AUTH_OK");
  assert.ok(order.indexOf('JOIN_ROOM') !== -1, 'JOIN_ROOM flushed after AUTH_OK');
  assert.ok(order.indexOf('SUBSCRIBE_SOURCE') !== -1, 'SUBSCRIBE_SOURCE flushed after AUTH_OK');
  assert.ok(order.indexOf('JOIN_ROOM') < openIdx, 'JOIN_ROOM flushed before open');
  assert.ok(order.indexOf('SUBSCRIBE_SOURCE') < openIdx, 'SUBSCRIBE_SOURCE flushed before open');

  // 5c. The media consumer reached 'connected' after the handoff.
  const pc = wm.peerConnections.get('pi-1');
  assert.ok(pc, 'monitor PC created in response to post-auth open');
  pc.connectionState = 'connected';
  assert.deepEqual(connStates, [{ peerId: 'pi-1', state: 'connected' }],
    'media consumer reaches connected after auth handoff');
  assert.equal(wm.pcMeta.get('pi-1').connected, true, 'pcMeta marks connected');
}

console.log('hermes-verify-auth: all checks passed');
