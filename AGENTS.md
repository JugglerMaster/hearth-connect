# Hearth-Connect

## Project Overview
HTML5 video intercom / baby monitor system. Runs on iPads/iPhones via Safari. Self-hosted.

## Architectural Decisions

### Streaming Protocol: WebRTC
- Sub-500ms latency, two-way audio, native iOS Safari support since iOS 11
- P2P mesh initially (one RTCPeerConnection per publisher/subscriber pair)
- SFU (mediasoup/LiveKit) possible later if scaling beyond 2-3 cameras
- One peer connection per peer pair; tracks flow bidirectionally (video+audio one way, talkback audio the other)

### Server Stack: Node.js + TypeScript
- Single process serves static files + WebSocket signaling on one port
- Express for HTTP serving; `ws` library for WebSocket
- JSON file storage for config persistence (no DB dependency)
- Self-signed TLS for iOS HTTPS requirement
- Docker Compose for deployment

### Multi-Publisher Room Model
- A Room contains multiple MediaSources (one per publisher device)
- Subscribers independently subscribe to sources
- Server is a matchmaker only — no media passes through it

### Base Station as Control Hub
- Camera devices are thin clients: no settings UI, just status display
- All configuration originates from the base station
- Server is authoritative config store; config persists across disconnects

### Device Discovery & Room Entry
- Base station generates QR code via `/api/server-url` encoding the server URL (e.g. `https://host:8090`)
- QR code is 600px wide for easy scanning on iOS cameras
- Kiosk opens `monitor.html?room=<roomId>` from QR scan or manual room name entry
- No pairing tokens — kiosks join the room directly via `JOIN_ROOM` WebSocket message
- Server assigns a deviceId on first connection, persists to localStorage
- Subsequent launches: deviceId + roomId from localStorage → auto-reconnect
- Base station maintains `recentlySeenDevices` list (24h window) for device discovery
- Base station shows "Monitor" button per kiosk to select which feed to watch
- Monitor selection creates a recv WebRTC peer connection from base station to kiosk
- Kiosk responds to `SUBSCRIBER_JOINED` by creating a send peer connection and offering its camera

### Remote Configuration
- **Camera**: camera (front/rear), resolution, framerate, nightMode, torch, micSensitivity, speakerVolume, twoWayAudioEnabled, streamEnabled, keepAwake, label
- **Base Station**: visibleSources, audioFocusMode (manual/last-active), gridLayout, idleTimeout
- **Viewers**: allowedSources, defaultSource, audioAutoPlay, talkbackEnabled, pin
- **Presets**: named config profiles (Daytime, Nighttime, Naptime, Away) with optional cron scheduling

### Reconnection Strategy
- Three layers: Signaling (WebSocket), Media (WebRTC ICE), Device Offline
- WebSocket: exponential backoff (1s → 30s cap)
- WebRTC: ICE restart before full peer connection teardown
- Device offline: 60s grace period server-side before removing source from room
- Config changes queued server-side, applied atomically on reconnect

### TLS: Self-Signed Certificates
- Self-signed CA generated via deploy/gen-cert.sh
- CA profile installed once per iOS device via Settings
- Development: localhost (secure context for getUserMedia without cert)

### iOS Limitations
- getUserMedia requires HTTPS (or localhost) — strict requirement
- User gesture required for camera access on every page load (cannot auto-start)
- WebRTC does not survive backgrounding — camera device must stay foregrounded
- Wake Lock API (iOS 16.4+) keeps screen from sleeping
- "Add to Home Screen" improves tab persistence vs Safari tabs

### Two-Way Talkback
- Talk button on viewer → subscriber adds audio track to existing RTCPeerConnection
- Only the currently audio-focused source receives talkback audio
- Audio focus: one source plays at a time (manual or last-active mode)

