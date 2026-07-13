# Hearth-Connect

HTML5 video intercom / baby monitor system. Runs on iPads/iPhones via Safari. Self-hosted.

> **In progress:** a native **Linux agent** (headless monitor client, no browser) targeting **Raspberry Pi 3+** is under active development.

## Requirements

- **iOS 11+** (iOS 9.3.5 and earlier are **not supported** — WebRTC requires iOS 11+)
- Safari (or any WebKit-based browser on iOS)
- Self-hosted server with HTTPS (self-signed certs work; install CA profile on iOS)
- Docker (recommended) or Node.js 20+

## Features

### Core Architecture
- **WebRTC P2P mesh** — sub-500ms latency, two-way audio, no media relay through server
- **Server = matchmaker only** — signaling via WebSocket (or SSE fallback for iOS ≤12); no SFU needed for 2–3 cameras
- **Single-room model** — multiple kiosks per room; base station subscribes to any source
- **Self-signed TLS** — CA cert installed once per iOS device via Settings → VPN & Device Management

### Device Roles
| Page | Role | Purpose |
|------|------|---------|
| `monitor.html` | **Monitor** (publisher) | Thin client — captures camera/mic, publishes to room, minimal UI |
| `base-station.html` | **Base Station** (subscriber + admin) | Full control hub — monitors kiosks, pushes config, manages devices |
| `index.html` | Landing | Role selector + server status |

### Monitor (Camera Device) — `monitor.html`
- **Auto-reconnect** — deviceId persisted in localStorage; rejoins room on reload
- **User gesture required** — iOS ≤12 shows "Tap to enable camera" overlay; iOS 13+ auto-starts
- **Media constraints** — front/rear camera, 480p/720p/1080p, 15/24/30 fps
<!-- TODO: revisit — night mode / torch note removed; not verified as implemented -->
- **Audio alerting** — real-time RMS dB monitoring; peak detection with configurable threshold/hysteresis; relays `AUDIO_PEAK` to base station
- **Wake Lock API** — keeps screen on (iOS 16.4+)
- **Device enumeration** — reports available cameras/mics to base station for remote selection
- **Track sync** — resolution/framerate/camera changes swap tracks on live peer connections without reconnecting
- **Legacy iOS (≤12) support** — SSE signaling fallback, combined `getUserMedia`, AudioContext created inside gesture

### Base Station — `base-station.html`
- **Device dashboard** — lists all kiosks with label, online/offline status, last-seen timestamp
- **Per-device audio level** — live dB readout; visual alert highlight when threshold exceeded
- **Monitor modes** — Video (full stream) or Audio-only (keeps audio track, hides video)
- **Volume control** — 0–200% gain via Web Audio `GainNode` (video element muted; audio routed through graph)
- **Remote config panel** — per-kiosk settings:
  - Label, camera (by deviceId or front/rear), resolution, frame rate
  - Microphone selection (by deviceId)
  - Two-way audio toggle, keep-awake toggle
  - Audio alert enable + threshold (dB)
- **Device removal** — purges from recently-seen list and persisted config
- **Toast notifications** — "Device joined", "Source online"
- **Watchdog + auto-recover** — detects stalled tracks (8s no activity) → ICE restart → resubscribes + re-offers

### Signaling & Discovery
<!-- TODO: revisit — QR code discovery removed for now -->
- **Kiosk entry** — manually enters room name (opens `monitor.html`)
- **No pairing tokens required** — room join is direct via `JOIN_ROOM`
- **Recently-seen devices** — 24h in-memory window (survives server restart via persisted config)

### Configuration & Persistence
- **JSON file storage** (`server/data/config.json`) — no database
- **Per-device config** — camera, resolution, framerate, mic/speaker levels, twoWayAudio, keepAwake, label, audioAlert*, device selection
- **Base station config** — visibleSources, audioFocusMode (manual/last-active), gridLayout, idleTimeout
- **Config queuing** — changes pushed to offline devices applied on next reconnect *(unverified — may or may not be wired up)*
<!-- TODO: presets (named Daytime/Nighttime/Naptime/Away profiles + cron scheduling) NOT implemented yet -->

