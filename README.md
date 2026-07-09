# Hearth-Connect

HTML5 video intercom / baby monitor system. Runs on iPads/iPhones via Safari. Self-hosted.

## How It Works

### Architecture

- **Server**: Single Node.js + TypeScript process serving static files + WebSocket signaling
- **Streaming**: WebRTC P2P (sub-500ms latency, two-way audio)
- **Storage**: JSON file (no database dependency)
- **Transport**: HTTPS + WSS with self-signed certificates

### Pages

| Page | URL | Purpose |
|------|-----|---------|
| **Landing** | `/` | Page selector (Kiosk or Base Station) |
| **Base Station** | `/base-station.html` | Full control hub — create rooms, monitor kiosks, configure cameras |
| **Kiosk** | `/camera.html` | Camera device — broadcasts video/audio to base station |

### Device Discovery

1. **Base Station** creates a room and shows a QR code with the server URL
2. **Kiosk** scans the QR code (opens `camera.html?room=<roomName>`) or manually enters the room name
3. Both connect to the server via WebSocket and join the same room via `JOIN_ROOM` messages
4. No pairing tokens needed — the QR code just shares the server URL

### Monitoring Flow

1. **Kiosk** connects, joins the room, captures camera via `getUserMedia`, and publishes its media source
2. **Base Station** sees the kiosk in the device list and clicks **Monitor**
3. Base station sends `SUBSCRIBE_SOURCE` → server relays `SUBSCRIBER_JOINED` to kiosk
4. **Kiosk** creates a send `RTCPeerConnection` and offers its camera stream
5. **Base Station** creates a recv `RTCPeerConnection`, answers, and displays the video

## Quick Start

```bash
# Install dependencies
cd server && npm install

# Start without TLS (localhost only — getUserMedia works via localhost)
npm start

# Start with TLS (requires self-signed certs)
npm run gen-cert
npm run start:tls
```

Open `http://localhost:8090` on your base station device, create a room, and click **Add Kiosk** to show the QR code. Scan it on your kiosk device to connect.

## Development

```bash
npm run dev    # TypeScript watch + auto-restart
```

## Deployment

```bash
docker compose up -d
```
