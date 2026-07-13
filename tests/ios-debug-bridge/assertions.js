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

  // 5. Live signaling: did renderDevices populate #deviceList with rows?
  //    With the server UP, a `welcome` message should have rendered device
  //    rows. This proves the WS round-trip delivered data to the client.
  try {
    const info = await page.evaluate(() => {
      const el = document.getElementById('deviceList');
      if (!el) return { count: -1 };
      return {
        count: el.children.length,
        sample: el.textContent.trim().slice(0, 80),
      };
    });
    const populated = info.count > 0;
    out.push({
      name: 'device-list-populated',
      pass: populated,
      detail: `rows=${info.count}${info.sample ? ` text="${info.sample}"` : ''}`,
    });
  } catch (e) {
    out.push({ name: 'device-list-populated', pass: false, detail: e.message });
  }

  return out;
}

module.exports = { runAssertions };
