"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const express_1 = __importDefault(require("express"));
const ws_1 = require("ws");
const qrcode_1 = __importDefault(require("qrcode"));
const ConfigManager_1 = require("./ConfigManager");
const ChannelManager_1 = require("./ChannelManager");
const SignalingHandler_1 = require("./SignalingHandler");
// ─── Config ────────────────────────────────────────────────
const PORT = parseInt(process.env.SERVER_PORT || '8090', 10);
const HTTP_PORT = parseInt(process.env.SERVER_HTTP_PORT || '80', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');
const TLS_ENABLED = process.env.TLS_ENABLED === 'true' || process.argv.includes('--tls');
// ─── State ─────────────────────────────────────────────────
const configManager = new ConfigManager_1.ConfigManager(path.join(DATA_DIR, 'config.json'));
const channelManager = new ChannelManager_1.ChannelManager();
channelManager.clearRecentlySeen();
const signalingHandler = new SignalingHandler_1.SignalingHandler(channelManager, configManager);
// ─── Express App ───────────────────────────────────────────
const app = (0, express_1.default)();
app.use(express_1.default.static(path.join(__dirname, '..', 'public')));
app.use(express_1.default.json());
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
    const cameraUrl = `${base}/camera.html`;
    const serverUrl = base;
    // Generate QR code as base64 PNG (600px for easy scanning)
    qrcode_1.default.toDataURL(cameraUrl, { width: 600, margin: 4 }).then((dataUrl) => {
        res.json({ serverUrl, dataUrl });
    }).catch(() => {
        res.json({ serverUrl, dataUrl: null });
    });
});
// ─── Server Creation ───────────────────────────────────────
function createServer() {
    if (TLS_ENABLED) {
        const certPath = path.join(CERT_DIR, 'server.crt');
        const keyPath = path.join(CERT_DIR, 'server.key');
        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
            console.error(`TLS enabled but cert/key not found in ${CERT_DIR}/. ` +
                'Run deploy/gen-cert.sh to generate them, or start without --tls.');
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
const wss = new ws_1.WebSocketServer({ server });
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
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
}
else {
    // HTTPS on main port, HTTP redirect on secondary port
    server.listen(PORT, () => {
        console.log(`Hearth-Connect server running at https://0.0.0.0:${PORT}`);
    });
    // Optional HTTP redirect server (non-fatal if port unavailable)
    const httpApp = (0, express_1.default)();
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
//# sourceMappingURL=index.js.map