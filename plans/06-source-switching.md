# 06 — Pi Device Enumeration & Source Switching

Lets the base station **see the Pi's available video/audio inputs** and **pick which one to
use** (e.g. switch from the Pi CSI camera to a USB webcam, or from the onboard mic to a USB mic).

## A. Pi agent: enumerate devices

In `pi-agent.py` (see plan 02), probe at startup and on hotplug:

- **Video devices**: enumerate `/dev/video*`; for each, run
  `v4l2-ctl -d <dev> --list-formats-ext` and confirm it is a *capture* device
  (`--device-capabilities` includes `V4L2_CAP_VIDEO_CAPTURE`). Build:
  ```
  videoDevices = [ { id: "/dev/video0", label: "Pi Camera (IMX219)" },
                   { id: "/dev/video2", label: "USB Webcam" } ]
  ```
  (Label from `v4l2-ctl --list-devices` or `udevadm`.)
- **Audio devices**: `arecord -l` → cards/subdevices; map to ALSA ids
  (`hw:CARD=<name>,DEV=<n>`). Build:
  ```
  audioDevices = [ { id: "hw:CARD=Headphones,DEV=0", label: "USB Mic" },
                   { id: "default", label: "Default ALSA" } ]
  ```

## B. Pi agent: report capabilities

On join (`JOIN_ROOM` → `WELCOME`) and whenever the list changes, send:

```
sig.send('CAPABILITIES', {
  deviceId,
  videoDevices,   // [{id,label}]
  audioDevices,   // [{id,label}]
})
```

Also remember the currently selected `videoDevice` / `audioDevice` (from config or first
available) and include them so the base station can show the active selection.

## C. Server: relay `CAPABILITIES`

In `SignalingHandler.ts`, add a `case 'CAPABILITIES'` that:
- Stores latest capabilities on the `ConnectedClient`
  (add `capabilities?: { videoDevices, audioDevices }` to `ConnectedClient` in `types.ts:77`).
- `broadcastAll({ type:'CAPABILITIES', payload }, senderId)` to all other clients.
- On a new client `JOIN_ROOM`, after `WELCOME`, forward the most recent `CAPABILITIES` it has
  for each known device (so a late-joining base station sees sources immediately).

No persistence required (devices are ephemeral / Pi-specific); re-sent on every reconnect.

## D. Base station: show & switch sources

In `base-station.js` (`showConfig`, plan 04 area):

1. Store `capabilitiesByDevice[deviceId] = { videoDevices, audioDevices }` from the
   `capabilities` event (`sig.on('capabilities', ...)`).
2. In `showConfig(device)` (`base-station.js:159`), if the device has capabilities:
   - Render a **Video source** `<select>` populated from `videoDevices`, pre-selected to
     `device.config.videoDevice` (or first entry).
   - Render an **Audio source** `<select>` populated from `audioDevices`, pre-selected to
     `device.config.audioDevice` (or first entry).
   - These rows are only shown when `videoDevices`/`audioDevices` are non-empty (i.e. Pi agent,
     not a plain iPad kiosk).
3. On **Save**, include in the `SET_CONFIG` payload:
   ```
   sig.setConfig(device.id, {
     ...existing fields,
     videoDevice: selVideo.value || undefined,
     audioDevice: selAudio.value || undefined,
   });
   ```

## E. Pi agent: apply source selection

On `CONFIG_UPDATED` (`pi-agent.py`):
- Read `config.videoDevice` / `config.audioDevice`.
- If changed from current pipeline source:
  - Stop the affected `webrtcbin` pipeline(s) for all subscribers (or re-create sessions).
  - Rebuild the video `v4l2src device=<videoDevice>` / audio `alsasrc device=<audioDevice>`
    branch with the new device.
  - Re-publish source with the (possibly changed) `SourceType` and re-offer to subscribers.
- If a selected device id no longer exists in `videoDevices`/`audioDevices`, fall back to the
  first available and re-send `CAPABILITIES` + re-publish.

## F. UX notes

- The base station already greys out the **Video** button when `SourceType` has no video
  (plan 04). Switching to a video-capable device re-enables it after re-publish.
- Source dropdowns appear for **any** device that reported `CAPABILITIES` — both Pi agents (plan 02)
  and browser kiosks (plan 09). Plain iPad kiosks without `CAPABILITIES` keep the legacy Front/Rear
  fallback, so their config panel is unchanged.
