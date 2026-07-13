#!/usr/bin/env node
'use strict';

/**
 * Live iOS WebRTC connection-state test (device kiosk <-> host base-station).
 *
 * iOS WebInspector only services ONE (foreground) tab's inspector at a time,
 * so driving two real device tabs remotely is unreliable. Instead we use the
 * single reliable device tab as the KIOSK, and run the BASE STATION peer in a
 * real headless Chromium ON THIS HOST. That is still a genuine device<->host
 * WebRTC connection over the LAN — the actual media path we need to verify.
 *
 *   - device kiosk tab  (CDP over USB)  → publishes camera/mic, offers to subscriber
 *   - host Chromium      (Playwright)   → base station, subscribes, receives the stream
 *
 * We inject a thin RTCPeerConnection wrapper into BOTH pages (before they create
 * PCs) to read the REAL connectionState / iceConnectionState / remote track
 * counts from each end. No production code is modified.
 *
 * Env: SERVER_HOST (192.168.1.33) SERVER_PORT (8090) TLS (1) ROOM (default)
 *      ADAPTER_PORT (9000) DEVICE_KIOSK_TAB (0)
 */

const http = require('http');
const chalk = require('chalk');
const { CDPPage } = require('./cdp');
const { chromium } = require('playwright');

const SERVER_HOST = process.env.SERVER_HOST || '192.168.1.33';
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '8090', 10);
const TLS = (process.env.TLS === '0' || /false/i.test(process.env.TLS || '')) ? false : true;
const ROOM = process.env.ROOM || 'default';
const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || '9000', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '9222', 10);
const SERVER_URL = `${TLS ? 'https' : 'http'}://${SERVER_HOST}:${SERVER_PORT}`;
const KIOSK_URL = `${SERVER_URL}/monitor.html?room=${encodeURIComponent(ROOM)}`;
const BASE_URL = `${SERVER_URL}/base-station.html?room=${encodeURIComponent(ROOM)}`;

const log = (...a) => console.log(chalk.cyan('[conn-state]'), ...a);
const warn = (...a) => console.warn(chalk.yellow('[conn-state]'), ...a);
const fail = (...a) => console.error(chalk.red('[conn-state]'), ...a);
const ok = (...a) => console.log(chalk.green('[conn-state]'), ...a);

// Injected into BOTH pages (kiosk + host Chromium) before they create PCs.
const PROBE_SRC = `(function(){
  if (window.__hcProbe) return;
  var pcs = [];
  function mkRec(){ return {role:'?',connectionState:'new',iceConnectionState:'new',iceGatheringState:'new',signalingState:'stable',remoteVideo:0,remoteAudio:0,events:[]}; }
  var Real = window.RTCPeerConnection;
  function Wrap(){
    var c = new (Function.prototype.bind.apply(Real, [null].concat([].slice.call(arguments))));
    var r = mkRec(); pcs.push(r);
    function note(t){ r.events.push(t+':'+(c.connectionState||'')+'/'+(c.iceConnectionState||'')); }
    c.addEventListener('connectionstatechange', function(){ r.connectionState = c.connectionState; note('conn'); });
    c.addEventListener('iceconnectionstatechange', function(){ r.iceConnectionState = c.iceConnectionState; note('ice'); });
    c.addEventListener('icegatheringstatechange', function(){ r.iceGatheringState = c.iceGatheringState; });
    c.addEventListener('signalingstatechange', function(){ r.signalingState = c.signalingState; });
    c.addEventListener('track', function(e){ var k=e.track?e.track.kind:'?'; if(k==='video')r.remoteVideo++; else if(k==='audio')r.remoteAudio++; });
    return c;
  }
  Wrap.prototype = Real.prototype;
  window.RTCPeerConnection = Wrap;
  window.__hcProbe = { pcs:pcs, summary:function(){ return pcs.map(function(r,i){ return {i:i,connectionState:r.connectionState,iceConnectionState:r.iceConnectionState,iceGatheringState:r.iceGatheringState,signalingState:r.signalingState,remoteVideo:r.remoteVideo,remoteAudio:r.remoteAudio,events:r.events.slice()}; }); } };
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getJson(url){return new Promise((res,rej)=>{http.get(url,r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}})}).on('error',rej)})}
async function waitForAdapter(t=15000){const d=Date.now()+t;while(Date.now()<d){try{await getJson(`http://localhost:${ADAPTER_PORT}/json/version`);return true}catch{await sleep(500)}}return false}
function pollUntil(fn,{timeout=15000,interval=1000,label='cond'}={}){const d=Date.now()+timeout;return (async()=>{let last;while(Date.now()<d){try{last=await fn()}catch{last=null}if(last)return last;await sleep(interval)}warn('timeout waiting:',label);return last})()}
const readProbe = (page) => page.evaluate(() => (window.__hcProbe ? window.__hcProbe.summary() : null)).catch((e) => ({ error: e.message }));

