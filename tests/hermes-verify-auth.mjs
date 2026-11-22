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
const src = fs.readFileSync(path.join(ROOT, 'server/public/js/signaling.js'), 'utf8');

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
const localStorage = makeStorage();
const sandbox = {
  WebSocket: FakeWebSocket,
  document,
  window: {},
  navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120 Safari/537.36' },
  localStorage,
  location: { protocol: 'https:', host: 'hub.local:8090' },
  console: { log() {}, warn() {}, error() {} },
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  fetch: async () => ({}),
  JSON,
};
vm.createContext(sandbox);
vm.runInContext(src + '\n;globalThis.__SignalingClient = SignalingClient;', sandbox);
const SignalingClient = sandbox.__SignalingClient;

assert.ok(SignalingClient, 'SignalingClient should be defined');

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

console.log('hermes-verify-auth: all checks passed');
