import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// NOTE: `ws` is imported lazily (inside makeWs) rather than at module top level
// because importing it registers a global keep-alive agent that prevents the
// Node test runner from exiting. We only need the OPEN constant for the mock.
const WS_OPEN = 1; // WebSocket.OPEN

import { ChannelManager } from '../src/ChannelManager';
import { ConfigManager } from '../src/ConfigManager';
import { SignalingHandler } from '../src/SignalingHandler';

const allConfigs: ConfigManager[] = [];
after(() => {
  for (const c of allConfigs) c.dispose();
});

function makeWs() {
  const sent: any[] = [];
  const ws: any = {
    connId: 'conn-' + Math.random().toString(36).slice(2),
    readyState: WS_OPEN,
    sent,
    // SignalingHandler.send() passes a Message object (not a JSON string),
    // so the mock stores it directly. Tests inspect .sent for relayed messages.
    send(msg: any) { sent.push(msg); },
    close() { this._closed = true; },
    _closed: false,
  };
  return ws;
}

function newServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'));
  const file = path.join(tmp, 'config.json');
  const config = new ConfigManager(file);
  allConfigs.push(config);
  const channels = new ChannelManager();
  const handler = new SignalingHandler(channels, config);
  return { config, channels, handler, tmp, file };
}

function join(handler: any, channels: any, ws: any, deviceId: string, deviceType: 'kiosk' | 'base', label = deviceId) {
  // Production registers the transport on connection before any message is
  // handled; relays (broadcastAll/sendTo) rely on the registered transport.
  channels.registerTransport(ws);
  handler.handle(ws, JSON.stringify({ type: 'JOIN_ROOM', payload: { roomId: 'default', deviceId, deviceType, label } }));
}

// ─── ChannelManager ───────────────────────────────────────

test('addSource updates type in place instead of duplicating', () => {
  const ch = new ChannelManager();
  ch.addClient(makeWs(), 'k1', 'kiosk', 'default', 'K1');
  const a = ch.addSource('k1', 's1', 'Cam', 'video+audio')!;
  const b = ch.addSource('k1', 's1', 'Cam', 'audio-only')!;
  assert.equal(a.id, b.id);
  const sources = ch.getActiveSources('default');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].type, 'audio-only');
});

test('removeRecentlySeen deletes a device from the in-memory list', () => {
  const ch = new ChannelManager();
  ch.addClient(makeWs(), 'k1', 'kiosk', 'default', 'K1');
  assert.ok(ch.getRecentlySeenDevices().some(d => d.id === 'k1'));
  ch.removeRecentlySeen('k1');
  assert.ok(!ch.getRecentlySeenDevices().some(d => d.id === 'k1'));
});

test('capabilities roundtrip on ConnectedClient', () => {
  const ch = new ChannelManager();
  ch.addClient(makeWs(), 'k1', 'kiosk', 'default', 'K1');
  const caps = { videoDevices: [{ id: '/dev/video0', label: 'Cam' }], audioDevices: [{ id: 'hw:1,0', label: 'Mic' }] };
  ch.setCapabilities('k1', caps);
  assert.deepEqual(ch.getCapabilities('k1'), caps);
});

// ─── ConfigManager ────────────────────────────────────────

test('deleteDevice removes the device from config', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cfg-'));
  const config = new ConfigManager(path.join(tmp, 'c.json'));
  config.createDevice('k1', 'kiosk', 'K1', 'default');
  assert.ok(config.getDevice('k1'));
  config.deleteDevice('k1');
  assert.equal(config.getDevice('k1'), undefined);
});

// ─── SignalingHandler: protocol changes (Stage 0) ────────

test('PUBLISH_SOURCE accepts extended SourceType video-only', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({ type: 'PUBLISH_SOURCE', payload: { sourceId: 's1', label: 'K1', type: 'video-only' } }));
  const sources = channels.getActiveSources('default');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].type, 'video-only');
});

