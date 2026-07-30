// Playwright ↔ Pi-agent WebRTC interop test.
//
// Spawns the REAL GStreamer agent (TEST_SOURCE=1 → videotestsrc/audiotestsrc,
// no camera/mic) against a live Hearth server, then drives the real client
// WebRTC code (server/public/js/{webrtc,signaling}.js) inside Chromium as a
// subscriber. The agent publishes a source and offers; Chromium answers and
// must reach RTCPeerConnection 'connected' with a received track.
//
// This is the only automated way to exercise the known Chrome+GStreamer mid
// mismatch regression (webrtc.js:_resolveMid) — if the mid map breaks, ICE
// never connects and this test times out.
//
// Requires:
//   - GStreamer WebRTC bindings + `websockets` (for the spawned agent)
//   - a running server (set SERVER_URL; the Android hub or Node server)
//   - `playwright` installed (npm i -D playwright) and a Chromium build
//
// Auto-SKIPS (exit 0) when GStreamer / websockets / the server are missing,
// so it is safe in CI / on a dev box without a Pi.
//
//   SERVER_URL=http://192.168.1.50:8090 ROOM_ID=test node e2e-pi-agent-interop.mjs

import { spawn, execSync } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = import.meta.dirname;
const PI_DIR = path.resolve(__dirname, '../../linux/pi-agent');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8090';
const ROOM_ID = process.env.ROOM_ID || 'e2e-interop';
const AGENT_LOG = path.join(PI_DIR, 'e2e_interop_agent.log');
const TIMEOUT_MS = 30_000;

function toWs(url) {
  return url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}
function cap(name, py) {
  try { execSync(`python3 -c "${py}"`, { stdio: 'ignore' }); return true; }
  catch { console.warn(`SKIP: ${name} not available`); return false; }
}
async function serverReachable(url) {
  try {
    const code = execSync(`curl -sk --max-time 4 -o /dev/null -w '%{http_code}' ${url}`,
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return code !== '' && Number(code) > 0;
  } catch {
    return false;
  }
}

// ─── Skip gating ──────────────────────────────────────────
if (!existsSync(path.join(PI_DIR, 'pi-agent.py'))) {
  console.warn('SKIP: pi-agent.py not found'); process.exit(0);
}
if (!cap('GStreamer WebRTC', "import gi; gi.require_version('Gst','1.0')")) process.exit(0);
if (!cap('python websockets', 'import websockets')) process.exit(0);
if (!(await serverReachable(SERVER_URL))) {
  console.warn(`SKIP: server not reachable at ${SERVER_URL}`); process.exit(0);
}

// ─── Spawn the agent (mirrors linux/pi-agent/e2e_smoke.py) ─
const agentEnv = {
  ...process.env,
  TEST_SOURCE: '1',
  VIDEO_ENCODER: 'x264enc',
  RESOLUTION: '480p',
  FRAMERATE: '30',
  SERVER_URL: toWs(SERVER_URL),
  ROOM_ID,
  DEVICE_LABEL: 'E2E Chromium Interop',
};
const agentLogFd = openSync(AGENT_LOG, 'w');
const agent = spawn('python3', ['-u', 'pi-agent.py'], {
  cwd: PI_DIR, env: agentEnv,
  stdio: ['ignore', agentLogFd, 'inherit'],
});

let exitCode = 0;
let browser;
const consoleBuf = [];
try {
  browser = await chromium.launch({
    args: [
      '--ignore-certificate-errors',
      // The harness page is about:blank (opaque origin); Chromium's Local
      // Network Access check would otherwise block the loopback WebSocket to
      // the server. Disable it for the headless interop run.
      '--disable-features=LocalNetworkAccess',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  page.on('console', (m) => consoleBuf.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleBuf.push(`[pageerror] ${e.message}`));

  // Load the harness page from the SERVER origin so the WebSocket to the same
  // origin is allowed (Chromium's Local Network Access check would otherwise
  // block a loopback WS from an opaque about:blank origin). The page already
  // loads signaling.js + webrtc.js, so the classes are global — no injection.
  const navUrl = SERVER_URL.replace(/^wss/, 'https').replace(/^ws/, 'http') +
    '/interop-harness.html';
  await page.goto(navUrl);

  const result = await page.evaluate(({ wsUrl, room }) => {
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
    sig.deviceLabel = 'e2e-chromium';
    const wm = new Sub(sig);
    window.__msgs = [];
    sig.on('message', (m) => { window.__msgs.push(m.type); });
    const trySub = (publisherId) => {
      if (typeof publisherId === 'string' && publisherId.startsWith('pi-') && !window.__subTo) {
        window.__subTo = publisherId;
        sig.subscribeSource(publisherId);
      }
    };
    // The server sends WELCOME only AFTER JOIN_ROOM, so join on 'open' (the
    // real client pages do this too — it is NOT gated on 'welcome').
    sig.on('open', () =>
      sig.joinRoom(room, 'e2e-chromium-' + Math.random().toString(16).slice(2), {}));
    sig.on('welcome', (p) => {
      // The agent publishes its source on startup, so it may already be in the
      // room's source list by the time we join — subscribe from WELCOME too.
      (p.sources || []).forEach((s) => trySub(s.publisherId));
    });
    // The agent publishes a source whose publisherId starts with 'pi-'.
    sig.on('sourceAdded', (s) => trySub(s.publisherId));
    sig.connect();

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(async () => {
        const st = window.__state;
        if (st.connected && st.tracks.length > 0) {
          clearInterval(iv);
          let bytes = 0;
          try {
            const pc = wm.peerConnections.get(window.__subTo);
            if (pc) {
              const stats = await pc.getStats();
              stats.forEach((r) => { if (r.type === 'inbound-rtp') bytes += r.bytesReceived || 0; });
            }
          } catch {}
          resolve({ connected: true, tracks: st.tracks, bytesReceived: bytes });
        } else if (Date.now() - t0 > 30000) {
          clearInterval(iv);
          reject(new Error('timed out; states=' + JSON.stringify(st.states) +
            ' subTo=' + window.__subTo + ' msgs=' + JSON.stringify(window.__msgs)));
        }
      }, 500);
    });
  }, { wsUrl: toWs(SERVER_URL), room: ROOM_ID });

  console.log('PASS: WebRTC connected to Pi agent');
  console.log('  tracks:', JSON.stringify(result.tracks));
  console.log('  bytesReceived:', result.bytesReceived);
  if (result.tracks.length === 0) { console.error('FAIL: no remote track'); exitCode = 1; }
  if (result.bytesReceived === 0) { console.warn('WARN: connected but no media bytes yet'); }
} catch (err) {
  exitCode = 1;
  console.error('FAIL:', err.message);
  console.error('--- agent log tail ---');
  try { console.error(execSync(`tail -n 40 ${AGENT_LOG}`).toString()); } catch {}
  console.error('--- browser console ---');
  console.error(consoleBuf.slice(-40).join('\n'));
} finally {
  if (agent.pid) { try { agent.kill('SIGTERM'); } catch {} }
  if (browser) await browser.close();
}
process.exit(exitCode);
