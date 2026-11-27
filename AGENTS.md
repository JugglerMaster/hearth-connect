# Hearth-Connect

## Project Overview
HTML5 video intercom / baby monitor system. Runs on iPads/iPhones via Safari. Self-hosted.

## Architectural Decisions

### Streaming Protocol: WebRTC
- Sub-500ms latency, two-way audio, native iOS Safari support since iOS 11
- P2P mesh initially (one RTCPeerConnection per publisher/subscriber pair)
- SFU (mediasoup/LiveKit) possible later if scaling beyond 2-3 cameras
- One peer connection per peer pair; tracks flow bidirectionally (video+audio one way, talkback audio the other)
- ICE negotiation (gathering, exchange, connectivity checks, renewal, restart, reconnection)
  and its three environments (iOS clients, Android local WebView, Pi agent) are documented in
  `docs/ice-negotiation.md` — read it before changing the `webrtc.js` / `webrtc.kt` / `pi-agent.py`
  ICE path.

### Server Stack: Node.js + TypeScript
- Single process serves static files + WebSocket signaling on one port
- Express for HTTP serving; `ws` library for WebSocket
- JSON file storage for config persistence (no DB dependency)
- Self-signed TLS for iOS HTTPS requirement
- Docker Compose for deployment

> **Development testing happens against the Android hub, not the Linux Node server.**
> The active signaling server during development is the embedded Ktor server inside the
> native Android app (`android/` — see `android/README.md`, `SignalingServer` Ktor CIO on
> `/ws` serving `assets/public`). The `server/` Node.js stack is the reference/portable
> implementation, but day-to-day dev + device testing targets the Android hub running on the
> Samsung Galaxy Tab A7. When testing clients or the Pi agent, point `SERVER_URL` at the
> Android hub, not a `localhost` Node instance.

### Multi-Publisher Room Model
- A Room contains multiple MediaSources (one per publisher device)
- Subscribers independently subscribe to sources
- Server is a matchmaker only — no media passes through it
  - **Exception (recorded audio only):** the Android hub may push a recorded
    `PLAY_CLIP` announcement to a discovered Sonos/UPnP speaker (plan 19). This
    is a one-shot WAV + UPnP push, not a live WebRTC stream, so the "avoid an
    SFU / media burden" rationale does not apply. Live WebRTC (FaceTalk /
    talkback) still never touches the server.

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

### Device Authentication (deny-by-default hub pairing)
- Every socket must send `AUTH` first. Only the hub's own WebView (loopback:
  `127.0.0.1` / `::1`) is trusted implicitly; every other device needs a
  server-issued credential token before `JOIN_ROOM` is honored.
- **Identity is the token, not the deviceId.** `deviceId` is client-supplied
  and lives in localStorage, so it is spoofable and resettable; the hub mints
  32 random bytes (Base64-URL) on approval and stores only `SHA-256(token)`.
