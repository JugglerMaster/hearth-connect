import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { ConfigManager } from './ConfigManager';
import { ChannelManager } from './ChannelManager';
import { SignalingHandler } from './SignalingHandler';
import { Transport } from './types';

// ─── Config ────────────────────────────────────────────────

const PORT = parseInt(process.env.SERVER_PORT || '8090', 10);
const HTTP_PORT = parseInt(process.env.SERVER_HTTP_PORT || '80', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');
const TLS_ENABLED = process.env.TLS_ENABLED === 'true' || process.argv.includes('--tls');

// ─── State ─────────────────────────────────────────────────

const configManager = new ConfigManager(path.join(DATA_DIR, 'config.json'));
const channelManager = new ChannelManager();
channelManager.clearRecentlySeen();
const signalingHandler = new SignalingHandler(channelManager, configManager);

// ─── Express App ───────────────────────────────────────────

const app = express();
// No-cache for served assets so devices (e.g. iPad Safari) always pick up
// updated JS instead of serving a stale cached copy.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));
app.use(express.json());

// Health / status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    rooms: channelManager.getClientsInRoom('*').length,
    uptime: process.uptime(),
  });
});

// Generate camera URL with QR code for kiosk discovery
app.post('/api/server-url', (_req, res) => {
  const base = `${proto}://${_req.headers.host || 'localhost'}:${PORT}`;
  const cameraUrl = `${base}/monitor.html`;
  const serverUrl = base;

  // Generate QR code as base64 PNG (600px for easy scanning)
  QRCode.toDataURL(cameraUrl, { width: 600, margin: 4 }).then((dataUrl) => {
    res.json({ serverUrl, dataUrl });
  }).catch(() => {
    res.json({ serverUrl, dataUrl: null });
  });
});


// ─── Server Creation ───────────────────────────────────────

// Generate the self-signed TLS certs in CERT_DIR if they're missing. Mirrors
// deploy/gen-cert.sh: the CA is created once and reused on later launches (so
// iOS devices that already trust it don't need to re-install the profile), and
// the server cert's SAN covers localhost + 127.0.0.1 + the LAN IP(s) so devices
// reaching https://<lan-ip>:<port> don't trip a name-mismatch warning (which
// would otherwise force a fresh camera/mic permission prompt on every reload).
// Certs are per-deployment and never committed (see .gitignore).
function ensureCerts(): void {
  const caKey = path.join(CERT_DIR, 'ca.key');
  const caPem = path.join(CERT_DIR, 'ca.pem');
  const serverKey = path.join(CERT_DIR, 'server.key');
  const serverCrt = path.join(CERT_DIR, 'server.crt');

  if (fs.existsSync(serverCrt) && fs.existsSync(serverKey)) {
    return; // already have a server cert — no need to regenerate
  }

  // Make sure openssl is available before we try anything.
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    console.error(
      `[TLS] cert/key missing in ${CERT_DIR} and openssl is not available ` +
      'to generate them. Install openssl or run deploy/gen-cert.sh manually.'
    );
    process.exit(1);
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });

  // 1. CA — reuse if present, else create it.
  if (!fs.existsSync(caPem) || !fs.existsSync(caKey)) {
    console.log('[TLS] generating CA…');
    execFileSync('openssl', ['genrsa', '-out', caKey, '2048'], { stdio: 'ignore' });
    // CA extensions: mark it as a CA and grant the key-cert-sign usage. Without
    // a KeyUsage extension, strict TLS stacks (Python's ssl, used by the Pi
    // agent) reject the CA with "CA cert does not include key usage extension".
    const caExt = path.join(CERT_DIR, 'ca.ext');
    fs.writeFileSync(caExt,
      'basicConstraints=critical,CA:TRUE\n' +
      'keyUsage=critical,keyCertSign,cRLSign\n' +
      'subjectKeyIdentifier=hash\n');
    execFileSync('openssl', [
      'req', '-x509', '-new', '-nodes',
      '-key', caKey, '-sha256', '-days', '3650',
      '-out', caPem, '-subj', '/CN=HearthConnect CA/O=HearthConnect',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', 'subjectKeyIdentifier=hash',
    ], { stdio: 'ignore' });
    fs.rmSync(caExt, { force: true });
  } else {
    console.log('[TLS] reusing existing CA');
  }

  // 2. Server key + CSR.
  execFileSync('openssl', ['genrsa', '-out', serverKey, '2048'], { stdio: 'ignore' });
  const csr = path.join(CERT_DIR, 'server.csr');
  execFileSync('openssl', [
    'req', '-new', '-key', serverKey, '-out', csr,
    '-subj', '/CN=hearth.local/O=HearthConnect',
  ], { stdio: 'ignore' });

  // 3. SAN extension: domain + localhost + 127.0.0.1 + any extra IPs.
  // Auto-include the host's LAN IPv4 addresses so devices reaching
  // https://<lan-ip>:<port> don't trip a name-mismatch warning (which would
  // otherwise force a fresh camera/mic permission prompt on every reload, and
  // breaks strict TLS clients like the Pi agent). EXTRA_IPS appends more.
  const ext = path.join(CERT_DIR, 'server.ext');
  const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && !n.internal && n.family === 'IPv4')
    .map(n => n.address);
  const extraIps = (process.env.EXTRA_IPS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const allIps = [...new Set([...lanIps, ...extraIps])];
  let san = 'DNS.1=hearth.local\nDNS.2=localhost\nIP.1=127.0.0.1\n';
  allIps.forEach((ip, i) => { san += `IP.${i + 2}=${ip}\n`; });
  fs.writeFileSync(ext,
    'authorityKeyIdentifier=keyid,issuer\n' +
    'basicConstraints=CA:FALSE\n' +
    'keyUsage=digitalSignature,nonRepudiation,keyEncipherment,dataEncipherment\n' +
    'subjectAltName=@alt_names\n\n[alt_names]\n' + san);

  // 4. Sign with the CA.
  execFileSync('openssl', [
    'x509', '-req', '-in', csr, '-CA', caPem, '-CAkey', caKey,
    '-CAcreateserial', '-out', serverCrt, '-days', '365',
    '-sha256', '-extfile', ext,
  ], { stdio: 'ignore' });

  fs.rmSync(csr, { force: true });
  fs.rmSync(ext, { force: true });
  console.log(`[TLS] generated server cert in ${CERT_DIR}`);
}

