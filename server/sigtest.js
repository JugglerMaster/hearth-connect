const WebSocket = require('ws');
const URL = 'wss://localhost:8090';
const opts = { rejectUnauthorized: false };
const kioskWs = new WebSocket(URL, opts);
let kioskId = 'test-kiosk-' + Date.now();
let baseId = 'test-base-' + Date.now();
let kioskSourceId = null;
const receivedByBase = [];
function send(ws, type, payload) { ws.send(JSON.stringify({ type, payload })); }
kioskWs.on('open', () => send(kioskWs, 'JOIN_ROOM', { roomId: 'default', deviceId: kioskId, deviceType: 'kiosk', label: 'TestKiosk' }));
kioskWs.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'WELCOME') {
    kioskId = msg.payload.deviceId;
    kioskSourceId = 'cam-' + Date.now();
    send(kioskWs, 'PUBLISH_SOURCE', { sourceId: kioskSourceId, label: 'TestKiosk', type: 'video+audio' });
    setTimeout(connectBase, 800);
  } else if (msg.type === 'SUBSCRIBER_JOINED') {
    const fakeSdp = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n' };
    send(kioskWs, 'OFFER', { to: msg.payload.subscriberId, sdp: fakeSdp, from: kioskId });
  } else if (msg.type === 'ANSWER') {
    console.log('[OK] signaling relay intact (OFFER kiosk->base, ANSWER base->kiosk)');
    process.exit(0);
  } else if (msg.type === 'ERROR') { console.log('[kiosk] ERROR:', JSON.stringify(msg.payload)); }
});
function connectBase() {
  const baseWs = new WebSocket(URL, opts);
  baseWs.on('open', () => send(baseWs, 'JOIN_ROOM', { roomId: 'default', deviceId: baseId, deviceType: 'base', label: 'TestBase' }));
  baseWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'WELCOME') {
      const src = msg.payload.sources.find(s => s.publisherId === kioskId);
      if (src) { send(baseWs, 'SUBSCRIBE_SOURCE', { publisherId: kioskId }); }
    } else if (msg.type === 'OFFER') {
      receivedByBase.push(msg);
      const fakeAnswer = { type: 'answer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n' };
      send(baseWs, 'ANSWER', { to: msg.payload.from, sdp: fakeAnswer, from: baseId });
    } else if (msg.type === 'ERROR') { console.log('[base] ERROR:', JSON.stringify(msg.payload)); }
  });
}
setTimeout(() => { console.log('TIMEOUT. Received by base:', receivedByBase.length); process.exit(1); }, 10000);
