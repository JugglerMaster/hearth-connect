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
import Bonjour from 'bonjour-service';
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
const MDNS_ENABLED = process.env.MDNS_DISABLED !== 'true'; // enabled by default

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

// Generate / refresh the self-signed TLS certs in CERT_DIR.
//
// The CA is created once and reused on every launch (so iOS devices that
// already trust it never need to re-install the profile). The *server* cert's
// SAN covers localhost + 127.0.0.1 + the host's current LAN IPv4(s) + EXTRA_IPS
// so devices reaching https://<lan-ip>:<port> don't trip a name-mismatch
// warning (which would otherwise force a fresh camera/mic permission prompt on
// every reload, and breaks strict TLS clients like the Pi agent).
//
// Because the LAN IP — and even the whole subnet — can change (the box moves
// between Wi-Fi networks, or picks up a new DHCP lease while traveling), the
// server cert is re-issued on launch whenever the current IP set isn't already
// covered by the existing cert. The CA is left untouched, so the iPhone's trust
// of the profile survives the refresh. Certs are per-deployment and never
// committed (see .gitignore).
function ensureCerts(): void {
  const caKey = path.join(CERT_DIR, 'ca.key');
  const caPem = path.join(CERT_DIR, 'ca.pem');
  const serverKey = path.join(CERT_DIR, 'server.key');
  const serverCrt = path.join(CERT_DIR, 'server.crt');

  // 1. IPs the server cert must cover right now (Wi-Fi + Ethernet + EXTRA_IPS).
  const desiredIps = computeLanIps();

  // 2. Keep the existing server cert if it's present and already covers every
  //    current IP. This avoids daily churn while auto-healing after an IP /
  //    subnet change. (certCoversIps is lenient if openssl can't be probed, so
  //    an existing cert is never needlessly invalidated.)
  const serverCertCurrent =
    fs.existsSync(serverCrt) && fs.existsSync(serverKey) &&
    certCoversIps(serverCrt, desiredIps);

  if (serverCertCurrent) {
    console.log(`[TLS] server cert current — covers ${listIps(desiredIps)}`);
    return;
  }

  // 3. We need to (re)generate → openssl is now required.
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    console.error(
      `[TLS] a cert covering ${listIps(desiredIps)} is required but openssl ` +
      'is not available to generate it. Install openssl or run docker/gen-cert.sh manually.'
    );
    process.exit(1);
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });

  // 4. CA — create once, then reuse forever (stable iOS trust).
  ensureCa(caPem, caKey);

  // 5. Fresh server key + cert signed by the CA, covering the current IPs.
  generateServerCert(caPem, caKey, serverKey, serverCrt, desiredIps);
}

// The host's non-internal IPv4 addresses (Wi-Fi, Ethernet, …) plus any
// operator-supplied EXTRA_IPS, de-duplicated.
function computeLanIps(): string[] {
  const lanIps = Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && !n.internal && n.family === 'IPv4')
    .map(n => n.address);
  const extraIps = (process.env.EXTRA_IPS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...lanIps, ...extraIps])];
}

function listIps(ips: string[]): string {
  return ips.length ? ips.join(', ') : '(no LAN IPs)';
}

// True if every IP in `desired` is already present in the cert's SAN. Extra
// SAN entries the cert happens to carry are fine — we only require coverage.
// Returns true if `desired` is empty, or if openssl can't be probed (lenient:
// never invalidate an existing cert we can't re-create anyway).
function certCoversIps(crtPath: string, desired: string[]): boolean {
  if (desired.length === 0) return true;
  let san: string;
  try {
    san = execFileSync('openssl', ['x509', '-in', crtPath, '-noout', '-ext', 'subjectAltName'],
      { encoding: 'utf8' });
  } catch {
    return true;
  }
  const certIps = new Set(
    san.split('\n')
      .flatMap(line => line.split(','))
      .map(s => s.trim())
      .filter(s => s.startsWith('IP Address:'))
      .map(s => s.slice('IP Address:'.length).trim())
  );
  return desired.every(ip => certIps.has(ip));
}

