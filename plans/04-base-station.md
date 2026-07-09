# 04 — Base Station: Grey-out & Audio-only Monitor

File: `server/public/js/base-station.js`, `server/public/base-station.html`

## Goal

- The **Video (Monitor) button is disabled/greyed out** if the selected device has no video
  stream available.
- The **Audio button always works** if audio is available (even with no video).
- When monitoring a video-only or audio-only source, show the correct placeholder.

## Data source for button state

Each published source carries `type` (`video+audio` | `video-only` | `audio-only`).
`sources` is already populated in `base-station.js:250` (`data.sources`) and updated via
`sourceAdded`/`sourceRemoved`. We map a device to its source type:

```
function sourceTypeFor(deviceId) {
  const src = sources.find(s => s.publisherId === deviceId);
  return src ? src.type : null;
}
```

## Changes in `renderDevices()` (`base-station.js:64`)

For each kiosk, compute `type = sourceTypeFor(d.id)`. Render buttons:

- `audio-btn`: disabled (greyed, `btn-disabled`, no click handler) if `type` is `null` or
  `video-only` (no audio). Otherwise active.
- `video-btn`: disabled (greyed) if `type` is `null`, `audio-only`, or `none`. Otherwise active.

Add CSS class `.btn-disabled { opacity:.4; pointer-events:none; }` (or reuse existing muted style).
Add a small capability hint, e.g. `🎥+🎤`, `🎥`, `🎤` next to the device name derived from `type`.

## Changes in `startView()` (`base-station.js:89`)

- If `mode === 'video'` but the device has no video (`type === 'audio-only'`), fall back to
  `mode = 'audio'` and show a brief notice ("No camera — listening to audio only").
- Guard: do not allow starting video mode on a device lacking video.

## `applyViewMode()` (`base-station.js:46`)

Already handles audio-only by hiding video and showing placeholder. Verify it keys off actual
received tracks (`stream.getVideoTracks().length`) rather than assumed mode, so a device that
advertised `video+audio` but only sent audio still shows the placeholder correctly.

## Optional: live track detection

In `rtc.onRemoteTrack` (`base-station.js:217`), after the stream updates, recompute the
effective mode: if no video tracks but `viewMode === 'video'`, downgrade to audio and update UI.
This covers cases where advertised type was optimistic or changed at runtime.

## Pi source switching UI (see plan 06)

For devices that report `CAPABILITIES` (Pi agents), `showConfig()` also renders:
- a **Video source** `<select>` from `capabilities.videoDevices`
- an **Audio source** `<select>` from `capabilities.audioDevices`

Save sends `videoDevice` / `audioDevice` inside the existing `SET_CONFIG` payload. These rows
are hidden for plain iPad kiosks (no capabilities). After a switch, the Pi re-publishes with a
(possibly new) `SourceType`; the Video button re-enables when video becomes available.

## Camera options from real devices (see plan 09)

The hardcoded Front/Rear camera `<select>` is replaced by options built from the device's
reported `videoDevices` (via the shared `CAPABILITIES` message). This fixes the laptop case where
"Rear" is meaningless — the select now lists the actual lens(es) (e.g. "FaceTime HD Camera",
"USB Webcam"). Legacy iPhone clients without `CAPABILITIES` keep the Front/Rear fallback.
Browser kiosks report `videoDevices` from `enumerateDevices()` and apply the chosen `deviceId` in
`buildConstraints`.

## Audio threshold alert = red box (see plan 07)

Driven by `AUDIO_PEAK` events, the alert is a **red box around the device list item**, not an icon:
- `renderDevices()` adds the `audio-alert` modifier class to the `.device-item` when that device's
  audio is peaking; CSS outlines the row in `--danger` (see plan 07 §E). Auto-clears after a few
  seconds with no new peak. Devices with no audio source never get the class.
- Devices with no audio (per `sourceTypeFor`) are unaffected.
- Config panel exposes `audioAlertEnabled` + `audioAlertThresholdDb` for devices with audio.

## Keep the device list visible while monitoring

Currently `startView()` → `showMonitor()` hides `#homeView` (which contains `#deviceList`) and
shows `#monitorFeed` instead (`base-station.js:128-139`). Change so the device list **stays on
screen** when you press Video/Audio on a kiosk:

- `showMonitor()` (`base-station.js:128`): **do not** add `.hidden` to `#homeView` / `#deviceList`.
  Only reveal `#monitorFeed` (it sits above `homeView` in the DOM, so the feed shows on top and the
  list scrolls below).
- `showHome()` (`base-station.js:136`): only hides `#monitorFeed`; `homeView` is never hidden, so
  the list is always present.
- Net effect: clicking a kiosk's Video/Audio opens the monitor feed **without removing the device
  list**, so the user can switch sources / start another device / see the red audio-alert boxes on
  other rows while watching.
- `renderDevices()` is still called on every state change, so the list stays live (and the
  `audio-alert` boxes keep updating) during monitoring.

## Watch auto-reconnect on stream drop (see plan 08)

`recoverWatch()` re-subscribes and re-negotiates when the watched `RTCPeerConnection` fails or a
watchdog detects no track activity (bad/black stream). Shows a non-blocking "Reconnecting…"
status; only errors/gives up after a timeout with no recovered track. Preserves `viewMode`
(video/audio fallback from above still applies after recovery).