### Reconnection Strategy
| Layer | Behavior |
|-------|----------|
| WebSocket | Exponential backoff (1s → 30s cap) |
| WebRTC (ICE) | ICE restart before full peer connection teardown |
| Device offline | 60s grace period before source removed from room |

### Two-Way Audio & Video (Base → Monitor)
- **FaceTalk** — base station pushes its **camera + mic** to the watched monitor over a dedicated broadcast `RTCPeerConnection`; the monitor renders the base's video and plays its audio. Releases the base camera automatically when FaceTalk ends.
- **Broadcast Message** — press-and-hold **audio-only** announcement to all monitors (or a selected one); the button only broadcasts while held and cancels a stuck/in-flight start on release (fast-tap race handled).
- **Broadcast target select** — send FaceTalk/announcement to **all devices** or a **single monitor**
- **Monitor display modes** — `blank` / `self` (own camera preview) / `base` (base's FaceTalk feed); FaceTalk overrides the configured display mode for the duration of the call
- **Fullscreen** — base station can fullscreen a monitor feed; handles iOS Safari pause/freeze-on-exit (hard re-attach + resume paused video)
- **iOS silent-switch safe audio** — monitor audio routed through an unmuted video element so it plays even with the hardware mute switch on
- **Volume slider** — lower-right expandable vertical gain slider on the base station (0–200% via Web Audio `GainNode`)

### Legacy iOS Support (≤12)
- SSE downstream + HTTPS POST upstream (WebSocket unreliable → close code 1006)
- Combined `getUserMedia` (separate video/audio calls break audio on old WebKit)
- AudioContext created inside user gesture to avoid suspended state

---

## Quick Start

```bash
# Generate self-signed CA + cert (run once)
cd deploy && ./gen-cert.sh

# Build & run
docker compose up --build

# Or locally
cd server && npm install && npm run build && npm start
```

Open `https://<host>:8090` on the base station iPad; on each camera iPad open the same URL and enter the room name.

## Deployment

```bash
cd deploy
docker compose up -d
```

- Ports: `8090` (HTTPS), `8091` (HTTP → HTTPS redirect)
- Certs in `deploy/certs/` — install `ca.crt` profile on each iOS device (Settings → General → VPN & Device Management)

## Development

```bash
cd server
npm install
npm run dev   # ts-node-dev with hot reload
```

### Live iOS Safari debugging (Linux → USB)

`tests/ios-debug-bridge/` drives **real iOS Safari** on a USB-tethered iPhone/iPad
directly from a Linux host — no Mac required. It attaches to an open Safari tab
over the Chrome DevTools Protocol for DOM/state inspection, live `console` +
`pageerror` capture, and DOM-only assertions against the running app.

Transport chain: raw CDP (`ws`) → `remotedebug-ios-webkit-adapter` (:9000) →
`ios-webkit-debug-proxy` (:9222, WebInspector) → `usbmuxd` (USB) → iOS Safari.

> Debug aid only — it inspects/asserts DOM & console; it cannot automate
> camera/mic (iOS requires a real user gesture + secure context). See
> `tests/ios-debug-bridge/README.md` for host install + usage, and the
> Node-`vm` client verification approach in `AGENTS.md`.

## Project Structure

```
hearth-connect/
├── AGENTS.md
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── src/
│       ├── index.ts              # Express + WS/SSE server, TLS
│       ├── types.ts              # Shared type definitions
│       ├── ConfigManager.ts      # JSON file config persistence
│       ├── ChannelManager.ts     # In-memory room/device state
│       └── SignalingHandler.ts   # WebSocket message routing
│   └── public/
│       ├── index.html            # Landing / role selector
│       ├── monitor.html          # Monitor (publisher)
│       ├── base-station.html     # Base station (subscriber + admin)
│       ├── css/style.css
│       └── js/
│           ├── signaling.js      # WS/SSE client + reconnection
│           ├── webrtc.js         # getUserMedia + RTCPeerConnection
│           ├── camera.js         # Monitor page logic (served by monitor.html)
│           └── base-station.js   # Base station page logic
├── deploy/
│   ├── docker-compose.yml
│   └── gen-cert.sh
├── favicon.svg
└── README.md
```

---

## Roadmap

### v0.2 — Multi-Room & Auth
- [ ] Multiple named rooms (create/join from base station)
- [ ] Optional PIN per room (viewer access control)
- [ ] Pairing tokens for kiosk provisioning (QR contains token, not just URL)
- [ ] Device ownership (prevent unauthorized config pushes)

### v0.3 — Two-Way Audio & Video ✅ (shipped)
- [x] **Two-way audio** — base station mic → monitor speaker (FaceTalk + press-and-hold Broadcast Message announcement)
- [x] **Two-way video** — base station camera → monitor display (FaceTalk; monitor renders incoming video via `base` display mode)
- [x] Broadcast target routing — send to all monitors or a single selected monitor
- [x] Video call UI on base station (FaceTalk button, fullscreen, volume slider, base camera released on hang-up)
- [x] iOS hardening — silent-switch-safe audio, fullscreen pause/freeze-on-exit recovery, fast-tap broadcast race
- [ ] Audio focus enforcement — ensure only the audio-focused source plays at once (manual/last-active)

### v0.4 — Smart Audio Notifications
- [ ] **Audio gating** — base station audio muted until kiosk dB exceeds threshold (baby cry detection)
- [ ] Configurable trigger level, hysteresis, and cooldown period
- [ ] Optional push notification (APNs / web push) when threshold breached while base station backgrounded
- [ ] Per-source alert profiles (daytime vs nighttime sensitivity)

### v0.5 — Battery-Aware Client
- [ ] **Battery Status API** integration — detect charging state & level
- [ ] Auto-reduce resolution/framerate when unplugged (e.g., 1080p→480p, 30→15 fps)
- [ ] Disable torch, night mode, keep-awake when on battery
- [ ] Optional aggressive mode: audio-only when battery < 20%
- [ ] Visual indicator on base station showing kiosk power state

### v0.6 — Alternative Host Platforms
- [ ] **Raspberry Pi** — headless kiosk via V4L2/ALSA (USB camera + mic), systemd service, no browser
- [ ] **iOS Native App** — Swift/Capacitor wrapper for background WebRTC, push notifications, no Safari limitations
- [ ] **Android App** — same capabilities as iOS native
- [ ] **Linux/macOS/Windows** — Electron or Tauri desktop client for base station

### v0.7 — QR Code Sharing & Provisioning
- [ ] QR contains pairing token + room + server URL (not just URL)
- [ ] One-scan kiosk enrollment — no manual room entry
- [ ] Token expiry & single-use enforcement
- [ ] Base station "Invite Kiosk" generates printable/shareable QR

### v0.8 — Scaling (SFU)
- [ ] Integrate **mediasoup** or **LiveKit** as optional SFU
- [ ] Base station subscribes to SFU instead of P2P mesh
- [ ] Enable 5+ simultaneous cameras without mesh explosion

### v0.9 — Viewer App
- [ ] Dedicated `viewer.html` — read-only monitor (no admin controls)
- [ ] Viewer config: allowedSources, defaultSource, audioAutoPlay, talkbackEnabled, PIN
- [ ] "Add to Home Screen" PWA manifest for kiosk/viewer

### v1.0 — Recording & Platform Polish
- [ ] Optional MediaRecorder → segment to disk (WebM/MP4)
- [ ] Audio alert webhooks (Home Assistant, ntfy, Pushover)
- [ ] Motion detection via canvas diff (browser-side) → trigger recording
- [ ] Raspberry Pi 4/5 + USB camera + `v4l2loopback` as headless kiosk
- [ ] systemd service + nginx reverse proxy guide
- [ ] Health check endpoint + Prometheus metrics
- [ ] Automated cert renewal (Let's Encrypt for public hosts)

---

## License

MIT