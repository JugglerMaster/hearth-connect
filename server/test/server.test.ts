import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';

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
    readyState: WebSocket.OPEN,
    sent,
    send(raw: string) { sent.push(JSON.parse(raw)); },
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

function join(handler: any, ws: any, deviceId: string, deviceType: 'kiosk' | 'base', label = deviceId) {
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
  join(handler, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({ type: 'PUBLISH_SOURCE', payload: { sourceId: 's1', label: 'K1', type: 'video-only' } }));
  const sources = channels.getActiveSources('default');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].type, 'video-only');
});

test('PUBLISH_SOURCE falls back to video+audio for unknown type', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  join(handler, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({ type: 'PUBLISH_SOURCE', payload: { sourceId: 's1', label: 'K1', type: 'bogus' } }));
  assert.equal(channels.getActiveSources('default')[0].type, 'video+audio');
});

test('CAPABILITIES is stored and relayed to other clients', () => {
  const { channels, handler } = newServer();
  const kiosk = makeWs();
  const base = makeWs();
  join(handler, kiosk, 'k1', 'kiosk');
  join(handler, base, 'b1', 'base');
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
  const { handler } = newServer();
  const kiosk = makeWs();
  join(handler, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({
    type: 'CAPABILITIES',
    payload: { deviceId: 'k1', videoDevices: [{ id: '/dev/video0', label: 'Cam' }], audioDevices: [] },
  }));
  const lateBase = makeWs();
  join(handler, lateBase, 'b2', 'base');
  const got = lateBase.sent.find((m: any) => m.type === 'CAPABILITIES' && m.payload.deviceId === 'k1');
  assert.ok(got, 'late base received prior CAPABILITIES');
});

test('AUDIO_PEAK is relayed with server-side deviceId', () => {
  const { handler } = newServer();
  const kiosk = makeWs();
  const base = makeWs();
  join(handler, kiosk, 'k1', 'kiosk');
  join(handler, base, 'b1', 'base');
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
  join(handler, target, 'k1', 'kiosk');
  config.createDevice('k1', 'kiosk', 'K1', 'default');
  const base = makeWs();
  join(handler, base, 'b1', 'base');
  handler.handle(base, JSON.stringify({ type: 'REMOVE_DEVICE', payload: { targetDeviceId: 'k1' } }));
  assert.ok(target._closed, 'target socket closed');
  assert.ok(!channels.getRecentlySeenDevices().some(d => d.id === 'k1'), 'removed from device list');
  assert.equal(config.getDevice('k1'), undefined, 'removed from persisted config');
  const removed = base.sent.find((m: any) => m.type === 'DEVICE_REMOVED');
  assert.ok(removed);
  assert.equal(removed.payload.deviceId, 'k1');
});

test('REMOVE_DEVICE rejected for non-base clients', () => {
  const { handler } = newServer();
  const kiosk = makeWs();
  join(handler, kiosk, 'k1', 'kiosk');
  handler.handle(kiosk, JSON.stringify({ type: 'REMOVE_DEVICE', payload: { targetDeviceId: 'other' } }));
  const err = kiosk.sent.find((m: any) => m.type === 'ERROR');
  assert.ok(err);
  assert.equal(err.payload.code, 'NOT_ALLOWED');
});

// ─── cleanup ──────────────────────────────────────────────

test('cleanup temp config dirs', () => {
  // (no-op placeholder; tmp dirs are per-test and harmless)
  assert.ok(true);
});