## Project Structure
```
hearth-connect/
├── AGENTS.md
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── src/
│       ├── index.ts           # Express + WS server with TLS
│       ├── types.ts           # Shared type definitions
│       ├── ConfigManager.ts   # JSON file config persistence
│       ├── ChannelManager.ts  # In-memory room/device state
│       └── SignalingHandler.ts# WebSocket message routing
│   └── public/
│       ├── index.html         # Landing / room selector
│       ├── monitor.html        # Monitor device (minimal UI)
│       ├── base-station.html  # Base station (full control)
│       ├── viewer.html        # Remote viewer
│       ├── css/
│       │   └── style.css
│       └── js/
│           ├── signaling.js   # WS client with reconnection
│           ├── webrtc.js      # getUserMedia + RTCPeerConnection
│           ├── camera.js         # Monitor page logic (served by monitor.html)
│           ├── base-station.js# Base station page logic
│           └── viewer.js      # Viewer page logic
├── deploy/
│   ├── docker-compose.yml
│   └── gen-cert.sh
├── favicon.svg
└── README.md
```

## Client-Side Verification (ad-hoc)

The repo has no client test suite (the only tests are server-side TS in
`server/test/`). Browser-only client logic in `server/public/js/*.js`
(e.g. the base-station "Hold to Broadcast" press-and-hold flow) can be
behaviorally verified without a browser by running the **real** file inside a
Node `vm` with hand-rolled stubs — no `jsdom`/network/install needed.

Approach:
- Create a zero-dependency Node script under `/tmp` named
  `hermes-verify-<feature>.js` (tempfile; delete when done).
- Build a minimal DOM shim:
  - `makeEl(id)` → object with `classList` (add/remove/contains),
    `innerHTML` (setter can detect a known element id in the HTML and
    materialize it), `textContent`, `value`, `dataset`, `style.setProperty`,
    and an `_fire(type, ev)` that invokes `addEventListener` handlers.
  - `document.getElementById` returns pre-created fixed-id elements, plus the
    dynamically created control when present.
  - `window` with `addEventListener`/`_fire` so window-level handlers are
    reachable.
  - `localStorage` (in-memory) and `navigator.mediaDevices.getUserMedia`
    returning a **manually-resolved** `Promise` (so you can simulate the mic
    permission resolving *after* a release, to test the fast-tap race).
- Stub the two classes the IIFE instantiates:
  - `SignalingClient` — capture the instance in the constructor, expose
    `on`/`emit`, and record `broadcastSource` / `unbroadcastSource` calls.
  - `WebRTCManager` — `createBroadcastPeerConnection` returns a no-op
    `{ addTrack(){} }`.
- `vm.createContext(sandbox)` + `vm.runInContext(realFileSource)` to load the
  actual client file unmodified.
- Drive it: fire `DOMContentLoaded` (runs `init()`), emit a `welcome`
  message with a `base` + at least one `kiosk` device and a **hidden**
  `monitorFeed` so `renderDevices()` builds the broadcast panel and
  materializes `#toggleBroadcastButton`; then dispatch real events
  (`mousedown`/`mouseup`/`touchstart`/`touchend`, plus `window` releases)
  and assert `broadcastSource`/`unbroadcastSource` calls + button style/label.

Key things to assert for press-and-hold:
1. `mousedown` → `getUserMedia` called, broadcast NOT yet started.
2. After mic resolves → `broadcastSource` called, button → danger "release to stop".
3. `mouseup` → `unbroadcastSource` called, button reverts.
4. Window-level `touchend` (release outside button) also stops it.
5. **Fast-tap race**: `mousedown` then immediate `mouseup` *before* the mic
   resolves → when the mic finally resolves, `broadcastSource` is never called
   and the late-acquired mic track is stopped (no leak / no stuck-on broadcast).
6. Right-click (`button: 2`) does not start a broadcast.

This caught the stuck-on-broadcast race and confirmed release-anywhere handling.
It does NOT exercise real WebRTC media flow, iOS Safari specifics, or the live
kiosk receive side — those still need an on-device check.