test('PUBLISH_SOURCE falls back to video+audio for unknown type', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({ type: 'PUBLISH_SOURCE', payload: { sourceId: 's1', label: 'K1', type: 'bogus' } }));
  assert.equal(channels.getActiveSources('default')[0].type, 'video+audio');
});

test('CAPABILITIES is stored and relayed to other clients', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  const base = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  join(handler, channels, base, 'b1', 'base');
  handler.handle(kiosk, JSON.stringify({
    type: 'CAPABILITIES',
    payload: { deviceId: 'k1', videoDevices: [{ id: '/dev/video0', label: 'Cam' }], audioDevices: [] },
  }));
  assert.ok(channels.getCapabilities('k1'));
  const relayed = base.sent.find((m: any) => m.type === 'CAPABILITIES');
  assert.ok(relayed, 'base station received CAPABILITIES');
  assert.equal(relayed.payload.deviceId, 'k1');
  assert.equal(relayed.payload.videoDevices[0].id, '/dev/video0');
});

test('late-joining base receives capabilities of already-connected devices', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({
    type: 'CAPABILITIES',
    payload: { deviceId: 'k1', videoDevices: [{ id: '/dev/video0', label: 'Cam' }], audioDevices: [] },
  }));
  const lateBase = makeWs();
  join(handler, channels, lateBase, 'b2', 'base');
  const got = lateBase.sent.find((m: any) => m.type === 'CAPABILITIES' && m.payload.deviceId === 'k1');
  assert.ok(got, 'late base received prior CAPABILITIES');
});

test('AUDIO_PEAK is relayed with server-side deviceId', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  const base = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  join(handler, channels, base, 'b1', 'base');
  handler.handle(kiosk, JSON.stringify({
    type: 'AUDIO_PEAK',
    payload: { deviceId: 'spoofed', levelDb: -20, peak: true, ts: 123 },
  }));
  const relayed = base.sent.find((m: any) => m.type === 'AUDIO_PEAK');
  assert.ok(relayed);
  assert.equal(relayed.payload.deviceId, 'k1', 'deviceId is taken from the server, not the payload');
  assert.equal(relayed.payload.peak, true);
});

test('REMOVE_DEVICE as base closes target, clears lists, broadcasts DEVICE_REMOVED', () => {
  const { channels, config, handler } = newServer();
  const target = makeWs();
  join(handler, channels, target, 'k1', 'kiosk');
  config.createDevice('k1', 'kiosk', 'K1', 'default');
  const base = makeWs();
  join(handler, channels, base, 'b1', 'base');
  handler.handle(base, JSON.stringify({ type: 'REMOVE_DEVICE', payload: { targetDeviceId: 'k1' } }));
  assert.ok(target._closed, 'target socket closed');
  assert.ok(!channels.getRecentlySeenDevices().some(d => d.id === 'k1'), 'removed from device list');
  assert.equal(config.getDevice('k1'), undefined, 'removed from persisted config');
  const removed = base.sent.find((m: any) => m.type === 'DEVICE_REMOVED');
  assert.ok(removed);
  assert.equal(removed.payload.deviceId, 'k1');
});

test('REMOVE_DEVICE rejected for non-base clients', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({ type: 'REMOVE_DEVICE', payload: { targetDeviceId: 'other' } }));
  const err = kiosk.sent.find((m: any) => m.type === 'ERROR');
  assert.ok(err);
  assert.equal(err.payload.code, 'NOT_ALLOWED');
});

// ─── Doorbell / Call signaling (new in this work) ──────

