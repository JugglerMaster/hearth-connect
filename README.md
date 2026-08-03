# Hearth-Connect

**v0.9** — Multi-Platform Video Intercom

HTML5 video intercom / baby monitor system. Self-hosted. Runs on iPads/iPhones (Safari), Raspberry Pi (headless GStreamer agent), and Android (native Ktor + libwebrtc base station).

## Requirements

### Client devices
- **iOS 11+** (iOS 9.3.5 and earlier are **not supported** — WebRTC requires iOS 11+) running Safari or any WebKit-based browser
- **Android 9+** for the native Ktor base station (tested on Samsung Galaxy Tab A7 / SM-T500, Android 11)

### Server / hub
- One of:
  - **Node.js 20+** self-hosted server over HTTPS — `server/` (Express + `ws`, self-signed certs work; install the CA profile on iOS once via Settings → VPN & Device Management), **or**
  - **Android hub** — the embedded Ktor signaling server inside the Android base station app (`android/`), which serves the client assets and provides WebRTC signaling without a separate Node process.

### Headless publisher (Raspberry Pi)
- **Raspberry Pi** (Pi 3/4/Zero 2 W) or any Linux host with a USB/Pi camera and mic
- **GStreamer 1.18+** with `webrtcbin`, `rtp`, and `good/ugly` plugins
- **Python 3.9+** for `linux/pi-agent/pi-agent.py` (GStreamer/websockets imported lazily)

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
  - **WiFi hotspot / captive portal** — if no station WiFi is found, the agent
    brings up its own AP (SSID = hostname, e.g. `pivideo1`) with a captive
    portal for one-tap provisioning of home WiFi; scans nearby networks first
    (without dropping the phone) and recovers a saved connection if the AP has
    no internet after 10 min. Runs with passwordless `sudo` for `nmcli`/`dnsmasq`.
  - **SD-card longevity** — `linux/pi-agent/sd-card-longevity.sh` reduces SD
    writes for always-on Pi deployments.
  - **Install**: `linux/pi-agent/install.sh`

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

### Recorded Announcements (record-then-play) — `plan 18`
- **Record → broadcast** — base station records a WAV clip (press-and-hold) and
  uploads it to `POST /api/clip`; the hub fans it out via `PLAY_CLIP` to selected
  targets (monitors and/or network speakers).
- **One-shot, no live relay** — recorded clips are a WAV + push, not a live
  WebRTC stream, so they don't burden the signaling server with media.
- **Target selection** — choose recipients from the broadcast "Send to"
  selector alongside live talkback targets.

### Network Speakers (Sonos / UPnP) — `plan 19`
- **SSDP discovery** — hub discovers Sonos/UPnP AV renderers on the LAN and
  publishes them as first-class `sonos` room devices (labeled by the speaker's
  Sonos `roomName`).
- **Clip playback** — recorded announcements (and a server-generated test tone)
  are pushed to Sonos via UPnP `AVTransport` + `RenderingControl` using a
  raw-socket UPnP client (avoids the `HttpURLConnection` chunked-encoding /
  service-type quirks that produced UPnP 401/402 errors).
- **Base station UI** — "Network Speakers" panel with per-speaker volume +
  allow-broadcasts toggle; Sonos entries appear in the broadcast "Send to"
  selector.
- **Persistence** — speaker config (volume, allow-broadcasts, labels) survives
  hub restarts via `device_configs.json`.

### iOS Background Audio (Screen Locked)

By default iOS suspends Safari/WKWebView the moment the screen locks, killing the
WebRTC audio stream. To keep monitoring with the screen off:

- **Recommended: Brave browser (iOS)** — enable **Background Audio**
  (Settings → Media → Background Audio) and open `base-station.html` from Brave.
  With that toggle on, the remote audio track keeps playing after the screen
  locks, so the base station works as a locked-screen baby monitor with no
  native app, sideloading, or dev account. This is now the recommended method
  for iOS devices to stream with the screen locked.
- **Limitation:** only *audio* survives lock — video cannot render to a dark
  screen and resumes on unlock. Background microphone/talkback is still
  restricted, so press-to-talk back to a camera will not function while locked.
