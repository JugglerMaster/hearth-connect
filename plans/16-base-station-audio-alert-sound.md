# 16 — Base Station Audible Alert on Audio Threshold

Today when a source's audio crosses the configured threshold, the base station only shows a
**red box** around the device row (plan 07 §E, `base-station.js:1719`). This adds an **audible
alert** so an operator who isn't looking at the screen still hears that a room got loud.

## A. Trigger point (already exists)

The `sig.on('audioPeak')` handler (`base-station.js:1719`) already fires on the publisher's
rising-edge `peak:true` and stores `audioState[deviceId].alerting`. The audible alert hooks in
right there — play a sound when `data.peak === true` (rising edge only, never on the throttled
`peak:false` meter updates).

## B. Two implementation options

The operator asked for either **(1) connect to the WebSocket** (live audio) or **(2) play ~5s
of recorded audio**. Trade-offs:

### Option 1 — Live listen-in over WebRTC (subscribe on peak)
- On `peak:true`, the base station auto-subscribes to the alerting device's **audio-only**
  stream (reuse `SUBSCRIBE_SOURCE` + the existing recv `RTCPeerConnection` path in
  `base-station.js`, audio track only) and plays it through `<audio id="remoteAudio">`.
- Pros: operator hears the *actual* room, not a canned tone; already-built subscribe plumbing.
- Cons: needs a user-gesture-unlocked `AudioContext`/`<audio>` (iOS autoplay), adds a peer
  connection on every alert, and must auto-tear-down after N seconds of silence. Heavier.
- Note: the WebSocket itself carries **signaling only** (JSON), not media — "connect to the
  websocket" in practice means "use signaling to open a WebRTC audio subscription."

### Option 2 — Play a short recorded clip (RECOMMENDED first cut)
- Ship a small `server/public/audio/alert.mp3` (or `.ogg`), ~5s, and on `peak:true` do:
  ```js
  const alertSound = new Audio('/audio/alert.mp3');
  alertSound.volume = 0.7;
  alertSound.play().catch(() => {}); // may reject until first user gesture
  ```
- Pros: dead simple, no peer connection, deterministic, works offline. Best default.
- Cons: it's a canned tone, not the live room.

**Decision:** implemented **a variant of Option 2 using a WebAudio synthesized beep** (no
binary asset, no autoplay-blocked `<audio>` file). Option 1 remains a possible opt-in
"auto-listen on alert" later (it overlaps with plan 15's audio-only subscribe logic).

## C. Implementation (WebAudio beep) — IMPLEMENTED

**`server/public/js/base-station.js`**
- Module state: `alertSoundEnabled` (persisted to `localStorage.hearth_alertSound`, default on),
  a lazily-created `alertAudioCtx`, and a per-device `alertLastPlayed` debounce map
  (`ALERT_DEBOUNCE_MS = 10000`).
- `playAlertSound(deviceId)`: debounced per device; synthesizes ~5s of rising two-tone chirps
  with `OscillatorNode` + `GainNode` envelopes on the shared `AudioContext`. No media asset.
- `primeAlertAudio()`: creates/resumes the `AudioContext` on the **first** `click`/`touchstart`/
  `keydown` (registered `{ once: true }`) so iOS/Safari autoplay restrictions are satisfied.
- Hooked into `sig.on('audioPeak')`: fires only on the **rising edge**
  (`data.peak && !wasAlerting`).

**`server/public/base-station.html`**
- Added a global "Play sound on audio alert" checkbox (`#alertSoundToggle`) in the Devices panel.

**`base-station.js` toggle wiring**
- Checkbox reflects/persists `alertSoundEnabled`; toggling on primes audio and plays a preview
  beep (also serves as the user-gesture unlock).

## D. Notes

- Driven entirely by the existing `AUDIO_PEAK` relay — **no server changes**.
- Red-box visual (plan 07) is unchanged; the sound is additive.
- If Option 1 (live listen-in) is pursued later, gate it behind an explicit toggle and reuse
  plan 15's audio-only (no video) subscribe negotiation on the base station side.
