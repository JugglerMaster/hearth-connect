# Hearth-Connect

HTML5 video intercom / baby monitor system. Runs on iPads/iPhones via Safari. Self-hosted.

## Requirements

- **iOS 11+** (iOS 9.3.5 and earlier are **not supported** — WebRTC requires iOS 11+)
- Safari (or any WebKit-based browser on iOS)
- Self-hosted server with HTTPS (self-signed certs work; install CA profile on iOS)
- Docker (recommended) or Node.js 20+

## Features

### Core Streaming
- **WebRTC P2P mesh** — sub-500ms latency, two-way audio
- **Multi-publisher rooms** — multiple camera devices per room
- **Per-source subscription** — base station watches one feed at a time
- **Source types**: `video+audio`, `video-only`, `audio-only`, `none`

### Device Roles
| Role | Page | Purpose |
|------|------|---------|
| **Base Station** | `/base-station.html` | Control hub: create rooms, monitor feeds, configure all cameras |
| **Kiosk (Camera)** | `/camera.html` | Thin client — broadcasts video/audio, minimal UI, auto-reconnects |

### Discovery & Pairing
- **QR code pairing** — base station generates QR with server URL; kiosk scans to join
- **No pairing tokens** — direct room join via WebSocket
- **Persistent device IDs** — stored in localStorage, auto-reconnect on reload
- **24-hour device history** — base station shows recently seen devices (even offline)

### Base Station Features
- **Live device list** — shows online/offline status, last seen, audio level (dB)
- **Audio alerts** — configurable threshold (dB) with hysteresis; visual alert badge
- **Monitor modes** — `Video` (full video+audio) or `Audio-only` (background listening)
- **Volume control** — 0–200% gain (slider persisted in localStorage)
- **Grid layout** — `1×1` or `2×2` multi-view (planned)
- **Audio focus** — `manual` (one at a time) or `last-active` mode
- **Idle timeout** — auto-stop monitor after inactivity
- **Watch recovery** — auto-reconnects if stream stalls (8s dead → ICE restart → 10s timeout)

### Camera (Kiosk) Features
| Setting | Options / Range |
|---------|-----------------|
| Camera | Front / Rear |
| Resolution | 480p / 720p / 1080p |
| Frame rate | 15 / 24 / 30 fps |
| Night mode | On / Off |
| Torch (flashlight) | On / Off |
| Mic sensitivity | 0–100 |
| Speaker volume | 0–100 |
| Two-way audio | Enabled / Disabled |
| Show local feed | On / Off (preview) |
| Keep awake (Wake Lock) | On / Off (iOS 16.4+) |
| Custom label | Free text |
| Audio alert threshold | dB level + enable/disable |
| Media device selection | Specific camera/mic by deviceId |

### Two-Way Talkback
- **Push-to-talk** on base station → adds audio track to existing peer connection
- Only the **audio-focused** source receives talkback
- Configurable per-camera (`twoWayAudioEnabled`)

### Configuration & Persistence
- **JSON file storage** (`server/config.json`) — no database needed
- **Per-device config** persisted server-side, survives restarts
- **Local fallback** — kiosk remembers last settings in localStorage before server sync
- **Remote config push** — base station changes apply instantly if online, queued if offline
- **Presets** — named profiles (Daytime, Nighttime, Naptime, Away) with optional cron schedules

### Signaling Protocol (WebSocket)
Message types:
- `JOIN_ROOM` / `LEAVE_ROOM` — room membership
- `PUBLISH_SOURCE` / `UNPUBLISH_SOURCE` — camera publishes media
- `SUBSCRIBE_SOURCE` / `UNSUBSCRIBE_SOURCE` — base station watches feed
- `OFFER` / `ANSWER` / `ICE_CANDIDATE` / `ICE_RESTART` — WebRTC signaling
- `SET_CONFIG` / `GET_CONFIG` / `CONFIG_UPDATED` — remote configuration
- `REQUEST_TALK` / `STOP_TALK` — two-way audio
- `CAPABILITIES` — device enumeration (camera/mic selection)
- `AUDIO_PEAK` — real-time dB level for alerting
- `DEVICE_STATUS` / `SOURCE_ADDED` / `SOURCE_REMOVED` — presence
- `REMOVE_DEVICE` / `DEVICE_REMOVED` — device management