// Create the CA once. Idempotent — no-ops if both files already exist.
function ensureCa(caPem: string, caKey: string): void {
  if (fs.existsSync(caPem) && fs.existsSync(caKey)) {
    console.log('[TLS] reusing existing CA');
    return;
  }
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
}

// Generate a fresh server key + cert signed by the CA, covering `ips`.
function generateServerCert(
  caPem: string, caKey: string, serverKey: string, serverCrt: string, ips: string[],
): void {
  // Fresh server key each time (cheap — the cert is what clients validate).
  execFileSync('openssl', ['genrsa', '-out', serverKey, '2048'], { stdio: 'ignore' });
  const csr = path.join(CERT_DIR, 'server.csr');
  execFileSync('openssl', [
    'req', '-new', '-key', serverKey, '-out', csr,
    '-subj', '/CN=hearth.local/O=HearthConnect',
  ], { stdio: 'ignore' });

  // SAN: domain + localhost + 127.0.0.1 + the current LAN IP(s).
  const ext = path.join(CERT_DIR, 'server.ext');
  let san = 'DNS.1=hearth.local\nDNS.2=localhost\nIP.1=127.0.0.1\n';
  ips.forEach((ip, i) => { san += `IP.${i + 2}=${ip}\n`; });
  fs.writeFileSync(ext,
    'authorityKeyIdentifier=keyid,issuer\n' +
    'basicConstraints=CA:FALSE\n' +
    'keyUsage=digitalSignature,nonRepudiation,keyEncipherment,dataEncipherment\n' +
    'subjectAltName=@alt_names\n\n[alt_names]\n' + san);

  // Sign with the CA.
  execFileSync('openssl', [
    'x509', '-req', '-in', csr, '-CA', caPem, '-CAkey', caKey,
    '-CAcreateserial', '-out', serverCrt, '-days', '365',
    '-sha256', '-extfile', ext,
  ], { stdio: 'ignore' });

  fs.rmSync(csr, { force: true });
  fs.rmSync(ext, { force: true });
  console.log(`[TLS] (re)generated server cert covering ${listIps(ips)} in ${CERT_DIR}`);
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

// ─── mDNS / Bonjour Service ────────────────────────────────
// Publish a _hearth-connect._tcp.local service so Pi agents on the same LAN
// can discover the server automatically (no manual SERVER_URL needed).

let bonjour: Bonjour | null = null;

function publishMdns(): void {
  if (!MDNS_ENABLED) {
    console.log('[mDNS] disabled (MDNS_DISABLED=true)');
    return;
  }

  const lanIps = computeLanIps();
  const ip = lanIps[0] || '127.0.0.1';
  const wsProto = TLS_ENABLED ? 'wss' : 'ws';
  const serverUrl = `${wsProto}://${ip}:${PORT}`;

  bonjour = new Bonjour();
  bonjour.publish({
    name: 'Hearth-Connect',
    type: 'hearth-connect',
    protocol: 'tcp',
    port: PORT,
    txt: {
      serverUrl,
      roomId: 'default',
      label: 'Hearth-Connect Server',
    },
  });

  console.log(`[mDNS] published _hearth-connect._tcp — ${serverUrl}`);
}

function unpublishMdns(): void {
  if (bonjour) {
    bonjour.unpublishAll();
    bonjour.destroy();
    bonjour = null;
  }
}

// ─── Start ─────────────────────────────────────────────────

const proto = TLS_ENABLED ? 'https' : 'http';

if (!TLS_ENABLED) {
  // HTTP only
  server.listen(PORT, () => {
    console.log(`Hearth-Connect server running at http://localhost:${PORT}`);
    publishMdns();
  });
} else {
  // HTTPS on main port, HTTP redirect on secondary port
  server.listen(PORT, () => {
    console.log(`Hearth-Connect server running at https://0.0.0.0:${PORT}`);
    console.log('[TLS] min/max version forced to TLSv1.2 (legacy WebKit WSS compat)');
    console.log('[WS] perMessageDeflate disabled (legacy WebKit WSS compat)');
    publishMdns();
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
  unpublishMdns();
  configManager.dispose();
  wss.close();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  unpublishMdns();
  configManager.dispose();
  wss.close();
  server.close();
  process.exit(0);
});
