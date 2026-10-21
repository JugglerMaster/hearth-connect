import { chromium } from 'playwright';

const SERVER_URL = process.env.SERVER_URL || 'https://192.168.1.103:8090';
const ROOM = 'default';
const TIMEOUT_MS = 45000;

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
  await page.goto(SERVER_URL + '/interop-harness.html');

  const result = await page.evaluate(async ({ room }) => {
    const sig = new SignalingClient();
    sig.deviceType = 'base';
    sig.deviceLabel = 'bcast-repro';
    const wm = new WebRTCManager(sig);
    window.__dbg = { subscribed: [], pcStates: [], iceStates: [], connected: false,
                     tracks: [], msgs: [] };
    sig.on('message', m => { if (window.__dbg.msgs.length < 400) window.__dbg.msgs.push(m.type); });

    let publishedId = null;
    const start = () => {
      if (publishedId) return;
      publishedId = 'broadcast-repro-' + Date.now();
      sig.broadcastSource(publishedId, 'Repro FaceTalk', 'video+audio', 'all');
    };
    sig.on('open', () =>
      sig.joinRoom(room, 'bcast-repro-' + Math.random().toString(16).slice(2), {}));
    sig.on('welcome', start);

    sig.on('subscriberJoined', async (d) => {
      if (!d.isBroadcast) return;
      const kid = d.subscriberId;
      window.__dbg.subscribed.push(kid);
      const pc = wm.createBroadcastPeerConnection(kid);
      pc.onconnectionstatechange = () => {
        window.__dbg.pcStates.push(pc.connectionState);
        if (pc.connectionState === 'connected') window.__dbg.connected = true;
      };
      pc.oniceconnectionstatechange = () =>
        window.__dbg.iceStates.push(pc.iceConnectionState);
      pc.ontrack = e => window.__dbg.tracks.push({ kind: e.track.kind });
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
      } catch (e) { window.__dbg.gumErr = e.message; }
    });

    sig.connect();

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(async () => {
        let bytes = -1;
        if (window.__dbg.subscribed.length) {
          try {
            const pc = wm.broadcastPcs.get(window.__dbg.subscribed[0]);
            if (pc && pc.connectionState === 'connected') {
              const stats = await pc.getStats();
              stats.forEach(r => { if (r.type === 'inbound-rtp') bytes += (r.bytesReceived || 0); });
            }
          } catch {}
        }
        if (window.__dbg.connected && bytes > 0) {
          clearInterval(iv);
          resolve({ ...window.__dbg, mediaBytes: bytes });
        } else if (Date.now() - t0 > 45000) {
          clearInterval(iv);
          reject(new Error('timeout ' + JSON.stringify(window.__dbg)));
        }
      }, 600);
    });
  }, { room: ROOM });

  console.log('PASS: live broadcast path end-to-end (ICE connected + media bytes)');
  console.log('  dbg:', JSON.stringify(result));
} catch (err) {
  console.error('FAIL:', err.message);
  console.error('--- browser console ---');
  console.error(buf.slice(-60).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}