# 07 — Audio Threshold Alerts (Kiosk + Pi Agent)

When a publishing device (iPad kiosk or native Pi agent) detects live audio **above a configured
threshold**, it notifies the server, and the base station shows a **lit audio icon + current dB
level** in the device list. Works for audio-only, video+audio, and video-only (audio present) sources.

## A. Config

Add to `DeviceConfig` (`types.ts:9`):
```ts
audioAlertEnabled?: boolean;     // default true
audioAlertThresholdDb?: number;  // default -40 (dBFS-ish); alert when peak > threshold
audioAlertHysteresisDb?: number; // default 6; drop alert only after falling this far below
```

Base station config panel (plan 04) gets two new rows for Pi/kiosk devices:
- "Audio alert" toggle
- "Threshold (dB)" number input

These travel through existing `SET_CONFIG` / `CONFIG_UPDATED` — no new message for config.

## B. New signaling message: `AUDIO_PEAK`

Add `MessageType` `'AUDIO_PEAK'` to `types.ts:99`.

Publisher → server → relayed to all clients:
```
{ type:'AUDIO_PEAK', payload: {
    deviceId,
    levelDb: -23.5,        // current measured level
    peak: true,            // true when crossed above threshold (rising edge)
    ts: 1234567890
}}
```
- Server relays via `broadcastAll` (like `DEVICE_STATUS`), excluding sender.
- `peak: true` is sent on the **rising edge** (cross above threshold + hysteresis). While above
  threshold, the device may still send periodic `levelDb` updates (throttled, e.g. every 1s) with
  `peak: false` so the base station can show a live meter even when not on the "edge".

## C. Kiosk (browser) implementation — `camera.js`

- On `configUpdated`, read `audioAlertEnabled` / `audioAlertThresholdDb` and (re)create an
  `AnalyserNode` from the local audio track:
  ```
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(rtc.localStream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  src.connect(analyser);
  ```
- Poll via `requestAnimationFrame` / `setInterval(~,200ms)`: compute RMS → dB
  (`20*log10(rms)` with a floor at -100). Track state machine with hysteresis:
  - below (threshold - hysteresis) → `armed = true`
  - above threshold and `armed` → send `AUDIO_PEAK {peak:true}`; `armed = false`
  - always (if enabled) send throttled `AUDIO_PEAK {peak:false, levelDb}` ~1/s for the meter.
- Only run while a local audio track exists. If audio-only or video+audio, both work; if
  video-only (no audio), send nothing (base station shows no audio icon — consistent with plan 04
  grey-out).

## D. Pi agent implementation — `pi-agent.py`

- GStreamer level element: insert `level` (or `loudness`) into the audio branch:
  ```
  alsasrc device=... ! audioconvert ! audio/x-raw,rate=48000 ! level interval=200000000 ! ...
  ```
- `level` emits `rms` (dB) messages; the control script reads them, applies the same hysteresis
  state machine, and sends `AUDIO_PEAK` with `levelDb` / `peak`.
- Respect `config.audioAlertEnabled` / `config.audioAlertThresholdDb` from `CONFIG_UPDATED`.

## E. Base station — `base-station.js`

- Store `audioState[deviceId] = { levelDb, alerting, lastTs }` from `sig.on('audioPeak', ...)`.
- **Visual notification = red box around the device list item** (no icon/meter):
  - In `renderDevices()` (`base-station.js:64`), the device row already has
    `class="device-item" data-id=...`. Add a modifier class `audio-alert` when
    `audioState[d.id]?.alerting` is true.
  - CSS (new rule in `style.css`):
    ```css
    .device-item.audio-alert {
      outline: 2px solid var(--danger);
      box-shadow: 0 0 0 2px var(--danger);   /* red box around the item */
      border-color: var(--danger);
    }
    ```
  - `alerting` is set on a `peak:true` rising edge and **auto-clears after a few seconds** with no
    new peak (timer in `sig.on('audioPeak')`), or when the level falls back below threshold.
  - Devices with **no audio source** (per plan 04 `sourceTypeFor`) never get the class.
- Optional: keep a tiny live `-dB` text in the device row for at-a-glance level, but the primary
  alert is the red box. (The icon/meter approach from earlier drafts is replaced by the box.)

## F. Notes

- `AUDIO_PEAK` is cheap (a few small JSON messages/sec max). Throttle meter updates to ~1Hz and
  only send `peak:true` edges.
- No server storage needed; purely relayed. Re-sent on reconnect by the publisher re-reading its
  config and restarting the analyser.