// ── Proxy/adapter lifecycle (owned by this harness; always torn down) ──
// We start ONLY the adapter. remotedebug-ios-webkit-adapter auto-spawns its own
// ios_webkit_debug_proxy and talks to the device over it. Starting a SECOND
// proxy ourselves makes two proxies fight over the device's single WebInspector
// USB session, which wedges CDP (Runtime.enable times out). So: adapter only.
// stopStack() also pattern-kills any lingering proxy/adapter by name so an
// orphaned proxy from a previous run can never contend on the next run.
const ADAPTER_BIN = process.env.IOS_ADAPTER || 'remotedebug_ios_webkit_adapter';
const { spawn } = require('child_process');
const { execSync } = require('child_process');
let stackProcs = [];
function startStack() {
  log('starting adapter (it spawns its own proxy)…');
  const adapter = spawn(ADAPTER_BIN, ['--port', String(ADAPTER_PORT), '--proxy-port', String(PROXY_PORT)], { stdio: 'ignore' });
  stackProcs = [adapter];
}
function killByName(bin) {
  try {
    const out = execSync(`pgrep -f '${bin}' || true`).toString().trim();
    for (const pid of out.split('\n').filter(Boolean)) {
      try { process.kill(parseInt(pid, 10), 'SIGTERM'); } catch {}
    }
  } catch {}
}
function stopStack() {
  for (const p of stackProcs) { try { p.kill('SIGTERM'); } catch {} }
  stackProcs = [];
  // Belt-and-suspenders: kill any lingering proxy/adapter by name so the
  // device's single inspector session isn't contended on the next run.
  killByName('ios_webkit_debug_proxy');
  killByName('remotedebug_ios_webkit_adapter');
  log('proxy + adapter stopped.');
}

