#!/usr/bin/env node
/**
 * iOS Safari debug bridge (raw CDP edition).
 *
 * Connects to real iOS Safari on a USB-tethered device via
 * remotedebug-ios-webkit-adapter (which sits on top of
 * ios-webkit-debug-proxy + usbmuxd).
 *
 * This is a DEBUG AID, not a test runner that can exercise camera/mic. It can:
 *   - attach to an already-open Safari tab (or navigate to one)
 *   - evaluate JS in the page (DOM/state inspection)
 *   - capture console + pageerror output
 *   - take screenshots
 *   - run DOM-only assertions (see assertions.js)
 *
 * Why raw CDP instead of puppeteer.connect:
 *   remotedebug-ios-webkit-adapter does not implement puppeteer's browser-level
 *   target handshake, so puppeteer.connect hangs. Talking directly to the page
 *   target WebSocket works reliably (see cdp.js).
 *
 * Usage:
 *   SERVER_URL=https://lenovoserver:8090 PAGE=base-station.html ROOM=test \
 *     node bridge.js
 *
 * Env:
 *   ADAPTER_PORT  (default 9000)  port the adapter listens on
 *   SERVER_URL    base URL of the running Hearth-Connect server
 *   PAGE          which page to open (monitor.html|base-station.html|viewer.html)
 *   ROOM          room id to append (?room=) — optional
 *   DEVICE_UDID   specific device (optional; auto-picks first)
 *   NAVIGATE      1 to force navigation even if a matching tab exists
 *   SCREENSHOT    path to write a screenshot (optional)
 */

'use strict';

const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const chalk = require('chalk');
const { CDPPage } = require('./cdp');
const { runAssertions } = require('./assertions');

const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || '9000', 10);
const SERVER_URL = (process.env.SERVER_URL || 'https://localhost:8090').replace(/\/$/, '');
const PAGE = process.env.PAGE || 'base-station.html';
const ROOM = process.env.ROOM || '';
const NAVIGATE = process.env.NAVIGATE === '1';
const SCREENSHOT = process.env.SCREENSHOT || '';
const DEVICE_UDID = process.env.DEVICE_UDID || '';

const log = (...a) => console.log(chalk.cyan('[bridge]'), ...a);
const warn = (...a) => console.warn(chalk.yellow('[bridge]'), ...a);
const fail = (...a) => console.error(chalk.red('[bridge]'), ...a);

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`bad JSON from ${url}: ${e.message}`)); }
        });
      })
      .on('error', reject);
  });
}

function discoverDevice() {
  try {
    const out = execSync('idevice_id -l', { encoding: 'utf8' }).trim();
    const ids = out.split('\n').filter(Boolean);
    if (!ids.length) return null;
    return DEVICE_UDID && ids.includes(DEVICE_UDID) ? DEVICE_UDID : ids[0];
  } catch (e) {
    return null;
  }
}

function pickTab(tabs) {
  // Prefer a tab whose URL already matches the requested PAGE.
  if (!NAVIGATE) {
    const match = tabs.find((t) => t.url && t.url.includes(PAGE));
    if (match) return { tab: match, navigate: false };
  }
  // Otherwise navigate the first real page tab (skip blank data: URLs).
  const real = tabs.find((t) => t.url && !t.url.startsWith('data:'));
  return { tab: real || tabs[0], navigate: true };
}

async function main() {
  log('discovering iOS device…');
  const udid = discoverDevice();
  if (!udid) {
    fail('No iOS device found over USB. Is it plugged in and trusted? (see README.md)');
    process.exit(2);
  }
  log('device:', udid);

  log(`querying adapter at http://localhost:${ADAPTER_PORT}/json …`);
  let tabs;
  try {
    tabs = await getJson(`http://localhost:${ADAPTER_PORT}/json`);
  } catch (e) {
    fail(`adapter not reachable: ${e.message}`);
    fail('Start the stack first: bash run.sh start  (or see README.md).');
    process.exit(3);
  }
  if (!Array.isArray(tabs) || !tabs.length) {
    fail('adapter returned no tabs. Open the page in Safari on the device and keep it foregrounded.');
    process.exit(5);
  }

  const { tab, navigate } = pickTab(tabs);
  if (!tab || !tab.webSocketDebuggerUrl) {
    fail('no usable tab/webSocketDebuggerUrl from adapter.');
    process.exit(5);
  }

  const targetUrl = ROOM ? `${SERVER_URL}/${PAGE}?room=${encodeURIComponent(ROOM)}` : `${SERVER_URL}/${PAGE}`;
  if (navigate) {
    log('no open tab for', PAGE, '— navigating to', targetUrl);
  } else {
    log('attaching to open tab:', tab.title, tab.url);
  }

  const page = new CDPPage(tab.webSocketDebuggerUrl);
  await page.attach();

  // Console + error capture.
  const logs = [];
  page.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    const line = `[console.${p.type}] ${text}`;
    logs.push(line);
    console.log(chalk.gray('  page>'), line);
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const line = `exception: ${p.exceptionDetails?.text || ''}`;
    logs.push(line);
    console.error(chalk.red('  page>'), line);
  });

  if (navigate) {
    await page._cmd('Page.navigate', { url: targetUrl }).catch((e) => warn('navigate warning:', e.message));
    await new Promise((r) => setTimeout(r, 1500));
  } else {
    await new Promise((r) => setTimeout(r, 1500));
  }

  log('running DOM/state assertions…');
  const result = await runAssertions(page);
  for (const r of result) {
    if (r.pass) log(chalk.green('PASS'), r.name, '—', r.detail);
    else fail(chalk.red('FAIL'), r.name, '—', r.detail);
  }

  if (SCREENSHOT) {
    try {
      await page.screenshot(SCREENSHOT);
      log('screenshot →', SCREENSHOT);
    } catch (e) {
      warn('screenshot skipped:', e.message);
    }
  }

  page.detach();
  const failed = result.filter((r) => !r.pass).length;
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  fail('unexpected error:', e.message);
  process.exit(1);
});
