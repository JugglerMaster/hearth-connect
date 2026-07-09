# 03 — Camera / Kiosk Page Graceful Degradation

File: `server/public/js/camera.js`, `server/public/camera.html`

## Problem

`camera.js:58` `startCamera()` does a single `getUserMedia({video, audio:true})`.
On a Pi (or any device) missing a camera or mic, the whole call throws → `showCameraError`
and nothing is published.

## Changes

1. **Split acquisition** (`camera.js`):
   - `buildVideoConstraints(config)` → `{ video: {...} }` (from existing `buildConstraints`).
   - `buildAudioConstraints(config)` → `{ audio: true }` (+ optional processing constraints).
   - `startCamera()` becomes `startMedia()`:
     - Try video; on failure set `hasVideo=false`, keep going.
     - Try audio; on failure set `hasAudio=false`.
     - Build `localStream` by merging obtained tracks into one `MediaStream`.
     - Determine published type (`video+audio` / `video-only` / `audio-only` / `none`).
     - Publish only if type !== `none`.

2. **Soft error instead of hard modal** (`camera.html`):
   - Keep `cameraError` modal but only show it when *neither* track is available (true
     failure). When only one is missing, show a non-blocking status line
     (e.g. `debugCamStatus: 'cam:video-only'` / `'cam:audio-only'`).
   - Pi agent page (`pi-agent.html`) reuses this but hides the modal entirely.

3. **Enumerate + report cameras** (plan 09): after permission, call
   `navigator.mediaDevices.enumerateDevices()`, filter `videoinput`, and send them via
   `CAPABILITIES` (`videoDevices: [{id,label,facingMode}]`) plus `audioinput` devices. Re-send on
   `devicechange`. `buildConstraints` (plan 03 §1) uses `config.videoDevice` (deviceId) when set,
   else falls back to legacy `facingMode` for iPhones.

3. **Publish/unpublish on runtime change** (`camera.js`):
   - If camera is hot-plugged later, re-acquire and `publishSource`/`unpublishSource` as type
     changes. (Optional v1; can send `CAPABILITIES_CHANGED` if implemented in plan 01.)

4. **`restartCameraWithConfig`** (`camera.js:114`):
   - Restart only the missing/changed track; re-merge into `localStream`; call
     `updatePeerTracks()` so existing peer connections get the new track via `replaceTrack`/
     `addTrack`.

5. **`updatePeerTracks`** (`camera.js:98`): already iterates senders and replaces tracks by kind.
   Extend so that if a kind was previously absent and now present, it `addTrack`s it; if a kind
   was present and now absent, it removes the sender. (Use `pc.getSenders()` + `sender.track`.)