function createServer(): http.Server | https.Server {
  if (TLS_ENABLED) {
    ensureCerts();

    const certPath = path.join(CERT_DIR, 'server.crt');
    const keyPath = path.join(CERT_DIR, 'server.key');

    const credentials: https.ServerOptions = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      // Force TLS 1.2: iOS 12 Safari's WebSocket stack drops WSS connections
      // (close code 1006) once the session negotiates to TLS 1.3, even though
      // the TLS 1.3 handshake itself succeeds. TLS 1.2 is handled reliably by
      // old WebKit, and all modern clients still support it.
      minVersion: 'TLSv1.2',
      maxVersion: 'TLSv1.2',
    };

    return https.createServer(credentials, app);
  }

  return http.createServer(app);
}

const server = createServer();

// ─── WebSocket ─────────────────────────────────────────────

// perMessageDeflate disabled: older WebKit (iOS ≤12 Safari) closes the socket
// as soon as it receives a compressed frame, breaking signaling on those devices.
const wss = new WebSocketServer({ server, perMessageDeflate: false });

// Wrap a raw WebSocket as a Transport for modern clients.
function makeWsTransport(ws: WebSocket): Transport {
  const connId = randomUUID();
  return {
    connId,
    send(msg: object) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
      }
    },
    close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

wss.on('connection', (ws: WebSocket) => {
  const transport = makeWsTransport(ws);
  channelManager.registerTransport(transport);
  ws.on('message', (raw: Buffer) => {
    signalingHandler.handle(transport, raw.toString());
  });
  ws.on('close', (code: number, reason: Buffer) => {
    console.log('[WS] client closed — code=' + code + ' reason=' + reason.toString());
    signalingHandler.handleDisconnect(transport);
  });
  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    signalingHandler.handleDisconnect(transport);
  });
});

// ─── Legacy iOS (≤12) signaling via SSE (downstream) + fetch POST (upstream) ──
// iOS 12's WebSocket implementation is unreliable (closes with code 1006), so
// legacy clients use Server-Sent Events for server→client and HTTPS POST for
// client→server, both of which old WebKit handles robustly.

// SSE stream: GET /api/events?connId=<id>  (server → client)
app.get('/api/events', (req, res) => {
  const connId = String(req.query.connId || '');
  if (!connId) { res.status(400).end(); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const transport: Transport = {
    connId,
    send(msg: object) {
      try { res.write('data: ' + JSON.stringify(msg) + '\n\n'); } catch { /* ignore */ }
    },
    close() {
      try { res.end(); } catch { /* ignore */ }
    },
  };
  channelManager.registerTransport(transport);

  // Heartbeat comment to keep proxies from dropping the stream
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* ignore */ } }, 15000);

  req.on('close', () => {
    clearInterval(ka);
    console.log('[SSE] client closed — connId=' + connId);
    signalingHandler.handleDisconnect(transport);
  });
});

// Client → server messages: POST /api/signal  { connId, type, payload }
app.post('/api/signal', express.json(), (req, res) => {
  const { connId, type, payload } = req.body || {};
  if (!connId || !type) { res.status(400).json({ ok: false, error: 'connId and type required' }); return; }
  const transport = channelManager.getTransport(String(connId));
  if (!transport) { res.status(404).json({ ok: false, error: 'unknown connId' }); return; }
  signalingHandler.handle(transport, JSON.stringify({ type, payload }));
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────

const proto = TLS_ENABLED ? 'https' : 'http';

if (!TLS_ENABLED) {
  // HTTP only
  server.listen(PORT, () => {
    console.log(`Hearth-Connect server running at http://localhost:${PORT}`);
  });
} else {
  // HTTPS on main port, HTTP redirect on secondary port
  server.listen(PORT, () => {
    console.log(`Hearth-Connect server running at https://0.0.0.0:${PORT}`);
    console.log('[TLS] min/max version forced to TLSv1.2 (legacy WebKit WSS compat)');
    console.log('[WS] perMessageDeflate disabled (legacy WebKit WSS compat)');
  });

  // Optional HTTP redirect server (non-fatal if port unavailable)
  const httpApp = express();
  httpApp.use((req, res) => {
    const host = req.headers.host?.replace(/:\d+$/, '') || 'localhost';
    res.redirect(`https://${host}:${PORT}${req.url}`);
  });
  const httpServer = http.createServer(httpApp);
  httpServer.on('error', () => {
    console.log(`Skipping HTTP redirect (port ${HTTP_PORT} unavailable)`);
  });
  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP redirect (→ HTTPS) on port ${HTTP_PORT}`);
  });
}

// ─── Graceful Shutdown ─────────────────────────────────────

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  configManager.dispose();
  wss.close();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  configManager.dispose();
  wss.close();
  server.close();
  process.exit(0);
});
