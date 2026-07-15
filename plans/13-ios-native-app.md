# 13 — Native iOS App (Hearth-Connect client)

## Goal

Replace the browser-based monitor / base-station / viewer clients with a **native SwiftUI iOS
app** that connects to the existing Debian signaling hub. This is what makes the hard cases
work that the web clients cannot:

- **Mic + speaker audio survives a locked screen** (the ~5-minute cutoff the web app hits) via
  a native `AVAudioSession` with the `audio` background mode.
- **Reliable AirPlay** of received audio (bonus, native `AVRoutePickerView`).
- Same signaling protocol as the web clients → **no server changes** required.

## Key decisions (from brainstorming)

- **Debian hub stays the always-on core.** The iOS app is a client. An optional *embedded* Node
  server (Node.js Mobile) may be bundled for standalone "hub mode," but it is foreground-only
  and cannot replace the Debian hub (see Background caveat).
- **One app, three roles:** Monitor, Base Station, Viewer (mirrors `monitor.html`,
  `base-station.html`, `viewer.html`). Role chosen at launch / in-settings.
- **Sonos broadcast output is NOT in this app** — it is the Pi agent's job (plan 12, deferred).
- **Security is out of scope here but required later** (LAN auth + Tailscale discussed; track
  as a follow-up).

## Architecture

```
Debian hub (always-on)
  ├─ Node signaling server   (server/src — unchanged)
  └─ Pi agent → Sonos        (plan 12, deferred)
        ▲
        │ WebSocket + WebRTC  (SAME protocol as the web clients)
iOS app (Swift)
  ├─ Monitor role : publish camera+mic, recv base talkback / FaceTalk
  ├─ Base role    : broadcast/announce, talkback, FaceTalk
  └─ Viewer role  : watch a source
  └─ [optional] embedded Node server (Node.js Mobile) — standalone hub mode only
```

## Phases

### 1. Scaffold + signaling client
- SwiftUI app. `Info.plist`:
  - `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`, `NSLocalNetworkUsageDescription`.
  - `UIBackgroundModes: audio` (enables locked-screen audio).
- Port `signaling.js` → `SignalingClient` (URLSessionWebSocketTask):
  - reconnect/backoff (1s→30s), `JOIN_ROOM`, `WELCOME`/config apply, deviceId persistence
    (Keychain or UserDefaults), heartbeat.
- Reuse the exact JSON `{ type, payload }` wire format from `SignalingHandler.ts`. No new
  message types.

### 2. WebRTC
- Add Google **WebRTC iOS SDK** (CocoaPods `pod 'WebRTC'`, or SPM).
- Port `camera.js` monitor flow 1:1:
  - local `RTCPeerConnection` send/recv, `offerToSubscriber`, `onRemoteTrack`,
    `applyDisplayConfig` (self / blank / base), broadcast subscribe + unsubscribe,
    talkback enable/disable.
- Port `base-station.js` orchestration 1:1: device list, broadcast, FaceTalk, `setDisplayConfig`.

### 3. Background audio (the locked-screen fix)
- Configure `AVAudioSession`:
  - `setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])`
  - `setMode(.voiceChat)` (or `.videoChat`)
  - `setActive(true)` and keep it active.
- With `UIBackgroundModes: audio`, this keeps **mic capture + speaker playback alive while the
  screen is locked**, indefinitely. Video still stops when locked (camera hardware powers down)
  — matching current web behavior.
- Covers both "always-awake" and "locked" deployments, so no need to decide now.

### 4. AirPlay (bonus, optional)
- Add `AVRoutePickerView` so the app can AirPlay its received audio to speakers natively
  (reliable on iOS, unlike web). This is separate from the Sonos path (plan 12), which is handled
  by the Pi agent on Debian.

### 5. Optional embedded Node server (Node.js Mobile)
- Bundle `server/src` via **Node.js Mobile** so the app can act as a LAN hub if launched in
  "hub mode" (e.g., base-station browser connects directly to the iPad). Default mode connects
  to the Debian hub.
- **Foregound-only** — see Background caveat. Keep optional to avoid bloating the core path.

### 6. Distribution (no App Store review needed)
- Sign with the $99 Apple Developer account; distribute via **Ad Hoc** (own devices) or
  **TestFlight internal** (up to 25 testers, no build review).
- Add privacy-policy URL only if later published to the App Store.

## Background caveat — embedded Node server

A **Node.js server embedded in the iOS app will NOT run in the background.** iOS suspends the
app's process when the screen locks (~5-minute grace, the same cutoff seen on the web app).
Therefore:

- The embedded server is only usable while the app is **foreground / awake** — fine for a
  standalone "hub mode" demo, useless as the always-on core.
- **The always-on core must stay on Debian** (signaling server + Pi agent). Anything that must
  survive a lock cannot live on the iPad.
- (Same rule applies to any SFU such as mediasoup: it is a server process with no iOS port and
  would be suspended if forced into the app — keep it on Debian.)

## Risks / notes

- Background-audio entitlement is standard for call/monitor apps; the app must continuously
  record + play (it does), or iOS will terminate it.
- WebRTC iOS SDK is large but mature; mind bitcode/arch settings for Ad Hoc.
- Protocol parity is critical: mirror every signaling message the web clients send. Easiest to
  copy `signaling.js` + `camera.js` + `base-station.js` handling 1:1.
- Camera permission requires a user gesture on first launch (same as web, iOS 13+ AutoStart
  allowed; ≤12 needs a tap — mirror `enableCamera()`).

## Out of scope / deferred

- Pi agent → Sonos AirPlay: **plan 12** (deferred).
- LAN security (room PIN enforcement + Tailscale network isolation): required follow-up, not
  included here.
- App Store publication: not required for personal use; Ad Hoc / TestFlight-internal suffices.
