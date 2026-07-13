#!/usr/bin/env node
/**
 * iOS Safari debug bridge.
 *
 * Connects Puppeteer (puppeteer-core) to real iOS Safari on a USB-tethered
 * device via remotedebug-ios-webkit-adapter (which itself sits on top of
 * ios-webkit-debug-proxy + usbmuxd).
 *
 * This is a DEBUG AID, not a test runner that can exercise camera/mic. It can:
 *   - attach to an already-open Safari tab (or navigate to one)
 *   - evaluate JS in the page (DOM/state inspection)
 *   - capture console + pageerror output
 *   - take screenshots
 *   - run DOM-only assertions (see assertions.js)
 *
 * Usage:
 *   SERVER_URL=https://192.168.1.50:8090 PAGE=base-station.html ROOM=test \
 *     node bridge.js
 *
 * Env:
 *   ADAPTER_PORT  (default 9000)  port the adapter listens on
 *   PROXY_PORT    (default 9222)  port ios-webkit-debug-proxy listens on
 *   SERVER_URL    base URL of the running Hearth-Connect server
 *   PAGE          which page to open (monitor.html|base-station.html|viewer.html)
 *   ROOM          room id to append (?room=) — optional
 *   DEVICE_UDID   specific device (optional; auto-picks first)
 *   NAVIGATE      1 to force page.goto even if a matching tab exists
 *   SCREENSHOT    path to write a screenshot (optional)
 */

'use strict';

const http = require('http');
const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');
const chalk = require('chalk');
const { runAssertions } = require('./assertions');

const ADAPTER_PORT = parseInt(process.env.ADAPTER_PORT || '9000', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '9222', 10);
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
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`bad JSON from ${url}: ${e.message}`));
          }
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

async function main() {
  log('discovering iOS device…');
  const udid = discoverDevice();
  if (!udid) {
    fail('No iOS device found over USB. Is it plugged in and trusted? (see README.md)');
    process.exit(2);
  }
  log('device:', udid);

  log(`querying adapter at http://localhost:${ADAPTER_PORT}/json/version …`);
  let version;
  try {
    version = await getJson(`http://localhost:${ADAPTER_PORT}/json/version`);
  } catch (e) {
    fail(`adapter not reachable: ${e.message}`);
    fail('Start the stack first: bash run.sh start  (or see README.md).');
    process.exit(3);
  }
  const wsEndpoint = version.webSocketDebuggerUrl;
  if (!wsEndpoint) {
    fail('adapter /json/version missing webSocketDebuggerUrl. Wrong adapter?');
    process.exit(3);
  }
  log('adapter OK, CDP endpoint:', wsEndpoint);

  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      ignoreHTTPSErrors: true,
      defaultViewport: null,
    });
  } catch (e) {
    fail(`puppeteer.connect failed: ${e.message}`);
    process.exit(4);
  }
  log('connected to iOS Safari via CDP.');

  const targetUrl = ROOM ? `${SERVER_URL}/${PAGE}?room=${encodeURIComponent(ROOM)}` : `${SERVER_URL}/${PAGE}`;
  let page = null;

  // Try to reuse an already-open tab matching our target page.
  const targets = browser.targets();
  for (const t of targets) {
    const u = t.url();
    if (u && u.includes(PAGE)) {
      try {
        page = await t.page();
        log('reusing open tab:', u);
        break;
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (!page) {
    if (!NAVIGATE) {
      warn(`No open tab for ${PAGE}. Pass NAVIGATE=1 to auto-open it,`);
      warn(`or open ${targetUrl} in Safari on the device and re-run.`);
      await browser.disconnect();
      process.exit(5);
    }
    log('opening', targetUrl);
    // Create a new tab via CDP.
    const newTarget = await browser._createPageTarget
      ? await browser._createPageTarget()
      : null;
    page = newTarget ? await newTarget.page() : await (await browser.pages())[0].then(() => browser.newPage());
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch((e) => {
      warn('navigation warning:', e.message);
    });
  }

  // Console + error capture.
  const logs = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    logs.push(line);
    console.log(chalk.gray('  page>'), line);
  });
  page.on('pageerror', (err) => {
    const line = `pageerror: ${err.message}`;
    logs.push(line);
    console.error(chalk.red('  page>'), line);
  });

  // Give the page a moment to wire up (DOMContentLoaded / init()).
  await new Promise((r) => setTimeout(r, 1500));

  log('running DOM/state assertions…');
  const result = await runAssertions(page, { SERVER_URL, PAGE, ROOM });
  for (const r of result) {
    if (r.pass) log(chalk.green('PASS'), r.name);
    else fail(chalk.red('FAIL'), r.name, '—', r.detail);
  }

  if (SCREENSHOT) {
    await page.screenshot({ path: SCREENSHOT }).then(() => log('screenshot →', SCREENSHOT)).catch((e) => warn('screenshot failed:', e.message));
  }

  // Keep the session open for interactive poking if invoked directly.
  if (require.main === module && !process.env.CI) {
    log('Interactive session live. Press Ctrl-C to detach.');
    process.stdin.resume();
  } else {
    await browser.disconnect();
  }
}

main().catch((e) => {
  fail('unexpected error:', e.message);
  process.exit(1);
});