test('DOORBELL from a kiosk is relayed to all bases, not back to the ringer', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  const base1 = makeWs();
  const base2 = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  join(handler, channels, base1, 'b1', 'base');
  join(handler, channels, base2, 'b2', 'base');
  handler.handle(kiosk, JSON.stringify({
    type: 'DOORBELL',
    payload: { label: 'Nursery' },
  }));
  const r1 = base1.sent.find((m: any) => m.type === 'DOORBELL');
  const r2 = base2.sent.find((m: any) => m.type === 'DOORBELL');
  assert.ok(r1, 'base1 received DOORBELL');
  assert.ok(r2, 'base2 received DOORBELL');
  assert.equal(r1.payload.label, 'Nursery');
  assert.equal(r1.payload.from, 'k1');
  // The ringer itself must NOT get its own doorbell echoed back.
  assert.ok(!kiosk.sent.some((m: any) => m.type === 'DOORBELL'), 'ringer did not receive its own doorbell');
});

test('CALL_STATE from a base is relayed only to the target device', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  const base = makeWs();
  const other = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk');
  join(handler, channels, base, 'b1', 'base');
  join(handler, channels, other, 'k2', 'kiosk');
  handler.handle(base, JSON.stringify({
    type: 'CALL_STATE',
    payload: { targetDeviceId: 'k1', state: 'connected' },
  }));
  const k1 = kiosk.sent.find((m: any) => m.type === 'CALL_STATE');
  const k2 = other.sent.find((m: any) => m.type === 'CALL_STATE');
  assert.ok(k1, 'target kiosk received CALL_STATE');
  assert.equal(k1.payload.state, 'connected');
  assert.equal(k1.payload.from, 'b1');
  assert.ok(!k2, 'other device did not receive CALL_STATE');
});

test('broadcastToType only reaches clients of the requested type', () => {
  const ch = new ChannelManager();
  const base = makeWs();
  const kiosk = makeWs();
  ch.registerTransport(base);
  ch.registerTransport(kiosk);
  ch.addClient(base.connId, 'b1', 'base', 'default', 'Base');
  ch.addClient(kiosk.connId, 'k1', 'kiosk', 'default', 'K1');
  ch.broadcastToType('base', { type: 'DOORBELL', payload: { from: 'k1' } });
  assert.ok(base.sent.some((m: any) => m.type === 'DOORBELL'), 'base got the message');
  assert.ok(!kiosk.sent.some((m: any) => m.type === 'DOORBELL'), 'kiosk did not get the type-scoped message');
});

test('BROADCAST_SOURCE with targetDeviceId only notifies that kiosk', () => {
  const { channels, handler } = newServer();
  const base = makeWs();
  const k1 = makeWs();
  const k2 = makeWs();
  join(handler, channels, base, 'b1', 'base', 'Base');
  join(handler, channels, k1, 'k1', 'kiosk', 'K1');
  join(handler, channels, k2, 'k2', 'kiosk', 'K2');

  handler.handle(base, JSON.stringify({
    type: 'BROADCAST_SOURCE',
    payload: { sourceId: 's1', label: 'Targeted', type: 'audio-only', targetDeviceId: 'k2' },
  }));

  const k1added = k1.sent.find((m: any) => m.type === 'SOURCE_ADDED');
  const k2added = k2.sent.find((m: any) => m.type === 'SOURCE_ADDED');
  assert.ok(!k1added, 'untargeted kiosk k1 did not receive the broadcast');
  assert.ok(k2added, 'targeted kiosk k2 received the broadcast');
  assert.equal(k2added.payload.targetDeviceId, 'k2', 'target carried on the source');
});

test('BROADCAST_SOURCE without targetDeviceId notifies every kiosk', () => {
  const { channels, handler } = newServer();
  const base = makeWs();
  const k1 = makeWs();
  const k2 = makeWs();
  join(handler, channels, base, 'b1', 'base', 'Base');
  join(handler, channels, k1, 'k1', 'kiosk', 'K1');
  join(handler, channels, k2, 'k2', 'kiosk', 'K2');

  handler.handle(base, JSON.stringify({
    type: 'BROADCAST_SOURCE',
    payload: { sourceId: 's2', label: 'All', type: 'audio-only' },
  }));

  assert.ok(k1.sent.find((m: any) => m.type === 'SOURCE_ADDED'), 'k1 received the broadcast');
  assert.ok(k2.sent.find((m: any) => m.type === 'SOURCE_ADDED'), 'k2 received the broadcast');
});

