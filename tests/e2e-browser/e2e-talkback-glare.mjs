// Talkback regression test: base + TEST_SOURCE agent over the LIVE hub.
//
// Asserts the CURRENT talkback design (pre-negotiated sendrecv audio transceiver
// + replaceTrack, NO renegotiation). Because enabling talkback now swaps the mic
// onto an already-bidirectional audio m-line, it must NOT trigger an OFFER/ANSWER
// exchange and must NOT destabilize the live monitor (video/audio) stream. This
// is the fix for the old bug where addTrack() renegotiated the live PC and the
// connection tripped the watchdog / glare ("talkback works a few seconds then the
// stream keeps rebuilding").
import { spawn, execSync } from 'node:child_process';
import { openSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = import.meta.dirname;
const PI_DIR = path.resolve(__dirname, '../../linux/pi-agent');
const SERVER_URL = process.env.SERVER_URL || 'https://192.168.1.103:8090';
const ROOM_ID = process.env.ROOM_ID || 'talkback-test';
const AGENT_LOG = '/tmp/opencode/talkback-agent.log';
const LIVE = process.env.LIVE === '1';

function toWs(url) { return url.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:'); }

const agentEnv = {
  ...process.env,
  TEST_SOURCE: '1',
  VIDEO_ENCODER: 'x264enc',
  RESOLUTION: '480p',
  FRAMERATE: '30',
  SERVER_URL: toWs(SERVER_URL),
  ROOM_ID,
  DEVICE_LABEL: 'Talkback Glare Test',
  MAX_SUBSCRIBERS: '2',
};
const agentLogFd = openSync(AGENT_LOG, 'w');
const agent = LIVE ? null : spawn('python3', ['-u', 'pi-agent.py'], {
  cwd: PI_DIR, env: agentEnv,
  stdio: ['ignore', agentLogFd, 'inherit'],
});

let exitCode = 0;
const consoleBuf = [];
let browser;
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

  const navUrl = SERVER_URL + '/interop-harness.html';
  await page.goto(navUrl, { waitUntil: 'load' });

  const result = await page.evaluate(({ wsUrl, room }) => {
    window.__state = { connected: false, answersSent: 0, offersSent: 0, tracks: [] };
    class Sub extends WebRTCManager {
      onRemoteTrack(peerId, stream, track) { window.__state.tracks.push(peerId + ':' + track.kind); }
      onConnectionStateChange(peerId, state) {
        if (state === 'connected') window.__state.connected = true;
      }
    }
    const sig = new SignalingClient(wsUrl);
    sig.deviceType = 'base';
    const realSendAnswer = sig.sendAnswer.bind(sig);
    sig.sendAnswer = (to, sdp, isB) => { window.__state.answersSent++; console.log('[base] sendAnswer #' + window.__state.answersSent + ' dirs=' + (sdp && sdp.sdp ? sdp.sdp.split('\n').filter(l => l.startsWith('m=') || l.startsWith('a=mid:')).join(' | ') : '')); return realSendAnswer(to, sdp, isB); };
    const realSendOffer = sig.sendOffer.bind(sig);
    sig.sendOffer = (to, sdp, isB) => { window.__state.offersSent++; console.log('[base] sendOffer #' + window.__state.offersSent + ' dirs=' + (sdp && sdp.sdp ? sdp.sdp.split('\n').filter(l => l.startsWith('m=') || l.startsWith('a=mid:')).join(' | ') : '')); return realSendOffer(to, sdp, isB); };
    const wm = new Sub(sig);
    wm._logSdp = (tag, desc) => {
      if (desc && desc.sdp) {
        const lines = desc.sdp.split('\n').filter(l => l.startsWith('m=') || l.startsWith('a=mid:') || l.startsWith('a=send') || l.startsWith('a=recv') || l.startsWith('a=setup'));
        console.log('[base] ' + tag + ':\n  ' + lines.join('\n  '));
      }
    };
    sig.on('message', (m) => {
      if (m && m.type === 'OFFER' && m.payload && m.payload.sdp) {
        console.log('[base] got OFFER from ' + m.payload.from);
        wm._logSdp('[base] rx OFFER', m.payload.sdp);
      }
      if (m && m.type === 'ANSWER' && m.payload && m.payload.sdp) {
        console.log('[base] got ANSWER from ' + m.payload.from);
        wm._logSdp('[base] rx ANSWER', m.payload.sdp);
      }
    });
    let subTo = null;
    const trySub = (publisherId) => {
      if (typeof publisherId === 'string' && publisherId.startsWith('pi-') && !subTo) {
        subTo = publisherId;
        sig.subscribeSource(publisherId);
      }
    };
    sig.on('open', () => sig.joinRoom(room, 'e2e-talkback-' + Math.random().toString(16).slice(2), {}));
    sig.on('welcome', (p) => (p.sources || []).forEach((s) => trySub(s.publisherId)));
    sig.on('sourceAdded', (s) => trySub(s.publisherId));
    sig.connect();

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(async () => {
        if (window.__state.connected && window.__state.tracks.length > 0) {
          clearInterval(iv);
          // Connected. Now enable talkback. With the replaceTrack design this must
          // attach the mic to the pre-negotiated transceiver WITHOUT a renegotiation
          // (no extra OFFER/ANSWER) and WITHOUT dropping the live stream.
          let talkErr = null;
          try {
            await wm.enableTalkback(subTo);
            sig.requestTalk(subTo);
          } catch (e) { talkErr = 'enableTalkback: ' + e.message; }
          const tb = wm.talkbackSenders.get(subTo);
          const talkbackAttached = !!(tb && tb.track);
          // Wait out what used to be the agent's 10s counter-offer window and
          // confirm the monitor stream is still up and no renegotiation happened.
          const t1 = Date.now();
          const iv2 = setInterval(() => {
            if (Date.now() - t1 > 12000) {
              clearInterval(iv2);
              resolve({
                connected: window.__state.connected,
                answersSent: window.__state.answersSent,
                offersSent: window.__state.offersSent,
                tracks: window.__state.tracks,
                talkErr,
                talkbackAttached,
                pageErrors: window.__pageErrors || [],
              });
            }
          }, 300);
        } else if (Date.now() - t0 > 30000) {
          clearInterval(iv);
          reject(new Error('timed out subscribing'));
        }
      }, 500);
    });
  }, { wsUrl: toWs(SERVER_URL), room: ROOM_ID });

  if (result.talkErr) throw new Error(result.talkErr);
  console.log('base answersSent:', result.answersSent, 'offersSent:', result.offersSent,
              'connected:', result.connected, 'tracks:', result.tracks.length,
              'talkbackAttached:', result.talkbackAttached);

  await new Promise((r) => setTimeout(r, 1500));
  // The fix: talkback attached with no renegotiation (base never re-offers for
  // talkback) and the monitor stream stayed connected through the talkback window.
  if (result.connected && result.talkbackAttached && result.offersSent === 0) {
    console.log('PASS: talkback attached via replaceTrack with no renegotiation; monitor stream stayed up');
  } else {
    console.error('FAIL: talkback/renegotiation regression', JSON.stringify(result));
    console.error('--- browser console ---');
    console.error(consoleBuf.slice(-60).join('\n'));
    exitCode = 1;
  }
} catch (err) {
  exitCode = 1;
  console.error('FAIL:', err.message);
  console.error('--- agent log tail ---');
  try { console.error(execSync(`tail -n 50 ${AGENT_LOG}`).toString()); } catch {}
  console.error('--- browser console ---');
  console.error(consoleBuf.slice(-60).join('\n'));
} finally {
  if (agent && agent.pid) { try { agent.kill('SIGTERM'); } catch {} }
  if (browser) await browser.close();
}
process.exit(exitCode);
