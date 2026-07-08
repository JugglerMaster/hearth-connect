import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { ConfigManager } from './ConfigManager';
import { ChannelManager } from './ChannelManager';
import { SignalingHandler } from './SignalingHandler';

// ─── Config ────────────────────────────────────────────────

const PORT = parseInt(process.env.SERVER_PORT || '8080', 10);
const HTTP_PORT = parseInt(process.env.SERVER_HTTP_PORT || '80', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');
const TLS_ENABLED = process.env.TLS_ENABLED === 'true' || process.argv.includes('--tls');

// ─── State ─────────────────────────────────────────────────

const configManager = new ConfigManager(path.join(DATA_DIR, 'config.json'));
const channelManager = new ChannelManager();
const signalingHandler = new SignalingHandler(channelManager, configManager);

// ─── Express App ───────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

// Health / status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    rooms: channelManager.getClientsInRoom('*').length,
    uptime: process.uptime(),
  });
});

// ─── Server Creation ───────────────────────────────────────

function createServer(): http.Server | https.Server {
  if (TLS_ENABLED) {
    const certPath = path.join(CERT_DIR, 'server.crt');
    const keyPath = path.join(CERT_DIR, 'server.key');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(
        `TLS enabled but cert/key not found in ${CERT_DIR}/. ` +
        'Run deploy/gen-cert.sh to generate them, or start without --tls.'
      );
      process.exit(1);
    }

    const credentials = {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    };

    return https.createServer(credentials, app);
  }

  return http.createServer(app);
}

const server = createServer();

// ─── WebSocket ─────────────────────────────────────────────

const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw: Buffer) => {
    signalingHandler.handle(ws, raw.toString());
  });

  ws.on('close', () => {
    signalingHandler.handleDisconnect(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    signalingHandler.handleDisconnect(ws);
  });
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
  });

  // Optional HTTP redirect server
  const httpApp = express();
  httpApp.use((req, res) => {
    const host = req.headers.host?.replace(/:\d+$/, '') || 'localhost';
    res.redirect(`https://${host}:${PORT}${req.url}`);
  });
  http.createServer(httpApp).listen(HTTP_PORT, () => {
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
