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
- Self-signed CA generated via docker/gen-cert.sh
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
├── docker/
│   ├── docker-compose.yml
│   └── gen-cert.sh
├── linux/
│   └── pi-agent/
├── favicon.svg
└── README.md
```

## Client-Side Verification (ad-hoc)

No client test suite exists. Browser JS in `server/public/js/*.js` can be
tested without a browser by running the real file in a Node `vm` with a
minimal DOM shim (stub `document`, `window`, `localStorage`, `getUserMedia`,
`SignalingClient`, `WebRTCManager`). See `tests/hermes-verify-*.js` for
examples. Catches JS-level races (e.g. press-and-hold broadcast fast-tap)
but not real WebRTC media or iOS Safari behavior.

### Pi agent (Python)

`linux/pi-agent/pi-agent.py` is a native GStreamer + WebRTC client (no browser).
It imports GStreamer/websockets **lazily**, so its pure logic is unit-testable
without the native stack. Use the same zero-dep philosophy:

- `linux/pi-agent/test_pi_agent.py` — stdlib `unittest` over the pure helpers
  (`parse_v4l2_devices`, `parse_arecord_devices`, `source_type`, `audio_peak_decision`,
  `monitor_pipeline_str`, `broadcast_pipeline_str`). Loads the hyphenated module via
  `importlib` and runs with `python3 -m unittest test_pi_agent.py` (no GStreamer needed).
- `linux/pi-agent/e2e_smoke.py` — spins the real agent (`TEST_SOURCE=1` uses
  `videotestsrc`/`audiotestsrc` so no camera/mic is required) against a live server and
  asserts it publishes a source + produces a WebRTC OFFER. Auto-skips when GStreamer /
  `websockets` / the server are absent, so it's safe in CI. Run on a Pi for the real check.

### iOS Debug Bridge (USB-tethered Safari inspection)

`tests/ios-debug-bridge/` drives a real iOS Safari tab via CDP over
`usbmuxd` → `ios-webkit-debug-proxy` → `remotedebug-ios-webkit-adapter`.
Use it for DOM/state inspection, console capture, and signaling-handshake
checks on a real device. See `tests/ios-debug-bridge/README.md` for host setup.

## Known Regressions and Browser Compatibility

### GStreamer SDP mid mismatch (Firefox, Chrome with GStreamer agent)

GStreamer webrtcbin uses mids like `video0`/`audio1` in its SDP offer. Browsers
(especially Firefox 127+) may rename these to `0`/`1` in the answer SDP. When
the Pi agent sends ICE candidates carrying the original GStreamer mids, the
browser's `addIceCandidate` fails with "No such transceiver" because no local
transceiver matches `mid=audio1`.

**Fix** (`webrtc.js`): `_resolveMid()` maps an incoming candidate's mid to the
browser's actual transceiver mid by falling back to `sdpMLineIndex` lookup when
the named mid doesn't match any local transceiver. Applied in both
`handleIceCandidate` and `flushCandidates`.

**Symptom**: `addIceCandidate failed: DOMException: Cannot set ICE candidate
for level=1 mid=audio1: No such transceiver` -- appears in Firefox and sometimes
Chrome. Audio stream never connects; video may connect but audio is missing.

### Camera red light stays on after disconnect

When the WebSocket drops (browser crash, network blip), the server immediately
sends `SUBSCRIBER_LEFT` to the publisher. However, the Pi agent's old
`MonitorSession` pipelines survive across the WS reconnect -- `self.sessions` is
an Agent-level dict that persists while the WS loop cycles. The orphaned
GStreamer pipelines hold `/dev/video*` open, keeping the camera red light on
and blocking the next session from opening the device.

**Fix** (`pi-agent.py`): `_teardown_all_sessions()` is called when the WS
`async with` block exits (connection dropped). It closes every
`MonitorSession` and `BroadcastSession`, clears the session dicts, and
releases all camera/mic devices. This must happen before the reconnect sleep
so the device is free for the next connection.

**Symptom**: Camera red light stays on indefinitely after the base station
closes the feed or the browser crashes. A second device cannot connect because
`/dev/video0 is busy`.

### PS3Eye 4-channel audio silent on browser viewers

The PS3Eye camera exposes 4 raw microphone capsule channels via ALSA
(`hw:2,0`, 16kHz). If the GStreamer pipeline passes all 4 channels through to
Opus encoding without downmixing, the browser receives 4-channel Opus audio.
Most browsers expect mono or stereo — 4-channel audio plays as silence or
garbled noise.

**Root cause**: `monitor_pipeline_str()` used the device's native channel count
(from `alsa_channels()`) in a single `capsfilter` placed *before*
`audioconvert`. This told `alsasrc` to output 4 channels, and nothing
downstream reduced them to mono. The `level` element (for audio peak alerts)
was also missing.

**Fix** (`pi-agent.py:410-418`): The pipeline now uses two capsfilters:
1. First capsfilter forces the source's native channel count (e.g. 4 for
   PS3Eye) so `alsasrc` can negotiate with the ALSA device.
2. Second capsfilter forces `channels=1` *after* `audioconvert`, which
   triggers mono downmix before encoding.
3. `level` element re-inserted between the downmix capsfilter and `opusenc`.

Before (broken):
```
alsasrc device=hw:2,0 ! capsfilter caps=audio/x-raw,channels=4
  ! audioconvert ! audioresample ! opusenc ! rtpopuspay
```

After (fixed):
```
alsasrc device=hw:2,0 ! capsfilter caps=audio/x-raw,channels=4
  ! audioconvert ! audioresample ! capsfilter caps=audio/x-raw,channels=1
  ! level ! opusenc ! rtpopuspay
```

**Symptom**: Audio stream connected (WebRTC track present) but browser viewers
hear silence from PS3Eye mic. Single-channel USB mics (e.g. C-Media PnP)
were unaffected because they output 1 channel natively.
