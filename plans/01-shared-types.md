# 01 — Shared Types & Protocol Changes

Files: `server/src/types.ts`, `server/src/SignalingHandler.ts`,
`server/src/ChannelManager.ts`, `server/public/js/signaling.js`

## 1. Extend `SourceType` (`server/src/types.ts:6`)

```ts
export type SourceType = 'video+audio' | 'video-only' | 'audio-only' | 'none';
```

## 2. `DeviceType` — keep `kiosk` | `base` only

The Pi agent joins as `deviceType: 'kiosk'`. No new device type is required; the Pi is just a
headless kiosk. (Optionally add `'pi'` later, but not needed for this plan.)

## 3. Signaling handler — accept all SourceTypes

`server/src/SignalingHandler.ts:284` currently narrows to
`(payload.type as 'video+audio' | 'audio-only')`. Change to `as SourceType` and default to
`'video+audio'`. Validate it is one of the four allowed values; otherwise error.

## 4. ChannelManager — no structural change needed

`addSource` already takes `type: SourceType`. With `SourceType` extended, audio-only and
video-only sources flow through unchanged.

## 5. signaling.js — `publishSource` already forwards `type`

No change needed; `publishSource(sourceId, label, type)` already passes type through.

## 6. Add a `CAPABILITIES` message (required for source switching)

The Pi agent reports its available media devices so the base station can switch them.

- `MessageType` add `'CAPABILITIES'`.
- Pi agent sends (server relays / broadcasts like `DEVICE_STATUS`):
  ```
  { type:'CAPABILITIES', payload: {
      deviceId,
      videoDevices: [{ id, label }],   // e.g. /dev/video0 "Pi Camera"
      audioDevices: [{ id, label }],   // e.g. hw:1,0 "USB Mic"
  }}
  ```
- Base station stores this per device and renders video/audio source dropdowns
  in the config panel (see plan 06 + plan 04).
- Server should relay it to all clients (and include it in `WELCOME`/`DEVICE_STATUS` if
  persisted). Simplest: treat like `DEVICE_STATUS` — `broadcastAll` to everyone. Also store
  last-known capabilities on the `ConnectedClient` so a newly joined base station gets them
  (piggyback on `WELCOME` via a `capabilities` field, or send `CAPABILITIES` to the joiner
  on receipt).

## 7. Config fields for source selection

Extend `DeviceConfig` (`types.ts:9`) with optional:
```ts
videoDevice?: string;   // device id, e.g. "/dev/video0"
audioDevice?: string;   // device id, e.g. "hw:1,0"
```
These are ignored by iPad kiosks (browser `getUserMedia` doesn't take device ids the same way,
and `camera.js` `buildConstraints` only uses facingMode). The Pi agent reads them from
`CONFIG_UPDATED` and switches pipelines. Routing them through existing `SET_CONFIG` /
`CONFIG_UPDATED` requires **no new message type** — they just travel inside `config`.

## 8. `CAPABILITIES_CHANGED` (optional, for hotplug)

When the Pi's device list changes at runtime (camera/mic plugged in), re-send `CAPABILITIES`.
Base station re-renders. Optional for v1.

## 9. Audio threshold alert message + config

- `MessageType` add `'AUDIO_PEAK'` (see plan 07). Payload:
  `{ deviceId, levelDb, peak, ts }`. Server relays via `broadcastAll` (excludes sender), no
  storage.
- `DeviceConfig` additions (plan 07 §A):
  ```ts
  audioAlertEnabled?: boolean;
  audioAlertThresholdDb?: number;
  audioAlertHysteresisDb?: number;
  ```
  These ride on existing `SET_CONFIG` / `CONFIG_UPDATED` — no new config message.

## 10. Manual device removal message

- `MessageType` add `'REMOVE_DEVICE'` (base → server) and `'DEVICE_REMOVED'` (server → all
  clients). See plan 10. Server removes the target from in-memory `recentlySeenDevices`
  (`ChannelManager.removeRecentlySeen`, new method) and persists via `ConfigManager.deleteDevice`
  (already exists). Works for offline devices (they live in `recentlySeenDevices` even when
  offline); online devices are disconnected and may rejoin later.
