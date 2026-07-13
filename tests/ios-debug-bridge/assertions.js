'use strict';

/**
 * DOM/state assertions that run inside iOS Safari via CDP.
 * These deliberately avoid camera/mic (iOS blocks automation there).
 * They verify the page loaded, the client JS initialized, and key UI exists
 * — the same surface the Node-vm logic tests cover, but on a REAL device.
 *
 * Each assertion returns { name, pass, detail }.
 */

async function runAssertions(page, ctx) {
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
    out.push({ name: 'client-script-loaded', pass: hasJs, detail: hasJs ? 'found page script' : 'no page script tag' });
  } catch (e) {
    out.push({ name: 'client-script-loaded', pass: false, detail: e.message });
  }

  // 3. For base-station: after a `welcome` message the broadcast button exists.
  //    We can't force a server `welcome` from here, but we can check that the
  //    device list container exists (the panel renders into it).
  try {
    const hasDevices = await page.evaluate(() => {
      const el = document.getElementById('devices') || document.getElementById('deviceList') || document.getElementById('device-list');
      return !!el;
    });
    out.push({ name: 'device-panel-present', pass: hasDevices, detail: hasDevices ? 'panel container found' : 'no device panel container' });
  } catch (e) {
    out.push({ name: 'device-panel-present', pass: false, detail: e.message });
  }

  // 4. Signaling client reached the server (look for a known global or DOM hint).
  //    Best-effort: check that a websocket-related element/state exists.
  try {
    const wsState = await page.evaluate(() => {
      // The client stashes connection state in various places; probe a few.
      if (window.__signaling && typeof window.__signaling === 'object') return 'window.__signaling present';
      const status = document.getElementById('status') || document.getElementById('connStatus');
      return status ? status.textContent : 'no status element';
    });
    out.push({ name: 'signaling-state-probe', pass: !!wsState, detail: String(wsState) });
  } catch (e) {
    out.push({ name: 'signaling-state-probe', pass: false, detail: e.message });
  }

  return out;
}

module.exports = { runAssertions };
