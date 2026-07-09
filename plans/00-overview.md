# Hearth-Connect — Raspberry Pi Agent Plan

## Goal

Add a new device class — a **Raspberry Pi agent** — that runs headless as a kiosk
(camera + mic) and joins a Hearth-Connect room. The agent streams the **camera if a
camera is available** and the **microphone if a microphone is available**, independently.
The base station must reflect stream availability: **grey out the Video (Monitor) button
when no video track exists**, and **fall back to audio-only monitoring** when only audio
is present.

This plan is split into per-system files in `plans/`:
- `plans/01-shared-types.md` — protocol/type changes (server + shared)
- `plans/02-pi-agent.md` — the new Raspberry Pi agent
- `plans/03-camera-page.md` — kiosk/camera page graceful degradation
- `plans/04-base-station.md` — grey-out / audio-only monitor UX
- `plans/05-webrtc.md` — WebRTC manager track-level changes
- `plans/06-source-switching.md` — Pi device enumeration + base-station source switching
- `plans/07-audio-threshold.md` — audio-above-threshold alerts (kiosk + Pi) + base-station meter
- `plans/08-watch-reconnect.md` — auto-recover the watch when the stream drops
- `plans/09-camera-enumeration.md` — real camera list for browser kiosks (front/rear vs laptops)
- `plans/10-device-removal.md` — manual "Remove device" button in settings

---

## Current Architecture (summary)

- Single-room matchmaker model. Devices are `kiosk` or `base`.
- Kiosks publish a source of `type: 'video+audio' | 'audio-only'` (see `types.ts:6`, `types.ts:89`).
- Base station subscribes (`SUBSCRIBE_SOURCE`) → kiosk gets `SUBSCRIBER_JOINED` → kiosk creates a
  `send` RTCPeerConnection and offers its local stream.
- `camera.js` calls `rtc.startCamera(constraints)` which does a single `getUserMedia({video, audio:true})`.
  If it fails entirely, the whole thing errors out (`showCameraError`).
- `base-station.js` `renderDevices()` always shows both an **Audio** and **Video** button per kiosk.

## Key Design Decisions

1. **Independent camera/mic acquisition.** Replace the all-or-nothing `getUserMedia` with two
   separate attempts: video first, then audio. Either can succeed independently. The published
   `SourceType` becomes `video+audio`, `video-only`, `audio-only`, or `none`. (We extend
   `SourceType` with `video-only`.)
2. **Source type advertised up-front.** `PUBLISH_SOURCE` already carries `type`. The base station
   uses it to decide button states. No new message needed.
3. **Per-track negotiation.** The kiosk adds only the tracks it actually has. Base station detects
   which tracks arrive on the recv `RTCPeerConnection` (`ontrack` kind) and enables Video/Audio
   buttons accordingly even if the advertised type was optimistic.
4. **Pi agent is a native headless client, not a browser.** Runs on Pi OS Lite (no desktop,
   no screen) as a Node/Python WebRTC client (GStreamer `webrtcbin`) that speaks the existing
   signaling protocol. This keeps `camera.html` / `camera.js` (the iPad kiosk) completely
   untouched — no bloat to the regular kiosk page or its settings UI. See `02-pi-agent.md`.

See individual plan files for implementation detail.
