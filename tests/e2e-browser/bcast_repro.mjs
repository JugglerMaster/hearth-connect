import { chromium } from 'playwright';

const SERVER_URL = process.env.SERVER_URL || 'https://192.168.1.103:8090';
const ROOM = 'default';
const TIMEOUT_MS = 40000;

const browser = await chromium.launch({
  args: [
    '--ignore-certificate-errors',
    '--disable-features=LocalNetworkAccess',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage();
const buf = [];
page.on('console', m => buf.push(`[c.${m.type()}] ${m.text()}`));
page.on('pageerror', e => buf.push(`[pageerror] ${e.message}`));

try {
  const navUrl = SERVER_URL + '/interop-harness.html';
  await page.goto(navUrl);

  const result = await page.evaluate(async ({ room }) => {
    const sig = new SignalingClient();
    sig.deviceType = 'base';
    sig.deviceLabel = 'bcast-repro';
    const wm = new WebRTCManager(sig);
    window.__msgs = [];
    sig.on('message', m => window.__msgs.push(m.type + ':' + (m.isBroadcast ? 'B' : 'n')));
    window.__dbg = { subscribed: [], offered: false, answered: false, answerIsBroadcast: null, error: null };

    let publishedId = null;
    const start = () => {
      if (publishedId) return;
      publishedId = 'broadcast-repro-' + Date.now();
      sig.broadcastSource(publishedId, 'Repro FaceTalk', 'video+audio', 'all');
    };
    sig.on('open', () => {
      sig.joinRoom(room, 'bcast-repro-' + Math.random().toString(16).slice(2), {});
    });
    sig.on('welcome', start);

    sig.on('subscriberJoined', async (d) => {
      if (!d.isBroadcast) return;
      const kid = d.subscriberId;
      window.__dbg.subscribed.push(kid);
      // Get a real audio track (fake device in Chromium).
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) { window.__dbg.error = 'gum:' + e.message; return; }
      const pc = wm.createBroadcastPeerConnection(kid);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      window.__dbg.offGum = true;
    });

    // Wiring from webrtc.js sendOffer path — broadcast offers carry isBroadcast.
    window.__answerSeen = false;
    sig.on('answer', (d) => {
      if (d.isBroadcast) {
        window.__dbg.answered = true;
        window.__dbg.answerIsBroadcast = true;
      }
    });

    sig.connect();

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        // Published, Pi subscribed, offer sent, Pi answered broadcast.
        if (window.__dbg.subscribed.length > 0 && window.__dbg.answered) {
          clearInterval(iv);
          resolve(window.__dbg);
        } else if (Date.now() - t0 > TIMEOUT_MS) {
          clearInterval(iv);
          reject(new Error('timeout dbg=' + JSON.stringify(window.__dbg) +
            ' msgs=' + JSON.stringify(window.__msgs).slice(0, 500)));
        }
      }, 500);
    });
  }, { room: ROOM });

  console.log('PASS: broadcast offer/answer completed (browser side)');
  console.log('  dbg:', JSON.stringify(result));
} catch (err) {
  console.error('FAIL:', err.message);
  console.error('--- browser console ---');
  console.error(buf.slice(-50).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}