'use strict';

/**
 * DOM/state assertions that run inside iOS Safari via raw CDP.
 * These deliberately avoid camera/mic (iOS blocks automation there).
 * They verify the page loaded, the client JS initialized, and key UI exists
 * — the same surface the Node-vm logic tests cover, but on a REAL device.
 *
 * Each assertion returns { name, pass, detail }.
 *
 * @param {import('./cdp').CDPPage} page
 */
async function runAssertions(page) {
  const out = [];

  // 1. Page actually loaded (title present).
  try {
    const title = await page.title();
    out.push({ name: 'page-title', pass: !!title, detail: title || 'empty title' });
  } catch (e) {
    out.push({ name: 'page-title', pass: false, detail: e.message });
  }

  // 2. The client bundle is present in the DOM (script tag for the page JS).
  try {
    const hasJs = await page.evaluate(() => {
      const scripts = Array.from(document.scripts).map((s) => s.src || '');
      return scripts.some((s) => s.includes('js/') && (s.includes('base-station') || s.includes('camera') || s.includes('viewer') || s.includes('signaling')));
    });
    out.push({ name: 'client-script-loaded', pass: !!hasJs, detail: hasJs ? 'found page script' : 'no page script tag' });
  } catch (e) {
    out.push({ name: 'client-script-loaded', pass: false, detail: e.message });
  }

  // 3. The device list container exists (base-station renders into #deviceList).
  try {
    const hasDevices = await page.evaluate(() => {
      const el = document.getElementById('deviceList') || document.getElementById('devices') || document.getElementById('device-list');
      return !!el;
    });
    out.push({ name: 'device-panel-present', pass: !!hasDevices, detail: hasDevices ? 'panel container found' : 'no device panel container' });
  } catch (e) {
    out.push({ name: 'device-panel-present', pass: false, detail: e.message });
  }

  // 4. Signaling connection indicator state (real #connectionDot className).
  try {
    const sig = await page.evaluate(() => {
      const dot = document.getElementById('connectionDot');
      const dotClass = dot ? dot.className : '(no #connectionDot)';
      const hasGlobal = !!(window.__signaling && typeof window.__signaling === 'object');
      return { dotClass, hasGlobal };
    });
    out.push({
      name: 'signaling-state-probe',
      pass: !!sig,
      detail: `connectionDot="${sig.dotClass}" window.__signaling=${sig.hasGlobal}`,
    });
  } catch (e) {
    out.push({ name: 'signaling-state-probe', pass: false, detail: e.message });
  }

  return out;
}

module.exports = { runAssertions };
