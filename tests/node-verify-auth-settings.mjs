// Node reference-server auth guard test.
//
// Verifies that the reference build enforces the same admin-plane loopback
// gate as the Android hub: a non-loopback `base` can never flip the auth
// kill-switch (`SET_SETTINGS {section:"auth"}`), while the loopback hub can.
//
// Run: node tests/node-verify-auth-settings.mjs
// (requires the server to be built: `cd server && npm run build`)
import { SignalingHandler, isLoopbackIp } from '../server/dist/SignalingHandler.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) {
    passed++;
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.error('  FAIL ' + name);
  }
}

// ─── isLoopbackIp unit cases ────────────────────────────────────────────────
console.log('isLoopbackIp:');
assert(isLoopbackIp('127.0.0.1'), '127.0.0.1 is loopback');
assert(isLoopbackIp('::1'), '::1 is loopback');
assert(isLoopbackIp('[::1]'), '[::1] is loopback');
assert(isLoopbackIp('localhost'), 'localhost is loopback');
assert(isLoopbackIp('127.0.0.5'), '127.0.0.5 is loopback (127/8)');
assert(isLoopbackIp('::ffff:127.0.0.1'), '::ffff:127.0.0.1 is loopback (mapped)');
assert(!isLoopbackIp('192.168.1.50'), '192.168.1.50 is NOT loopback');
assert(!isLoopbackIp('10.0.0.5'), '10.0.0.5 is NOT loopback');
assert(!isLoopbackIp('::ffff:192.168.1.50'), '::ffff:192.168.1.50 is NOT loopback');
assert(!isLoopbackIp(''), 'empty is NOT loopback');
assert(!isLoopbackIp(undefined), 'undefined is NOT loopback');

// ─── Guard via handleSetSettings ────────────────────────────────────────────
console.log('handleSetSettings auth guard:');

// Build a SignalingHandler wired to minimal fakes. `ip` is the client's
// socket IP (what the Android hub's connLoopback gate keys off of).
function makeHandler(deviceType, ip) {
  const connId = 'test-conn';
  const sent = [];
  let settingsChanged = null;
  const channels = {
    getClientByConnId: (id) =>
      id === connId
        ? {
            connId,
            deviceId: 'base-1',
            deviceType,
            roomId: 'default',
            label: 'Test',
            sources: [],
            subscriptions: [],
            connectedAt: 0,
            lastHeartbeat: 0,
          }
        : undefined,
    getAllClients: () => new Map([[connId, { connId, deviceType }]]),
    getTransport: (id) =>
      id === connId ? { connId: id, send: (m) => sent.push(m) } : undefined,
  };
  const config = {
    setSettingsSection: (section, value) => {
      settingsChanged = { section, value };
      return { auth: { requiresApproval: true } };
    },
    getSettingsMasked: () => ({ auth: { requiresApproval: true } }),
  };
  const handler = new SignalingHandler(channels, config);
  const transport = {
    connId,
    ip,
    send: (m) => sent.push(m),
    close: () => {},
  };
  return { handler, transport, sent, settingsChanged: () => settingsChanged };
}

// 1. A non-loopback base cannot flip the auth kill-switch.
{
  const { handler, transport, sent, settingsChanged } = makeHandler('base', '192.168.1.50');
  handler.handle(transport, JSON.stringify({ type: 'SET_SETTINGS', payload: { section: 'auth', value: { requiresApproval: false } } }));
  const err = sent.find((m) => m.type === 'ERROR');
  assert(err && err.payload.code === 'NOT_ALLOWED', 'non-loopback base auth change -> NOT_ALLOWED');
  assert(settingsChanged() === null, 'non-loopback base auth change -> config unchanged');
}

// 2. The loopback hub CAN flip the auth kill-switch.
{
  const { handler, transport, sent, settingsChanged } = makeHandler('base', '127.0.0.1');
  handler.handle(transport, JSON.stringify({ type: 'SET_SETTINGS', payload: { section: 'auth', value: { requiresApproval: false } } }));
  const res = sent.find((m) => m.type === 'SETTINGS_RESULT');
  assert(res && res.payload.ok === true, 'loopback base auth change -> SETTINGS_RESULT ok:true');
  assert(
    settingsChanged()?.section === 'auth' && settingsChanged()?.value.requiresApproval === false,
    'loopback base auth change -> config updated'
  );
}

// 3. The guard is auth-section-specific: other sections stay writable by any base.
{
  const { handler, transport, sent, settingsChanged } = makeHandler('base', '192.168.1.50');
  handler.handle(transport, JSON.stringify({ type: 'SET_SETTINGS', payload: { section: 'homeAssistant', value: { token: 'x' } } }));
  const res = sent.find((m) => m.type === 'SETTINGS_RESULT');
  assert(res && res.payload.ok === true, 'non-loopback base non-auth section -> allowed');
  assert(settingsChanged()?.section === 'homeAssistant', 'non-loopback base non-auth section -> config updated');
}

// 4. A non-base device cannot write settings even from loopback (pre-existing check).
{
  const { handler, transport, sent } = makeHandler('kiosk', '127.0.0.1');
  handler.handle(transport, JSON.stringify({ type: 'SET_SETTINGS', payload: { section: 'auth', value: { requiresApproval: false } } }));
  const err = sent.find((m) => m.type === 'ERROR');
  assert(err && err.payload.code === 'NOT_ALLOWED', 'kiosk auth change -> NOT_ALLOWED (not a base)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
