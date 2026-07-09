# 08 — Watch Reconnection on Stream Drop

Ensures the base station **recovers automatically** when the media stream it is watching drops —
bad/black stream, ICE failure, publisher crash, or network glitch — without the user manually
hitting Stop/Video again.

## Problem

Today (`base-station.js` + `webrtc.js`) the base station:
- Subscribes via `SUBSCRIBE_SOURCE` → kiosk offers → `onRemoteTrack` attaches.
- `webrtc.js:83` `onconnectionstatechange` logs `failed` and calls `attemptIceRestart`, but if
  restart fails it only calls `onPeerDisconnected` (a no-op stub in base-station.js).
- If the publisher silently stops sending (bad stream / black frames but connection "connected"),
  **nothing** detects it and the monitor just freezes.

## Goals

1. Auto-detect a dead watch session (ICE failed, connection closed, or no frames/audio for N s).
2. Auto-recover: re-subscribe + re-negotiate, preserving the current `viewMode` (video/audio).
3. Surface a non-blocking "Reconnecting…" state in the monitor overlay; only error if recovery fails.

## A. Detection

In `base-station.js`, extend `rtc.onConnectionStateChange` / `onIceConnectionStateChange`
(`base-station.js:224-230`) to act on the watch peer:

- `failed` / `disconnected` / `closed` for `viewingId` → call `recoverWatch()`.
- **Silent-drop guard**: in `rtc.onRemoteTrack`, record `lastFrameTs` / `lastAudioTs`. A
  `setInterval` (the "watchdog", ~2s) checks: if watching and no track activity for
  `WATCH_DEAD_MS` (e.g. 8s) while `connectionState` is supposedly live → `recoverWatch()`.
- **Expected-track set**: the watchdog keys off what the source is *supposed* to have, from
  `sourceTypeFor(viewingId)` (plan 04):
  - `audio-only` → dead only if **no audio** activity (never flagged for missing video).
  - `video-only` → dead only if **no video** activity (never flagged for missing audio).
  - `video+audio` → dead if **neither** video nor audio activity.
  This prevents false "dead stream" recovery on legitimately single-track sources (e.g. the Pi
  publishing `audio-only`, or a camera-only feed).

## B. Recovery

```
function recoverWatch() {
  if (!viewingId) return;
  if (recovering) return;
  recovering = true;
  showMonitorStatus('Reconnecting…');
  rtc.closePeerConnection(viewingId);
  subscribed.delete(viewingId);
  // re-arm subscription (server will send SUBSCRIBER_JOINED → kiosk re-offers)
  sig.subscribeSource(viewingId);
  // timeout: if no onRemoteTrack within RECOVER_TIMEOUT (e.g. 10s), show error + stop
}
```

- On `onRemoteTrack` for `viewingId` during recovery: re-attach, re-apply `viewMode`, clear
  `recovering`, hide "Reconnecting…".
- This reuses the exact same path as a first-time `startView` (`base-station.js:89`), so video vs
  audio fallback (plan 04) still applies after recovery.

## C. WebRTC manager support — `webrtc.js`

- Make `onPeerDisconnected` (currently a stub, `webrtc.js:243`) actually fire for the base station
  too (it already exists; base-station.js just needs to override it and call `recoverWatch`).
- `attemptIceRestart` (`webrtc.js:204`) already restarts once; keep it, but on final failure it
  calls `onPeerDisconnected` — now wired to recovery instead of a no-op.
- Ensure a fresh `recv` RTCPeerConnection is created on the next `OFFER` (handleOffer already does
  `createPeerConnection(from,'recv')`, replacing the old one).

## D. Signaling edge cases

- If the publisher is truly offline, `SUBSCRIBE_SOURCE` → server can't find publisher →
  `NOT_FOUND` error (`SignalingHandler.ts:339`). Base station shows "Device offline" and stops
  recovery after the timeout (don't loop forever).
- If the publisher comes back (re-JOIN_ROOM) mid-recovery, a `SUBSCRIBER_JOINED` may arrive and
  re-offer; guard `recoverWatch` so a late offer still succeeds.

## E. UX

- Monitor overlay gets a small status line (`#monitorStatus`, add to `base-station.html`
  `.monitor-overlay`) showing "Reconnecting…" / "Reconnected".
- Never auto-stop the watch on a single drop; only give up after `RECOVER_TIMEOUT` with no track.
