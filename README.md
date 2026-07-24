# Hearth-Connect

**v0.8** — Multi-Platform Video Intercom

HTML5 video intercom / baby monitor system. Self-hosted. Runs on iPads/iPhones (Safari), Raspberry Pi (headless GStreamer agent), and Android (native Ktor + libwebrtc base station).

## Requirements

- **iOS 11+** (iOS 9.3.5 and earlier are **not supported** — WebRTC requires iOS 11+)
- Safari (or any WebKit-based browser on iOS)
- Self-hosted server running Node.js 20+ over HTTPS (self-signed certs work; install CA profile on iOS)

## Features

### Core Architecture
- **WebRTC P2P mesh** — sub-500ms latency, two-way audio, no media relay through server
- **Server = matchmaker only** — signaling via WebSocket; no SFU needed for 2–3 cameras
- **Multi-publisher room model** — multiple sources per room; subscribers independently subscribe
- **Self-signed TLS** — CA cert installed once per iOS device via Settings → VPN & Device Management

### Device Roles
| Platform | Role | Status |
|----------|------|--------|
| `monitor.html` (iOS Safari) | **Kiosk/Publisher** | Stable |
| `base-station.html` (iOS Safari) | **Base Station/Admin** | Stable |
| `linux/pi-agent/` (Raspberry Pi) | **Headless Publisher** | Working (audio + video) |
| `android/` (Android native) | **Base Station** | Working (some QOL bugs) |
| `index.html` | Landing / role selector | Stable |

### Monitor (Camera Device) — `monitor.html`
- **Auto-reconnect** — deviceId persisted in localStorage; rejoins room on reload
- **Media constraints** — front/rear camera, 480p/720p/1080p, 15/24/30 fps
- **Audio alerting** — real-time RMS dB monitoring; peak detection with configurable threshold/hysteresis; relays `AUDIO_PEAK` to base station
- **Wake Lock API** — keeps screen on (iOS 16.4+)
- **Device enumeration** — reports available cameras/mics to base station for remote selection
- **Track sync** — resolution/framerate/camera changes swap tracks on live peer connections without reconnecting

### Base Station — `base-station.html`
- **Device dashboard** — lists all kiosks with label, online/offline status, last-seen timestamp
- **Per-device audio level** — live dB readout; visual alert highlight when threshold exceeded
- **Monitor modes** — Video (full stream) or Audio-only (keeps audio track, hides video)
- **Volume control** — 0–200% gain via Web Audio `GainNode`
- **Remote config panel** — per-kiosk settings: label, camera, resolution, frame rate, mic, two-way audio, keep-awake, audio alert threshold
- **Device removal** — purges from recently-seen list and persisted config
- **Toast notifications** — "Device joined", "Source online"
- **Watchdog + auto-recover** — detects stalled tracks (8s no activity) → ICE restart → resubscribes + re-offers

### Raspberry Pi Agent — `linux/pi-agent/`
- **Native GStreamer + WebRTC** — no browser, headless, runs as systemd service
- **V4L2 video** — USB cameras (PS3Eye, UVC webcams) or Pi Camera via libcamera
- **ALSA audio** — auto-detects USB mic, supports multi-channel devices (PS3Eye 4-ch downmixed to mono)
- **Two-way talkback** — receives base station audio via sendrecv WebRTC peer connection
- **Remote config** — base station pushes resolution/framerate/encoder settings to Pi
- **mDNS discovery** — auto-finds server on local network
- **Install**: `linux/pi-agent/install.sh` or deploy via `linux/deploy-pi.sh`

### Android Base Station — `android/`
- **Native Ktor + libwebrtc** — embedded signaling server, no browser dependency
- **Samsung Galaxy Tab A7** target (SM-T500, Android 11)
- **Build**: open `android/` in Android Studio, or `./gradlew assembleDebug`
- **Deploy**: `adb install -r app/build/outputs/apk/debug/app-debug.apk`

### Signaling & Discovery
- **Kiosk entry** — manually enters room name (opens `monitor.html`)
- **No pairing tokens required** — room join is direct via `JOIN_ROOM`
- **Recently-seen devices** — 24h in-memory window (survives server restart via persisted config)
- **mDNS service** — server publishes `_hearth-connect._tcp.local` for Pi agent discovery

### Configuration & Persistence
- **JSON file storage** (`server/data/config.json`) — no database
- **Per-device config** — camera, resolution, framerate, mic/speaker levels, twoWayAudio, keepAwake, label, audioAlert*
- **Base station config** — visibleSources, audioFocusMode (manual/last-active), gridLayout, idleTimeout
- **Config persistence** — base station pushes config to server; applied on device reconnect

