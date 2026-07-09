# 09 — Camera Enumeration for Browser Kiosks (front/rear vs real devices)

The base station config panel hardcodes a **Front / Rear** camera `<select>`
(`base-station.js:167`). That only makes sense for an iPhone (which has `user`/`environment`
facing modes). A laptop has one camera with **no facing mode** — selecting "Rear" just falls
back to the same default lens, and the label is misleading. The kiosk has no way to know what
cameras actually exist, so it can't offer the right choices.

## A. Kiosk enumerates real video devices

In `camera.js`, after media permission is granted (labels become available), call
`navigator.mediaDevices.enumerateDevices()` and filter `kind === 'videoinput'`. Build:

```
videoDevices = devices.map(d => ({
  id: d.deviceId,                       // stable once permission granted
  label: d.label || 'Camera ' + i,     // e.g. "FaceTime HD Camera", "USB Webcam"
  facingMode: guessFacing(d),          // 'user' | 'environment' | null  (best-effort)
}))
```

- `guessFacing`: use `d.getCapabilities?.()` / `track.getSettings().facingMode` when available
  (iPhone reports `user`/`environment`); otherwise `null` for laptops/USB cams.
- Report these via the same `CAPABILITIES` message used by the Pi (plan 01 §6 / plan 06):
  ```
  sig.send('CAPABILITIES', {
    deviceId,
    videoDevices,            // [{id,label,facingMode}]
    audioDevices,            // browser: enumerate kind==='audioinput'
  })
  ```
- Re-send `CAPABILITIES` on `devicechange` event
  (`navigator.mediaDevices.addEventListener('devicechange', ...)`) so hotplugged USB cams appear.

> This unifies the browser kiosk and the Pi agent: both report `CAPABILITIES`; the base station
> renders source pickers from whatever was reported. The Pi's `videoDevices` carry V4L2 paths; the
> browser's carry `deviceId` + facing hint.

## B. Base station: render real camera options

In `base-station.js` `showConfig()` (`base-station.js:159`), replace the hardcoded Front/Rear
`<select>` with one driven by `capabilitiesByDevice[device.id].videoDevices` (plan 06):

- If the device reported `videoDevices`:
  - Populate the camera `<select>` from those entries (label as the visible text, `id` as value).
  - Pre-select the entry matching `device.config.videoDevice` (browser deviceId) or, for legacy
    iPhone configs, the entry whose `facingMode` matches `config.camera` (`user`/`environment`).
- If the device reported **no** capabilities (old client / never sent `CAPABILITIES`):
  - Fall back to the existing Front/Rear options for backward compatibility.

## C. Kiosk: apply selected camera

In `camera.js` `buildConstraints(config)` (`camera.js:30`):

- If `config.videoDevice` (a real `deviceId`) is set, use it directly:
  ```
  video: { deviceId: { exact: config.videoDevice }, width, height, frameRate }
  ```
- Else fall back to the legacy `facingMode` (`config.camera === 'rear' ? 'environment' : 'user'`),
  preserving current iPhone behavior.
- On `CONFIG_UPDATED` with a changed `videoDevice`, restart the camera (existing
  `restartCameraWithConfig` path, plan 03) so the new lens is used.

## D. Config field reuse

Reuse the `videoDevice` string field added in plan 01 §7. For browser kiosks it holds a
`deviceId`; for the Pi it holds a V4L2 path. Both flow through `SET_CONFIG` / `CONFIG_UPDATED`
unchanged. `DeviceConfig.camera` (`'front'|'rear'`) stays as the legacy iPhone hint and is only
used when `videoDevice` is absent.

## E. UX notes

- Labels are only populated **after** the user grants camera permission; before that, entries show
  generic names. The kiosk sends `CAPABILITIES` again once permission is granted so labels fill in.
- The base station may briefly show generic names until the kiosk re-reports — acceptable.
- This removes the misleading "Rear" choice on laptops: the select now lists the actual lens(es).