- **Alternative:** a native Swift/`libwebrtc` app using the `audio` background
  mode achieves the same audio-while-locked result, but requires building and
  sideloading. Brave's toggle covers the same case without that overhead.

---

## ⚠️ Security Warning: No Authentication

**Hearth-Connect currently has NO authentication, authorization, or access
control of any kind.**

- Anyone who can reach the server URL (e.g. over Tailscale or your LAN) can
  join any room, subscribe to camera/mic feeds, and **push configuration to
  devices** (including disabling streams or changing settings).
- Room join is direct via `JOIN_ROOM` — there are no pairing tokens, PINs, or
  credentials (see "No pairing tokens required" under Signaling & Discovery).
- This is acceptable for a trusted, isolated home network / private VPN, but it
  is **NOT safe to expose publicly** (no port-forwarding to the open internet).

Until auth is implemented (see the plan below), treat the server as a
trust-boundary device: keep it behind your router/firewall and only reachable
via Tailscale or a similarly access-controlled private network.

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
# Install directly on the Pi
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

### Remote Access (Tailscale) — Recommended

For accessing the base station/monitors **away from the home LAN** (e.g. while
traveling), run the self-hosted server behind **[Tailscale](https://tailscale.com)**
— a zero-config mesh VPN. Install Tailscale on the server host and on each iOS
device, then point `SERVER_URL` at the server's Tailscale IP
(`https://<server-tailscale-ip>:8090`). Because Tailscale is an always-on,
persistent virtual network:

- The iOS device reaches the server from anywhere without port-forwarding or
  exposing the server to the public internet.
- It pairs well with the locked-screen Brave setup above — the audio monitor
  stays connected over the VPN the same as on the local network.

Self-signed CA certs still apply — install `ca.crt` on each iOS device once.

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
- [x] Audio talkback tuning (Pi ↔ base station two-way audio)

### Multi-Room & Auth

> **Status:** Not started. There is currently no authentication in the system —
> see the Security Warning above. The following is the planned approach.

- [ ] Multiple named rooms (create/join from base station)
- [ ] Optional PIN per room (viewer access control)
- [ ] Device ownership (prevent unauthorized config pushes)

**Plan — Authentication & Access Control**

1. **Room PIN / access token (first milestone)**
   - Add an optional `pin` (or shared token) per room in `ConfigManager`
     (`server/data/config.json`). Server rejects `JOIN_ROOM` without a matching
     token; subscribers (monitors/viewers) must supply it on connect.
   - Configurable from the base station UI; persisted server-side.
   - Backwards-compatible: rooms with no PIN behave as today (open join).
2. **Device identity & ownership**
   - Promote the existing client `deviceId` (currently only localStorage) into a
     server-issued, persisted credential so config-push messages
     (`Remote config panel`) are only honored from authorized devices.
   - Base station enrolls trusted device IDs; config pushes from unknown IDs are
     dropped with a `CONFIG_REJECTED` signal.
3. **Signaling-level auth**
   - Require an `Authorization` / token handshake on the WebSocket upgrade
     (`SignalingHandler`), so unauthorized clients never enter a room at all.
   - Keep tokens simple (symmetric shared secret per room) — no external IdP
     needed for a self-hosted home deployment.
4. **Transport hardening**
   - Ensure TLS is mandatory before any of the above (self-signed CA already
     documented); never accept room credentials over plain HTTP.
5. **Out of scope for v1**
   - Per-user accounts / OAuth, rate limiting, and brute-force protection on
     PINs (acceptable risk on a private VPN; revisit if ever publicly exposed).

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
  _(note: Brave's Background Audio toggle already covers locked-screen audio — see iOS Background Audio section)_
- [ ] Desktop client (Electron or Tauri) for base station

### Recording & Polish
- [ ] Optional MediaRecorder → segment to disk (WebM/MP4)
- [ ] Audio alert webhooks (Home Assistant, ntfy, Pushover)
- [ ] Health check endpoint + Prometheus metrics

---

## License

MIT