- Pairing: `AUTH` without a token → `AUTH_REQUIRED {pendingId, code, expiresAt}`
  → the hub UI (banner in `base-station.html`) shows label/IP/6-digit code →
  owner taps Approve → `AUTH_OK {credentialId, token}` delivers the token
  exactly once → client stores it in `localStorage.hearth_authToken` (or
  `AUTH_TOKEN=` in the Pi's `config.env`) and every later connect is silent.
  Only loopback may send `AUTH_DECISION` / `REVOKE_CREDENTIAL` / `GET_AUTH_STATE`.
- State machine is strict: a non-`AUTH` message from an unauthenticated socket
  gets `ERROR {code:"AUTH_REQUIRED"}` and close `4009`, so no room state leaks.
- Close codes: `4003` denied (client stops retrying), `4004` unknown/revoked
  token (client drops the token and re-pairs), `4005` pending table full,
  `4008` pairing TTL expired (5 min) — retry, `4009` pre-auth violation.
- Limits: 3 pending requests, 5-minute TTL, one pending row per IP (a retry
  reattaches the same `pendingId`/code instead of stacking prompts).
- `POST /api/clip` requires `X-Hearth-Token` (or loopback). Static files,
  `/api/server-url`, `/hearthconnect.crt` and `GET /clip/*.wav` stay open so an
  unpaired device can still load the page that shows the waiting screen.
- Kill switch: `server_settings.json` → `auth.requiresApproval` (default true),
  toggled from the hub's Access panel via `SET_SETTINGS {section:"auth"}`. The
  `auth` section is loopback-gated in **both** servers (Android hub and the Node
  reference build): a non-loopback `base` gets `ERROR {code:"NOT_ALLOWED"}`, so
  a remote base can never disable approval gating. `tests/node-verify-auth-settings.mjs`
  asserts this.
- Persistence: Android `SharedPreferences("hearth_auth")`; the Pi writes
  `AUTH_TOKEN=` next to `DEVICE_ID` in `config.env`.
- Legacy migration: deviceIds already present in `device_configs.json` before
  the upgrade are auto-trusted once (minted a token, then the entry is
  consumed). A cached pre-auth client that sends `JOIN_ROOM` first appears as a
  `legacy:true` pending row ("old client — reload that device") and is closed
  with `4009` — unless its deviceId is legacy-known, in which case the socket is
  trusted as `legacy-<deviceId>` and the join proceeds (no token is minted,
  because old JS cannot store one). Reloading the page picks up the new
  `signaling.js` and completes the migration.
- Client contract: `signaling.js` queues every non-`AUTH` send until `AUTH_OK`,
  emits `open` only after authorization, and injects a full-screen
  pending/denied overlay on any page. `tests/hermes-verify-auth.mjs` exercises
  the handshake in a Node `vm` with a fake WebSocket.

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
- Talk button on the base station → subscriber adds audio track to existing RTCPeerConnection
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
│       ├── room-control.html  # Room Control (all-in-one: monitor + full control, same stack)
│       ├── home-assistant.html # Home Assistant integration page
│       ├── interop-harness.html # Playwright e2e interop page (no UI)
│       ├── css/
│       │   └── style.css
│       └── js/
│           ├── signaling.js   # WS client with reconnection
│           ├── webrtc.js      # getUserMedia + RTCPeerConnection (perfect negotiation, talkback)
│           ├── camera.js         # Monitor page logic (served by monitor.html)
│           ├── room-control.js  # Room-control page logic
│           ├── base-station.js# Base station page logic
│           ├── home-assistant.js # Home Assistant page logic
│           └── topbar.js       # Shared topbar widget (room chip / link)
├── docker/
│   ├── docker-compose.yml
│   └── gen-cert.sh
├── linux/
│   └── pi-agent/
├── favicon.svg
└── README.md
```

> **Note:** `android/app/src/main/assets/public` is a symlink to `server/public/`. Edits to
> `server/public/` automatically apply to both the Node server and the Android hub — no
> separate copy step needed.
>
> **Build gotcha:** Gradle does NOT reliably detect changes that arrive through this symlink
> (it reports the asset task as "up-to-date" and ships stale JS/HTML). Always run
> `./gradlew clean assembleDebug` (not just `assembleDebug`) when you change anything under
> `server/public/`, then `adb install -r` + force-stop/restart the hub. Verify the change
> landed by extracting the asset from the APK (`unzip -p app-debug.apk assets/public/js/<file>`),
> NOT by grepping the dex (JS assets are not compiled into the dex).
>
> **Android build toolchain (already set up on this machine):**
> - Gradle wrapper: `android/gradlew` (use this, not a system `gradle`).
> - Android SDK: `ANDROID_HOME=/home/dadisc01/Android/Sdk` (already exported in the env).
> - Build + install: `cd android && ./gradlew clean assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk`
> - To just compile-check Kotlin (no APK): `cd android && ./gradlew compileDebugKotlin`.

## Client-Side Verification (ad-hoc)

No client test suite exists. Browser JS in `server/public/js/*.js` can be
tested without a browser by running the real file in a Node `vm` with a
minimal DOM shim (stub `document`, `window`, `localStorage`, `getUserMedia`,
`SignalingClient`, `WebRTCManager`). See `tests/hermes-verify-*.js` for
examples. Catches JS-level races (e.g. press-and-hold broadcast fast-tap)
but not real WebRTC media or iOS Safari behavior.

`tests/hermes-verify-auth.mjs` is the auth-handshake check: it runs the real
`signaling.js` against a fake `WebSocket` and asserts AUTH-first ordering,
queueing before `AUTH_OK`, one-time token storage, revoked-token recovery and
the denied path. Run it with `node tests/hermes-verify-auth.mjs`.

`tests/node-verify-auth-settings.mjs` is the Node reference-server auth-guard
check: it drives the real `SignalingHandler` with a fake `Transport` and asserts
that a non-loopback `base` gets `NOT_ALLOWED` on `SET_SETTINGS {section:"auth"}`
while the loopback hub can flip it (and non-auth sections stay writable by any
base). Run it with `node tests/node-verify-auth-settings.mjs` (after `cd server &&
npm run build`).

### E2E browser interop (Playwright ↔ Pi agent)

`tests/e2e-browser/e2e-pi-agent-interop.mjs` is the automated WebRTC interop
test. It spawns the real GStreamer agent (`TEST_SOURCE=1` → videotestsrc/
audiotestsrc, no camera/mic) against a live server, then loads the real client
JS (`server/public/js/{webrtc,signaling}.js`) into Chromium and drives it as a
subscriber: it joins the room, subscribes to the agent's source, answers the
agent's OFFER, and asserts `RTCPeerConnection` reaches `connected` with a
received track. This is the only automated check that actually exercises the
**GStreamer `mid` mismatch fix** (`webrtc.js:_resolveMid`) — if that mapping
breaks, ICE never connects and the test times out.

Run (server must already be running — Android hub or Node server):
```bash
cd tests/e2e-browser && npm i -D playwright && npx playwright install chromium
SERVER_URL=https://<host>:8090 ROOM_ID=test npm run test:pi-interop
```
The Pi agent always connects via `wss` (it forces TLS), so the server must be
reachable over HTTPS/WSS. For the Node server, run it with `TLS_ENABLED=true`
(it auto-generates a self-signed cert in `server/certs`). The browser loads
`/interop-harness.html` from the **server origin** (a tiny page that pulls in
`signaling.js` + `webrtc.js` only) so the loopback WebSocket is same-origin and
not blocked by Chromium's Local Network Access check.

Auto-SKIPS (exit 0) when GStreamer, `websockets`, or the server are missing, so
it is CI-safe. It is a LAN/local test (STUN only, no TURN) — agent and browser
should run on the same host or same subnet. Diagnostics (agent log tail +
browser console) print on failure.

#### Live Pi video check (no spawned agent)

`tests/e2e-browser/e2e-verify-pi-video.mjs` does **not** spawn an agent. It joins
the live room and subscribes to the **existing** Pi source (looks for a `pi-`
publisher; `TARGET_LABEL` defaults to `Cat Room`), then asserts the browser
receives a **video track with non-zero bytes**. This is the only automated check
that proves the physical Pi's camera/encoder is actually publishing watchable
WebRTC end-to-end (not just signaling). Auto-SKIPS when the server is
unreachable or no Pi source is in the room. Run it alongside `test:pi-interop`
via `npm run test:pi-browser`, or on its own:
```bash
SERVER_URL=https://<host>:8090 ROOM_ID=default TARGET_LABEL='Cat Room' \
  npm run test:pi-live
```

#### Full Pi-agent validation

1. **Pure logic** (no GStreamer): `cd linux/pi-agent && python3 -m unittest test_pi_agent.py`
2. **Self-contained interop** (spawns a `TEST_SOURCE` agent + browser subscriber): `npm run test:pi-interop`
3. **Live device** (subscribes to the real Pi, asserts video frames): `npm run test:pi-live`

Steps 2 and 3 together are `npm run test:pi-browser`. Step 2 needs GStreamer +
`websockets` + Chromium; step 3 needs the physical Pi online. Both auto-skip when
their dependencies are absent.

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

### PS3Eye 4-channel audio silent on browser clients

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

**Symptom**: Audio stream connected (WebRTC track present) but browser clients
hear silence from PS3Eye mic. Single-channel USB mics (e.g. C-Media PnP)
were unaffected because they output 1 channel natively.

### Pi announcements (PLAY_CLIP) never audible on Pies with a `speakerDevice`

`gst-launch-1.0` treats each argv entry as a single pipeline token and does NOT
shell-split embedded whitespace. `_play_clip` built the command as a Python
list but passed the sink — e.g. `'alsasink device=hw:0,0'` — as ONE un-split
argv entry. gst-launch then exits within ~50ms with `erroneous pipeline:
syntax error`, and because `_play_clip` spawned with `stderr=DEVNULL` and never
checked the exit code, it logged "playing" regardless. Every announcement sent
to a Pi with `speakerDevice` set (any device whose sink carries properties)
was silently dropped, while talkback — an in-process GStreamer pipeline built
with `Gst.parse_launch`, not gst-launch argv — kept working. Pies with the
bare default sink (`alsasink`, no properties) were unaffected.

**Fix** (`pi-agent.py:gst_clip_argv`): the sink string is split on whitespace
into separate argv elements (`'alsasink', 'device=hw:0,0'`), and `_play_clip`'s
cleanup thread now logs `PLAY_CLIP %s playback failed (gst-launch rc=%d ...)`
when the process exits non-zero. The malformed-token variant is asserted in
`test_pi_agent.py:TestGstClipArgv` (every argv element must contain no space).

**Symptom**: Base station records + broadcasts an announcement ("All devices"),
Pi's journal shows `PLAY_CLIP <id> playing`, but nothing comes out of the
speaker. Diagnose via `state` in `/proc/asound/card0/pcm0p/sub*/status` while
the clip plays (never leaves `closed` in the broken build).

## Working preferences

- **Double-check before adding new things.** Before adding new code, tests, or
  features, verify the existing state first — what's already there, what's
  intended, and whether the change is actually needed. Inspect the repo and
  confirm rather than assume.
- **Build out a spec or readme documentation first.** Before implementing a new
  feature or change, write a spec or update the relevant readme/doc so the
  approach is documented before the code. For new gaps/features, document the
  plan in the relevant doc (e.g. `docs/media-test-gaps.md`, `docs/adr/`) before
  writing the implementation.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in `JugglerMaster/hearth-connect` (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