test('BROADCAST_SOURCE from a base reaches a second base station (all-devices fan-out)', () => {
  const { channels, handler } = newServer();
  const base1 = makeWs();
  const base2 = makeWs();
  const k1 = makeWs();
  join(handler, channels, base1, 'b1', 'base', 'Base1');
  join(handler, channels, base2, 'b2', 'base', 'Base2');
  join(handler, channels, k1, 'k1', 'kiosk', 'K1');

  handler.handle(base1, JSON.stringify({
    type: 'BROADCAST_SOURCE',
    payload: { sourceId: 's1', label: 'Announce', type: 'audio-only' },
  }));

  const added = base2.sent.find((m: any) => m.type === 'SOURCE_ADDED');
  assert.ok(added, 'second base received SOURCE_ADDED for the broadcast');
  assert.equal(added.payload.publisherId, 'b1');
  assert.equal(added.payload.isBroadcast, true, 'source is flagged as a broadcast');
  // The broadcaster itself must not receive its own broadcast.
  assert.ok(!base1.sent.some((m: any) => m.type === 'SOURCE_ADDED' && m.payload.sourceId === 's1'), 'broadcaster did not receive its own broadcast');
});

test('SUBSCRIBE_BROADCAST is allowed for a base and notifies the publisher', () => {
  const { channels, handler } = newServer();
  const base1 = makeWs();
  const base2 = makeWs();
  join(handler, channels, base1, 'b1', 'base', 'Base1');
  join(handler, channels, base2, 'b2', 'base', 'Base2');

  handler.handle(base1, JSON.stringify({
    type: 'BROADCAST_SOURCE',
    payload: { sourceId: 's1', label: 'Announce', type: 'audio-only' },
  }));
  // base2 subscribes to base1's broadcast (so it can HEAR it).
  handler.handle(base2, JSON.stringify({
    type: 'SUBSCRIBE_BROADCAST',
    payload: { publisherId: 'b1' },
  }));

  const joined = base1.sent.find((m: any) => m.type === 'SUBSCRIBER_JOINED' && m.payload.isBroadcast);
  assert.ok(joined, 'publisher (base1) was told a subscriber joined its broadcast');
  assert.equal(joined.payload.subscriberId, 'b2');
  assert.ok(!base2.sent.some((m: any) => m.type === 'ERROR'), 'base2 was not rejected from subscribing');
});

test('kiosk (monitor) can BROADCAST_SOURCE to all devices', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  const base = makeWs();
  const otherKiosk = makeWs();
  join(handler, channels, kiosk, 'k1', 'kiosk', 'K1');
  join(handler, channels, base, 'b1', 'base', 'Base');
  join(handler, channels, otherKiosk, 'k2', 'kiosk', 'K2');

  handler.handle(kiosk, JSON.stringify({
    type: 'BROADCAST_SOURCE',
    payload: { sourceId: 'ks1', label: 'Monitor announce', type: 'audio-only' },
  }));

  assert.ok(!kiosk.sent.some((m: any) => m.type === 'ERROR'), 'kiosk broadcast was not rejected');
  assert.ok(base.sent.find((m: any) => m.type === 'SOURCE_ADDED' && m.payload.id === 'ks1'), 'base received the kiosk broadcast');
  assert.ok(otherKiosk.sent.find((m: any) => m.type === 'SOURCE_ADDED' && m.payload.id === 'ks1'), 'other kiosk received the kiosk broadcast');
});

// ─── cleanup ──────────────────────────────────────────────

test('cleanup temp config dirs', () => {
  // (no-op placeholder; tmp dirs are per-test and harmless)
  assert.ok(true);
});