### Reconnection & Resilience
| Layer | Strategy |
|-------|----------|
| WebSocket | Exponential backoff (1s → 30s cap); SSE fallback for legacy iOS ≤12 |
| WebRTC | ICE restart before full peer connection teardown |
| Device offline | 60s grace period before removing source from room |
| Config changes | Queued server-side, applied atomically on reconnect |

### iOS-Specific Handling
- **HTTPS required** for `getUserMedia` (localhost exempt)
- **User gesture required** for camera permission on every page load
- **WebRTC dies in background** — kiosk must stay foregrounded
- **Wake Lock API** (iOS 16.4+) keeps screen on
- **"Add to Home Screen"** improves tab persistence vs Safari tabs
- **Legacy iOS ≤12** — WebSocket unreliable (close code 1006); uses SSE fallback; camera start gated behind tap-to-enable button

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

Ports: `8090` (HTTPS), `8091` (HTTP redirect).

Certificates in `deploy/certs/` — install `ca.crt` profile on each iOS device (Settings → General → VPN & Device Management).

---

## Roadmap

### Near Term (v0.3–v0.4)
- [ ] **Multi-room support** — separate rooms per base station (currently single `default` room)
- [ ] **2×2 grid view** — simultaneous monitoring of up to 4 feeds on base station
- [ ] **Viewer page** (`/viewer.html`) — read-only remote access with optional PIN
- [ ] **Preset scheduling** — cron-based auto-apply (Daytime 7am–7pm, Nighttime 7pm–7am, etc.)
- [ ] **Audio alert webhook** — POST to Home Assistant / n8n / custom endpoint on threshold breach

### Medium Term (v0.5–v0.6)
- [ ] **SFU (mediasoup/LiveKit)** — scale beyond 3–4 cameras; server-side mixing
- [ ] **Recording** — optional HLS/MP4 segment recording to disk or S3
- [ ] **Push notifications** — iOS push (APNs) for audio alerts when base station backgrounded
- [ ] **Raspberry Pi Camera Module** support — native V4L2/ALSA capture via headless kiosk client
- [ ] **Admin API** — REST endpoints for external automation (Home Assistant, etc.)

### Long Term (v1.0+)
- [ ] **End-to-end encryption** — DTLS-SRTP key rotation, optional passphrase
- [ ] **Multi-base station** — shared room state across multiple control hubs
- [ ] **Android/Chrome support** — test & fix any WebKit-only assumptions
- [ ] **WebRTC data channel** — low-latency control channel (PTZ, config, events)

### Nice-to-Have
- [ ] **Dark mode** UI theme
- [ ] **Bandwidth adaptation** — simulcast/SVC for variable networks
- [ ] **Metrics endpoint** — Prometheus `/metrics` for uptime/latency tracking
- [ ] **OTA config updates** — signed config bundles for air-gapped deployments

---

## Architecture

```
┌─────────────┐     WebSocket      ┌──────────────┐     WebRTC P2P     ┌─────────────┐
│  Base       │ ◄─────────────────► │   Server     │ ◄────────────────► │  Kiosk      │
│  Station    │   Signaling only   │  (matchmaker)│   Media flows      │  (Camera)   │
└─────────────┘                    └──────────────┘   directly         └─────────────┘
       ▲                                  ▲
       │                          JSON config file
       │                          (no database)
       └──────────────────────────────────┘
```

- **Single Node.js process** — Express (static + API) + `ws` (WebSocket)
- **TypeScript** — strict mode, shared types between server/client
- **Docker** — multi-stage build, non-root user, health checks

## License

MIT