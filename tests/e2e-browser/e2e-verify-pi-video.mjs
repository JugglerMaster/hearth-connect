// Live validation that the REAL Pi "Cat Room" agent is publishing a watchable
// WebRTC feed. Unlike e2e-pi-agent-interop.mjs this does NOT spawn an agent —
// it joins the live room and subscribes to the existing Pi source, then asserts
// the browser receives a video track with non-zero media bytes.
//
// Auto-SKIPS (exit 0) when the server is unreachable or no Pi source is present
// in the room, so it is safe in CI / on a dev box without the physical Pi.
//
//   SERVER_URL=https://192.168.1.103:8090 ROOM_ID=default TARGET_LABEL='Cat Room' \
//     node e2e-verify-pi-video.mjs

import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const SERVER_URL = process.env.SERVER_URL || 'https://192.168.1.103:8090';
const ROOM_ID = process.env.ROOM_ID || 'default';
const TARGET_LABEL = process.env.TARGET_LABEL || 'Cat Room';

function toWs(url) {
  return url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}
function serverReachable(url) {
  try {
    const code = execSync(`curl -sk --max-time 4 -o /dev/null -w '%{http_code}' ${url}`,
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return code !== '' && Number(code) > 0;
  } catch {
    return false;
  }
}

if (!serverReachable(SERVER_URL)) {
  console.warn(`SKIP: server not reachable at ${SERVER_URL}`);
  process.exit(0);
}

let exitCode = 0;
let browser;
const consoleBuf = [];
try {
  browser = await chromium.launch({
    args: [
      '--ignore-certificate-errors',
      '--disable-features=LocalNetworkAccess',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  page.on('console', (m) => consoleBuf.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleBuf.push(`[pageerror] ${e.message}`));

  const navUrl = SERVER_URL.replace(/^wss/, 'https').replace(/^ws/, 'http') +
    '/interop-harness.html';
  await page.goto(navUrl);

  const result = await page.evaluate(({ wsUrl, room, targetLabel }) => {
    window.__state = { tracks: [], states: [], connected: false };
    class Sub extends WebRTCManager {
      onRemoteTrack(peerId, stream, track) {
        window.__state.tracks.push({ peerId, kind: track.kind });
      }
      onConnectionStateChange(peerId, state) {
        window.__state.states.push({ peerId, state });
        if (state === 'connected') window.__state.connected = true;
      }
    }
    const sig = new SignalingClient(wsUrl);
    sig.deviceType = 'base';
    sig.deviceLabel = 'e2e-verify';
    const wm = new Sub(sig);
    window.__msgs = [];
    sig.on('message', (m) => { window.__msgs.push(m.type); });
    window.__subTo = null;
    const trySub = (s) => {
      const pub = s.publisherId;
      const label = s.label || '';
      if (typeof pub === 'string' && pub.startsWith('pi-') && !window.__subTo) {
        if (label && targetLabel && label !== targetLabel) return; // prefer the named room
        window.__subTo = pub;
        sig.subscribeSource(pub);
      }
    };
    sig.on('open', () =>
      sig.joinRoom(room, 'e2e-verify-' + Math.random().toString(16).slice(2), {}));
    sig.on('welcome', (p) => { (p.sources || []).forEach(trySub); });
    sig.on('sourceAdded', trySub);
    sig.connect();

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(async () => {
        const st = window.__state;
        if (st.connected && st.tracks.length > 0) {
          let bytes = 0, videoBytes = 0;
          try {
            const pc = wm.peerConnections.get(window.__subTo);
            if (pc) {
              const stats = await pc.getStats();
              stats.forEach((r) => {
                if (r.type === 'inbound-rtp') {
                  bytes += r.bytesReceived || 0;
                  if (r.kind === 'video' || (r.mediaType === 'video')) videoBytes += r.bytesReceived || 0;
                }
              });
            }
          } catch {}
          if (videoBytes > 0) {
            clearInterval(iv);
            resolve({ connected: true, tracks: st.tracks, bytesReceived: bytes, videoBytes });
            return;
          }
          if (Date.now() - t0 > 25000) {
            clearInterval(iv);
            resolve({ connected: true, tracks: st.tracks, bytesReceived: bytes, videoBytes,
                      note: 'connected+tracks but no video bytes within 25s' });
            return;
          }
        } else if (Date.now() - t0 > 30000) {
          clearInterval(iv);
          if (!window.__subTo) {
            resolve({ skipped: true, reason: 'no Pi source present in room',
                      msgs: window.__msgs });
            return;
          }
          reject(new Error('timed out; states=' + JSON.stringify(st.states) +
            ' subTo=' + window.__subTo + ' msgs=' + JSON.stringify(window.__msgs)));
        }
      }, 500);
    });
  }, { wsUrl: toWs(SERVER_URL), room: ROOM_ID, targetLabel: TARGET_LABEL });

  if (result.skipped) {
    console.warn(`SKIP: ${result.reason} (msgs=${JSON.stringify(result.msgs)})`);
    process.exit(0);
  }
  console.log('RESULT:', JSON.stringify(result, null, 2));
  if (!result.connected) { console.error('FAIL: not connected'); exitCode = 1; }
  else if (result.tracks.length === 0) { console.error('FAIL: no remote track'); exitCode = 1; }
  else if (result.videoBytes === 0) { console.error('WARN: connected+track but no video bytes (' + (result.note || '') + ')'); exitCode = 1; }
  else { console.log('PASS: received video from Pi (' + result.videoBytes + ' bytes)'); }
} catch (err) {
  exitCode = 1;
  console.error('FAIL:', err.message);
  console.error('--- browser console ---');
  console.error(consoleBuf.slice(-40).join('\n'));
} finally {
  if (browser) await browser.close();
}
process.exit(exitCode);