### Reconnection Strategy
| Layer | Behavior |
|-------|----------|
| WebSocket | Exponential backoff (1s → 30s cap) |
| WebRTC (ICE) | ICE restart before full peer connection teardown |
| Device offline | 60s grace period before source removed from room |

### Two-Way Audio & Video (Base → Monitor)
- **FaceTalk** — base station pushes its camera + mic to the watched monitor over a dedicated broadcast `RTCPeerConnection`
- **Broadcast Message** — press-and-hold audio-only announcement to all monitors (or a selected one)
- **Monitor display modes** — `blank` / `self` (own camera preview) / `base` (base's FaceTalk feed)
- **iOS silent-switch safe audio** — monitor audio routed through an unmuted video element

---

## Quick Start

```bash
# Generate self-signed CA + cert (run once)
cd docker && ./gen-cert.sh

# Build & run
docker compose up --build

# Or locally
cd server && npm install && npm run build && npm start
```

Open `https://<host>:8090` on the base station iPad; on each camera iPad open the same URL and enter the room name.

### Recommended: install as a systemd service

```bash
sudo ./setupservice.sh            # system service
./setupservice.sh --user          # per-user unit (no root)

# After code update:
cd server && npm install && npm run build && sudo systemctl restart hearth-connect
```

### Raspberry Pi Agent

```bash
# Deploy from your dev machine
linux/deploy-pi.sh <pi-hostname>

# Or install directly on the Pi
ssh pi 'bash -s' < linux/pi-agent/install.sh
```

Edit `linux/pi-agent/config.env` to set `SERVER_URL`, `ROOM_ID`, `VIDEO_DEVICE`, `AUDIO_DEVICE`.

## Deployment

```bash
cd docker
docker compose up -d
```

- Ports: `8090` (HTTPS), `8091` (HTTP → HTTPS redirect)
- Certs in `docker/certs/` — install `ca.crt` profile on each iOS device

## Development

```bash
cd server
npm install
npm run dev   # ts-node-dev with hot reload
```

## Project Structure

```
hearth-connect/
├── server/
│   ├── src/
│   │   ├── index.ts              # Express + WS server, TLS
│   │   ├── types.ts              # Shared type definitions
│   │   ├── ConfigManager.ts      # JSON file config persistence
│   │   ├── ChannelManager.ts     # In-memory room/device state
│   │   └── SignalingHandler.ts   # WebSocket message routing
│   └── public/
│       ├── index.html            # Landing / role selector
│       ├── monitor.html          # Monitor (publisher)
│       ├── base-station.html     # Base station (subscriber + admin)
│       ├── css/style.css
│       └── js/
│           ├── signaling.js      # WS client + reconnection
│           ├── webrtc.js         # getUserMedia + RTCPeerConnection
│           ├── camera.js         # Monitor page logic
│           └── base-station.js   # Base station page logic
├── linux/
│   └── pi-agent/
│       ├── pi-agent.py           # GStreamer + WebRTC native agent
│       ├── config.env            # Runtime config (server URL, devices)
│       ├── install.sh            # One-shot install script
│       └── test_pi_agent.py      # Unit tests (no GStreamer needed)
├── android/
│   └── app/                      # Native Android base station (Ktor + libwebrtc)
├── docker/
│   ├── docker-compose.yml
│   └── gen-cert.sh
└── AGENTS.md                     # Architectural decisions & known regressions
```

---

## Roadmap

### In Progress
- [ ] Android base station QOL polish (bugs, UI refinements)
- [ ] Audio talkback tuning (Pi ↔ base station two-way audio)

### Multi-Room & Auth
- [ ] Multiple named rooms (create/join from base station)
- [ ] Optional PIN per room (viewer access control)
- [ ] Device ownership (prevent unauthorized config pushes)

### Smart Audio Notifications
- [ ] Configurable trigger level, hysteresis, and cooldown period
- [ ] Optional push notification (APNs / web push) when threshold breached while base station backgrounded
- [ ] Per-source alert profiles (daytime vs nighttime sensitivity)

### Battery-Aware Client
- [ ] Battery Status API — detect charging state & level
- [ ] Auto-reduce resolution/framerate when unplugged
- [ ] Visual indicator on base station showing kiosk power state

### Scaling & Platforms
- [ ] Integrate **mediasoup** or **LiveKit** as optional SFU for 5+ cameras
- [ ] iOS native app (Swift/Capacitor) for background WebRTC + push notifications
- [ ] Desktop client (Electron or Tauri) for base station

### Recording & Polish
- [ ] Optional MediaRecorder → segment to disk (WebM/MP4)
- [ ] Audio alert webhooks (Home Assistant, ntfy, Pushover)
- [ ] Health check endpoint + Prometheus metrics

---

## License

MIT
