// hermes-verify for the Home Assistant client (home-assistant.js).
//
// Runs the REAL client module in a Node vm with a minimal DOM + a fake
// SignalingClient (so the HA relay frames it emits are observable), with no
// browser and no real WebSocket. Verifies:
//   1. On settings + HA connection it requests get_states + subscribes.
//   2. get_states results seed entity states and render adaptive tiles
//      (light toggle + brightness; climate mode buttons + temp setpoint).

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'server/public/js/home-assistant.js'), 'utf8');

// ─── minimal DOM ───────────────────────────────────────────
const elements = {};
function el(sel) {
  return (elements[sel] ||= makeEl());
}
function makeEl() {
  return {
    _html: '',
    className: '',
    textContent: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    addEventListener() {},
    getAttribute() { return null; },
    setAttribute() {},
    querySelector(sel) { return el(sel); },
    querySelectorAll() { return []; },
  };
}
const document = {
  readyState: 'loading',
  getElementById(id) { return el('#' + id); },
  querySelector(sel) { return el(sel); },
  addEventListener() {},
};

// ─── fake SignalingClient ────────────────────────────────
const sent = [];
const handlers = {};
const sig = {
  on(ev, fn) { (handlers[ev] ||= []).push(fn); },
  emit(ev, payload) { (handlers[ev] || []).forEach((f) => f(payload)); },
  getSettings() { sent.push({ type: 'GET_SETTINGS' }); },
  setSettings(section, value) { sent.push({ type: 'SETTINGS', section, value }); },
  haConnect() { sent.push({ type: 'HA_CONNECT' }); },
  haFrame(payload) { sent.push({ type: 'HA_FRAME', payload }); },
  connect() {}, joinRoom() {},
};

// ─── run the real module in a vm ──────────────────────────
const sandbox = {
  document,
  window: {},
  localStorage: { getItem() { return null; }, setItem() {} },
  console,
  setTimeout,
  clearTimeout,
  JSON,
  module: { exports: {} },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { HA, init } = sandbox.module.exports;

// ─── drive it like the server would ───────────────────────
init(sig, el('#haRoot'));

sig.emit('settingsResult', {
  settings: {
    homeAssistant: {
      url: 'http://ha:8123',
      hasToken: true,
      pages: [{ id: 'p1', name: 'Home', entities: ['light.a', 'climate.b'] }],
    },
  },
});
assert.ok(sent.find((m) => m.type === 'HA_CONNECT'), 'client requested HA_CONNECT after settings');

sig.emit('haConnected', { state: 'connected' });
const getStates = sent.find((m) => m.type === 'HA_FRAME' && m.payload.type === 'get_states');
const subscribe = sent.find((m) => m.type === 'HA_FRAME' && m.payload.type === 'subscribe_events');
assert.ok(getStates, 'client sent get_states after connected');
assert.ok(subscribe, 'client subscribed to state_changed');

// Deliver a get_states result: light.a (with brightness) + climate.b.
sig.emit('haFrame', {
  type: 'result',
  id: getStates.payload.id,
  success: true,
  result: [
    { entity_id: 'light.a', state: 'off', attributes: { friendly_name: 'Lamp', brightness: 200 } },
    { entity_id: 'climate.b', state: 'heat', attributes: { friendly_name: 'Thermostat', hvac_modes: ['off', 'heat', 'cool'], current_temperature: 21, temperature: 22, min_temp: 7, max_temp: 35 } },
  ],
});

const tiles = el('#haTiles').innerHTML;
assert.ok(tiles.includes('Lamp'), 'light tile rendered with friendly name');
assert.ok(tiles.includes('Thermostat'), 'climate tile rendered with friendly name');
assert.ok(tiles.includes('78%'), 'brightness rendered as percent (200/255≈78%)');
assert.ok(tiles.includes('heat') && tiles.includes('cool'), 'climate mode buttons rendered from hvac_modes');
assert.ok(tiles.includes('22°'), 'climate target temperature rendered');
assert.ok(tiles.includes('data-brightness="light.a"'), 'adaptive brightness slider present for light with brightness attribute');

// state_changed for the light flips it on → tile re-renders with "On".
sig.emit('haFrame', {
  type: 'event',
  event: { event_type: 'state_changed', data: { new_state: { entity_id: 'light.a', state: 'on', attributes: { friendly_name: 'Lamp', brightness: 200 } } } },
});
assert.ok(el('#haTiles').innerHTML.includes('>On<'), 'light tile reflects on-state from state_changed');

console.log('OK: hermes-verify-ha passed (protocol + adaptive tiles)');