async function main() {
  log('Test: device KIOSK (USB/CDP)  <->  host BASE STATION (headless Chromium).');
  log('NOTE: navigates the device kiosk tab at most ONCE; bails on a failed attach.');
  startStack();
  // Give the proxy/adapter a moment to come up before we probe them.
  await sleep(2500);
  if (!(await waitForAdapter())) { fail('adapter not reachable; is the device USB-connected + Safari open (foregrounded)?'); stopStack(); process.exit(3); }

  const results = {};
  let kioskPage = null, browser = null, basePage = null;

  // ── Start the host base-station peer (real Chromium) ──
  try {
    log('Launching headless Chromium as base station →', BASE_URL);
    const exe = process.env.CHROMIUM_EXE || require('os').homedir() + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
    browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    basePage = await browser.newPage({ ignoreHTTPSErrors: true });
    basePage.on('console', (m) => { const t = m.text(); if (/error|fail|warn/i.test(m.type())) console.log(chalk.gray('  base(chromium)>'), '['+m.type()+']', t.slice(0,160)); });
    await basePage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Install probe into Chromium before it creates any PC.
    await basePage.evaluate(PROBE_SRC).catch((e) => warn('base probe install:', e.message));
    log('Chromium base-station loaded.');
  } catch (e) {
    fail('Could not launch/load host Chromium base:', e.message);
    stopStack();
    process.exit(2);
  }

  // ── Attach the device kiosk tab (single session; iOS allows ONE live ──
  // inspector session per device, and a re-attach after detach() WEDGES until
  // Safari is re-touched on the device or the proxy is recycled — verified by
  // reattach-probe.js). So we attach the kiosk tab exactly ONCE and never
  // re-attach it. The base peer is driven from the host Chromium instead, so
  // no second device tab is needed. We do NOT depend on CDP to drive the test:
  // the host base page already knows the kiosk id and subscribes itself. CDP is
  // only a bonus to read the device-side connection state.
  try {
    log('Attaching device kiosk tab via CDP (single session) →', KIOSK_URL);
    log('On the device: APPROVE camera/mic if prompted (cert now matches, no warning expected).');
    const tabs = await getJson(`http://localhost:${ADAPTER_PORT}/json`);
    const real = Array.isArray(tabs) ? tabs.filter((t) => t.webSocketDebuggerUrl && t.url && !t.url.startsWith('data:')) : [];
    if (!real.length) throw new Error('no Safari tabs on device');
    // Attach ONCE. The iOS WebInspector only sustains one live session per
    // device; a failed attach must NOT be retried with re-navigation (that is
    // what made Safari's URL bar flicker). Bail to host-base-only instead.
    try {
      const kiosk = new CDPPage(real[0].webSocketDebuggerUrl);
      await kiosk.attach();
      kiosk.on('Runtime.consoleAPICalled', (p) => { const x=(p.args||[]).map(a2=>a2.value??a2.description??'').join(' '); console.log(chalk.gray('  kiosk> ['+p.type+']'), x.slice(0,160)); });
      kiosk.on('Runtime.exceptionThrown', (p) => console.error(chalk.red('  kiosk> ex:'), p.exceptionDetails && p.exceptionDetails.text));
      // Single navigation to the test URL. If it fails, we do NOT retry.
      await kiosk._cmd('Page.navigate', { url: KIOSK_URL }).catch((e)=>warn('kiosk navigate:', e.message));
      await sleep(1500);
      await kiosk.evaluate(PROBE_SRC).catch((e) => warn('kiosk probe install:', e.message));
      kioskPage = kiosk;
    } catch (e) {
      warn('kiosk CDP attach failed: ' + e.message + ' — continuing with host base only (no re-navigate).');
      results.kioskSignaling = null;
    }
    if (kioskPage) {
      const kioskReady = await pollUntil(async () => {
        const r = await kioskPage.evaluate(() => {
          const dot = document.getElementById('connectionDot');
          const tracks = document.getElementById('debugTracks');
          return { dot: dot ? dot.className : null, tracks: tracks ? tracks.textContent : null };
        }).catch(() => null);
        return r && r.dot && /online|reconnecting/.test(r.dot) ? r : null;
      }, { timeout: 30000, label: 'kiosk signaling+media' });
      log('kiosk state:', JSON.stringify(kioskReady));
      results.kioskSignaling = !!(kioskReady && /online|reconnecting/.test(kioskReady.dot || ''));
      results.kioskPublished = !!(kioskReady && kioskReady.tracks && /v\s+\d/.test(kioskReady.tracks));
      results.kioskId = await kioskPage.evaluate(() => localStorage.getItem('hearth_monitorDeviceId')).catch(() => null);
    }
  } catch (e) {
    fail('kiosk CDP error:', e.message);
    results.kioskSignaling = false;
  }

  // ── Base subscribes to the kiosk; real WebRTC forms ──
  // Read the kiosk id from the HOST base page (robust, no CDP needed).
  try {
    const kioskId = await pollUntil(async () => {
      const id = await basePage.evaluate(() => {
        const b = document.querySelector('.video-btn');
        return b ? b.getAttribute('data-id') : null;
      }).catch(() => null);
      return id;
    }, { timeout: 30000, label: 'kiosk listed in base' });
    if (!kioskId) {
      fail('host base never listed the kiosk.');
      const items = await basePage.evaluate(() => Array.from(document.querySelectorAll('.device-item')).map(el => el.getAttribute('data-id'))).catch(() => []);
      fail('base device items:', JSON.stringify(items));
    } else {
      log('kiosk', kioskId, 'visible in base. Clicking Video (real subscribe).');
      const click = await basePage.evaluate((kid) => { const b = document.querySelector('.video-btn[data-id="' + kid + '"]'); if (!b) return 'no-btn'; b.click(); return 'clicked'; }, kioskId).catch((e) => 'err:' + e.message);
      log('click:', click);
      results.baseClicked = click === 'clicked';
      const baseConn = await pollUntil(async () => {
        const p = await readProbe(basePage);
        return Array.isArray(p) && p.some((x) => x.connectionState === 'connected') ? p : null;
      }, { timeout: 30000, interval: 1000, label: 'base-side PC connected' });
      results.baseProbe = baseConn || (await readProbe(basePage));
    }
  } catch (e) {
    fail('base subscribe error:', e.message);
    results.baseClicked = false;
  }

  // ── Read kiosk-side live state (best-effort, CDP may have dropped) ──
  if (kioskPage) {
    results.kioskProbe = await readProbe(kioskPage);
    // Try to confirm signaling from the device side too, if CDP still alive.
    if (results.kioskSignaling == null) {
      results.kioskSignaling = await kioskPage.evaluate(() => {
        const dot = document.getElementById('connectionDot');
        return dot ? /online|reconnecting/.test(dot.className) : false;
      }).catch(() => null);
    }
  }

  // ── Report ──
  console.log('\n' + chalk.bold('════════ LIVE WebRTC CONNECTION STATE (device kiosk <-> host base) ════════'));
  console.log(chalk.bold('KIOSK (device, sender) probe:'), JSON.stringify(results.kioskProbe, null, 2));
  console.log(chalk.bold('BASE  (host chromium, recv) probe:'), JSON.stringify(results.baseProbe, null, 2));
  console.log(chalk.bold('═════════════════════════════════════════════════════════════════════════') + '\n');

  const kConnected = Array.isArray(results.kioskProbe) && results.kioskProbe.some((p) => p.connectionState === 'connected');
  const bConnected = Array.isArray(results.baseProbe) && results.baseProbe.some((p) => p.connectionState === 'connected');
  const kIce = Array.isArray(results.kioskProbe) && results.kioskProbe.some((p) => /connected|completed/.test(p.iceConnectionState));
  const bIce = Array.isArray(results.baseProbe) && results.baseProbe.some((p) => /connected|completed/.test(p.iceConnectionState));
  const bHasTrack = Array.isArray(results.baseProbe) && results.baseProbe.some((p) => p.remoteVideo + p.remoteAudio > 0);

  const checks = [
    ['device reachable from this host (signaling or base saw it)', results.kioskSignaling || results.baseClicked],
    ['kiosk published camera/mic (base received 1v+1a from device)', bHasTrack],
    ['host base subscribed (clicked Video for kiosk)', results.baseClicked],
    ['kiosk-side peer connection CONNECTED', kConnected],
    ['base-side peer connection CONNECTED', bConnected],
    ['kiosk ICE connected/completed', kIce],
    ['base ICE connected/completed', bIce],
    ['host base received remote video/audio track(s) from device', bHasTrack],
  ];
  let pass = 0;
  for (const [n, c] of checks) { if (c) { ok('PASS', n); pass++; } else { fail('FAIL', n); } }
  console.log(`\n${pass}/${checks.length} checks passed.`);

  // Cleanup — always tear down the device CDP stack so no session is left
  // spamming Page.navigate at the iPad (which flickers the URL bar).
  try { if (kioskPage) await kioskPage.detach(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  stopStack();

  if (!results.kioskSignaling) {
    warn('kiosk never signaled to ' + SERVER_URL + '. Approve the cert warning + ensure LAN reachability.');
  }
  process.exit(pass < checks.length ? 1 : 0);
}

// Belt-and-suspenders: kill the proxy/adapter on any exit path.
process.on('exit', () => { try { stopStack(); } catch {} });

main().catch((e) => { fail('unexpected:', e.message); try { stopStack(); } catch {} process.exit(1); });
