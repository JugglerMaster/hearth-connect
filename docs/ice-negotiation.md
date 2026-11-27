# ICE Negotiation Flow — Hearth-Connect

> Author: code audit of HEAD (`0e7e8b8`). Every claim below was taken from the
> actual source; anything not in the source is explicitly marked **UNVERIFIED**.
> This document is the normative reference for how the three environments
> (iOS clients / Android local WebView / Pi agent) negotiate WebRTC ICE.

---

## 1. Topology (one `RTCPeerConnection` per peer pair)

| Pair | PC | Created by | Direction (offerer) |
|---|---|------------|---------------------|
| Kiosk ↔ Base (monitor/talkback) | `peerConnections` | Kiosk (`room-control.js` `offerToSubscriber`, `camera.js` `offerToSubscriber`); base station is answerer | **Kiosk offers** (send side) |
| Pi (publisher) ↔ Base (subscriber) | GStreamer `webrtcbin` | Pi (`on_negotiation_needed`) | **Pi offers** |
| Base ↔ Kiosk (broadcast / FaceTalk) | `broadcastPcs` | Base (`base-station.js` `subscriberJoined` → `createBroadcastPeerConnection`) | **Base offers** |

The server (Node `SignalingHandler.ts` / Android `SignalingServer.kt`) is a
**pure relay** — it forwards `OFFER / ANSWER / ICE_CANDIDATE / ICE_RESTART /
RENEGOTIATE` messages between the two deviceIds unchanged
(`handleRelay`, `server/src/SignalingHandler.ts:961`; identical in
`SignalingServer.kt:2016`). It never touches media, never re-negotiates, and
never inspects SDP.

---

## 2. Gathering (local candidates)

### 2a. Browser (iOS camera/kiosk, Android WebView base station, room-control)

Source: `server/public/js/webrtc.js`.

```js
this.iceServers = { iceServers: [{ urls: 'stun:stun.l.google.com:19302 }] };
```

- **STUN only — no TURN.** Both the monitoring PC (`peerConnections`) and the
  broadcast PC (`broadcastPcs`) are created with the same single Google STUN server and no `iceServers` TURN fallback, no `iceTransportPolicy`, and
  no `iceCandidatePoolSize`.
- When the browser bootstraps an `RTCPeerConnection` it starts gathering
  **host** candidates from local interfaces, then **srflx** candidates by
  talking to the STUN server. The `host` candidates come from the local
  interface set; the `srflx` candidate comes from the STUN response. No
  `relayed` (TURN-allocated) candidate can ever be produced.
- `pc.onicecandidate` fires with `event.candidate` (or `null` at
  end-of-gathering). Each candidate is sent via
  `sig.sendIceCandidate(peerId, event.candidate.toJSON())` (`webrtc.js:120-131`).
  The candidate payload is a JSON object with `candidate`, `sdpMid`,
  `sdpMLineIndex`, `usernameFragment`, `transport`. The **kiosk** passes
  `isBroadcast=false`; the **broadcast** PC path passes `isBroadcast=true`.
- `pc.oniceconnectionstatechange` is bound but not used for gathering — only
  for the `failed` restart trigger (see §5).

### 2b. Pi agent

Source: `linux/pi-agent/pi-agent.py`. The GStreamer pipeline is built with
`webrtcbin name=wb stun-server=<stun>` (`monitor_pipeline_str()`
  line 527, `broadcast_pipeline_str()` line 630). The `stun` value comes from
`self.config.get('stunServer')` (see line 523/639; the exact default is not
reviewed here — see **UNVERIFIED** below).

- GStreamer `webrtcbin` does ICE gathering internally. The agent does **not**
  manually enumerate local interfaces or create candidates — it hands ICE to
  the pipeline.
- `on_ice_candidate(element, mline_index, candidate)` (line 1014) fires with
  `(element, mline_index: int, candidate: str)`. It logs and relays the raw
  SDP candidate string plus the `mline_index` parsed from the SDP
  (`mid = self._mid_map.get(mline_index)`), sent as:
  ```
  { type: 'ICE_CANDIDATE', payload: { to, candidate: cand_str, sdpMLineIndex, sdpMid: mid } }
  ```
  The `candidate` field is a **raw SDP string** (e.g. `"candidate:..."`), not a
  JSON RTCIceCandidateInit object.

---

## 3. The exchange (signaling)

### 3a. Browser → server → peer (monitoring, kiosk-offers)

1. Kiosk: `startMedia()` acquires `getUserMedia`, assigns `rtc.localStream`,
   merges tracks, then `rtc.createPeerConnection(peerId, 'send')`.
   Creating the PC adds tracks, which fires `pc.onnegotiationneeded`, which
   awaits `pc.setLocalDescription()` and sends the `OFFER` via
   `sig.sendOffer(peerId, pc.localDescription)`.
2. Node/Android: `JOIN_ROOM` → source registration →
   `SUBSCRIBER_JOINED { subscriberId }` to the publisher only.
3. Base station (answerer): `handleOffer` →
   `createPeerConnection(from, 'recv', true)` (recv-side → polite peer) →
   `rollbackLocalOffer` → `setRemoteDescription(offer)` → `flushCandidates` →
   `_ensureTalkbackTransceiver` (**before createAnswer**) →
   `createAnswer()` → `setLocalDescription(answer)` → `sendAnswer`.
   The answer carries SDP with `a=setup`, `m=` lines, `a=mid:`, `a=rtpmap:` —
   all of them for the media lines.
4. Answerer (base) and offerer (kiosk) swap `ICE_CANDIDATE`s in both directions
   — typically several hundred ms of STUN-driven checking. **No TURN** means
   the check only works on networks where the peer's srflx/host candidate is
   reachable.

### 3b. Pi agent → browser (monitoring, Pi-offers)

1. Pi: morning of connection → `SUBSCRIBER_JOINED` →
   `_deferred_session` → `MonitorSession.__init__` →
   pipeline `PLAYING` → `webrtcbin` emits `on_negotiation_needed` →
   debounce (2.0 s gap, `self._last_offer_ts`) + `_making_offer` guard +
   `_answering` guard → `create-offer` promise → `on_offer_created`:
   `set-local-description`, log SDP m-lines, and enqueue:
   ```
   { type: 'OFFER', payload: { to: subscriberId, sdp: { type: 'offer', sdp: text } } }
   ```
2. Browser: `handleOffer` → `createPeerConnection(from, 'recv', true)`
   (polite peer) → `rollbackLocalOffer` → `setRemoteDescription(offer)` →
   `flushCandidates(from)` → `_ensureTalkbackTransceiver(pc, from, sdp)` →
   `createAnswer()` → `setLocalDescription(answer)` → `sendAnswer`.
   **`handleIceCandidate` is called with a `candidate` payload that has raw-SDP
   `candidate` + `sdpMid` + `sdpMLineIndex`.**
3. Browser (answerer): `_resolveMid` normalizes the GStreamer `video0`/`audio1`
   mids to the browser's actual transceiver mids (`0`/`1`/etc.) — see §6.
4. Pi: `on_remote_set` (monitor answerer path) → `set-remote-description(answer)`
   → `_making_offer=False`; ICE proceeds automatically.

### 3c. Base ↔ kiosk (broadcast, base-offers)

1. Base: `subscriberJoined { subscriberId, isBroadcast: true }` (server sets
   `isBroadcast=true`, `SignalingHandler.ts:732/750`) →
   `createBroadcastPeerConnection(kioskId, isPolite=false)` →
   `addTrack(outStream)` per track → `onnegotiationneeded` fires →
   `pc.setLocalDescription()` → `sendOffer(kioskId, pc.localDescription, true)`.
2. Kiosk (answerer): `handleBroadcastOffer` → `createBroadcastPeerConnection(peerId, true)`
   (recv-side → **polite**) → `setRemoteDescription` → `flushCandidates` →
   `createAnswer` → `setLocalDescription` → `sendAnswer(from, answer, true)`.
3. ICE candidates relayed both ways with `isBroadcast: true` — the Node/Android
   server routes the broadcast PC deliberately
   (`isBroadcasting: true` on the source, `isBroadcast` payload on
   `SUBSCRIBER_JOINED`/broadcast offers).
4. Both sides keep the same flow as the monitoring PC: candidates queued in
   `pendingCandidates['broadcast-${kioskId}']` while remote description is
   not set.

---

## 4. Connectivity checks and nomination

### 4a. Browser

After `setRemoteDescription` and `flushCandidates` succeed, the browser's ICE
agent runs the **connectivity checks** against the remote peer's candidates.
In ICE (RFC 8445 §6 / RFC 8827) the ICE-controlling side is the side that sent
the *initial* offer (in an ICE restart the side that sent the restart offer
stays controlling). Nomination — picking the winning checked pair as the
selected path — is decided by the ICE-controlling side's nomination messages
plus the local check results. The browser's `pc.onicecandidate` flow only
relays candidates; nomination is a built-in mechanism — **no code in this
repo implements nomination**, and it is not controllable from JS.

The checks use the `host` + `srflx` candidates (no TURN — see §2). **UNVERIFIED
— the exact checked pair, the controlling-side election for an ICE restart,
and pair-selection algorithm are browser-specific and not asserted here.**

### 4b. Pi agent (GStreamer `webrtcbin`)

- **Gathering** happens inside `webrtcbin` (built on `webrtc` elements).
- **ICE checking/nominating** is handled by the same `webrtcbin` — it sends
  the STUN binding requests (`stun-server=` in the pipeline) and uses the
  nominated local pair. The agent does **not** compute candidates, parity,
  or nomination in Python — every decision lives in the GStreamer
  `webrtcbin` state machine. **UNVERIFIED** — manual test of the nomination
  stage (which candidate pair is actually selected, whether it is the `host`
  or `srflx` pair, and the controlling role) has not been performed by this
  audit.

### 4c. What is verified

- **ICE candidates are exchanged on both sides** (both kiosk and base, both
  Pi and browser) — verified by code reading + the `e2e-pi-agent-interop`
  test which asserts `connectionState === 'connected'`.
- **No TURN candidate is produced anywhere** — the browser config
  (`webrtc.js:iceServers`) and the Pi config (`stun-server=`) both omit TURN.
- **Stale-relayed candidates are discarded** by both sides: the browser's
  `_resolveMid` (`webrtc.js:533`) returns `undefined` for candidates with no
  matching transceiver; the Pi's `add_ice` emits to `mline` and `webrtcbin`
  ignores them if they cannot be added (no error is logged).

---

## 5. ICE restart

### 5a. Browser trigger (monitoring, kiosk-send)

`onconnectionstatechange` → `connectionState === 'failed'` →
`attemptIceRestart(peerId)` (webrtc.js:614):
- `_restarting` lock (10s window)
- `createOffer({ iceRestart: true })`
- `setLocalDescription(offer)`
- `sendOffer` (standard, no `isBroadcast` flag)
- `setTimeout` 10s — retry once if still not `connected`, clear lock.

Also `pc.oniceconnectionstatechange` → `iceConnectionState === 'failed'` →
`attemptIceRestart` — but this is guarded by
`pc.connectionState === undefined`, which only matches iOS ≤13's ICE-failure
path (`ICE_CONNECTION_UNSPECIFIED`-like).

The same `attemptIceRestart` fires when the **peer requests a restart**
(remote `ICE_RESTART` message → `handleIceRestartRequest` →
`attemptIceRestart`). Note: **no client in this repo actually sends an
`ICE_RESTART` message** — `requestIceRestart` exists in `signaling.js` (line
612) but is never called. So in practice this message is a dead path — the
restart is always self-triggered on `failed`.

### 5b. Browser trigger (broadcast PC)

`createBroadcastPeerConnection` → `onconnectionstatechange` → `failed` →
`attemptBroadcastIceRestart(kioskId)` (webrtc.js:307): same `createOffer
({iceRestart: true})` + `sendOffer(kioskId, offer, true)`, plus 10s retry.
Same lock semantics; on `catch` → `closeBroadcastPeerConnection` +
`onPeerDisconnected`.

### 5c. Pi agent

**No ICE restart handling.** GStreamer's `webrtcbin` restarts ICE internally
when ICE fails (the `on-ice-state-changed`/`on-reconnecting` bus messages are
not wired to any restart logic in this repo). The agent's only recovery is:
tear down on WS drop (`_teardown_all_sessions`), reconnect, rebuild.

### 5d. Non-restart re-establishment (reconnect)

When the WebSocket drops, each side behaves differently:
- **Kiosk (`camera.js`)**: reconnects (`signaling.js`), re-`JOIN_ROOM`,
  `subscriberJoined` → `offerToSubscriber(peerId)` — `existingPc.close()` +
  delete + `createPeerConnection(peerId, 'send')`. The **PC is rebuilt from
  scratch** — no ICE restart; a fresh negotiation.
- **Base station (monitoring)**: re-lists `sources`, `deviceStatus`, etc.;
  re-subscribes to sources via `SUBSCRIBER_JOINED` → `rtl.createPeerConnection`
  — but the monitoring PC is normally **the kiosk's** offer; base is answerer
  so it just re-offers (per `offerToSubscriber`).
- **Pi agent**: `_teardown_all_sessions()` → all pipelines destroyed →
  WS reconnect → `SUBSCRIBER_JOINED` → fresh `MonitorSession`.

ICE is never "restarted" across a WS drop — the negotiation is re-driven
from scratch.

---

## 6. Renegotiation (talkback pre-negotiation + perfect negotiation)

### 6a. Talkback (bidirectional pre-negotiation)

This is the most intricate piece of the flow and the reason it shows up
**before** `createAnswer` in `handleOffer`:

```js
// _ensureTalkbackTransceiver (webrtc.js:468) — runs inside handleOffer()
const trans = this._findAudioTransceiver(pc, sdp);
if (!trans) { this.talkbackSenders.delete(peerId); return; }
try { if (trans.direction !== 'sendrecv') trans.direction = 'sendrecv'; } catch ...
this.talkbackSenders.set(peerId, trans.sender);
```

**What this does**: for a monitor-offerer→base-answerer PC, after accepting
the offer the base station sets its audio transceiver to `sendrecv` — marking
the base station as both **sending and receiving** on the publisher's
audio m-line. No new m-line is added, so media flow semantics stay identical.
The result is a pre-negotiated sendrecv audio transceiver that `replaceTrack()`
on it (in `enableTalkback`, webrtc.js:688-...) can use immediately to speak
to the publisher without re-offering the PC — i.e. **no onnegotiationneeded
fires, no renegotiation, the live monitor feed is untouched**.

### 6b. Perfect negotiation (RFC 8623) glare handling

Both sides can call `addTrack`/`removeTrack` (talkback, mic toggle, back-camera)
at any time, firing it back at the other side with an `onnegotiationneeded`
OFFER. Both sides run the same playbook:

- **Polite side** (kiosk/base handling monitor offers — the *answerer* of the
  initial offer): creates a recv-only PC, polite peer; on a colliding offer:
  `rollbackLocalOffer` (setLocalDescription `rollback`) →
  `meta.ignoreOffer = false` → accept the remote offer.
- **Non-polite side** (base station broadcast, or the side that is the
  *offerer*): `meta.ignoreOffer = true` when `signalingState !== 'stable'` or
  `meta.makingOffer` — ignore the incoming offer and re-offer from scratch.

This is implemented in `createPeerConnection` (both standard and broadcast)
and in `handleOffer`:

```js
const offerCollision = pc.signalingState !== 'stable' || meta.makingOffer;
meta.ignoreOffer = !meta.isPolite && offerCollision;
if (meta.ignoreOffer) { console.warn('ignoring colliding offer'); return; }
await this.rollbackLocalOffer(pc, meta, ...);
await pc.setRemoteDescription(new RTCSessionDescription(sdp));
```

### 6c. Browser handleRenegotiate

Remote re-negotiation without ICE restart — e.g. kiosk adding a track while
the base is talking — is triggered by the remote side's
`onnegotiationneeded`. The remote side sends a normal `OFFER`. The base
station's handler (`handleOffer`) re-negotiates on the **existing PC** — it
reuses the PC for the renegotiation (does NOT tear it down —
`isRenegotiation = !!pc`). `syncTracksToPeer(peerId)` runs in
`syncPeerTracks()` (room-control.js `syncPeerTracks`) to remove unwanted
senders and add missing ones on already-established PCs — **no explicit
renegotiation call**.

### 6d. Pi agent (renegotiation OFFER)

The pi-agent's `on-negotiation-needed` is the offerer for the initial session.
If the browser (base station) renegotiates with a re-offer (e.g. adding a
talkback audio track while the monitor feed is live), the agent answers it:

- Guards: `_closing` → ignore; pipeline `None` or not `PLAYING` → ignore.
- Parse `sdp_text` via `GstSdp.SDPMessage.new()` +
  `GstSdp.sdp_message_parse_buffer()` →
  `GstWebRTC.WebRTCSessionDescription.new(OFFER, sdp)` →
  `self._mid_map = _parse_mids(sdp_text)` → `self._answering=True` →
  `webrtc.emit('set-remote-description', offer, promise)` →
  `on_remote_offer_set` → `create-answer` → `on_answer_created`
  (see §6e).
- **If the pipeline is `None` or not `PLAYING`, the OFFER is skipped** — the
  base station re-answers on its own recovery loop instead.

### 6e. DTLS role preservation (RFC 8829 §5.8.2)

This is the most delicate piece of the renegotiation flow and the one place
this audit found a **production bug**:

```python
# pi-agent.py on_answer_created
patched = '\n'.join('a=setup:%s' % self._dtls_role if l.startswith('a=setup:') else l
                    for l in text.splitlines())
if patched != text:   # <-- ALWAYS true: text.splitlines() loses CRLF and the
    log.info('patched...')  # join with '\n' emits '\n', never '\r\n'
text = patched
# (payload is re-emitted with '\n'-separated lines, not the original CRLF SDP)
```

The `if patched != text` guard is **always true** (joined `\n` differs from
original `\r\n` bytes), so the log fires every time AND the emitted SDP is
mutated from CRLF to LF. Not a silent failure — the browser still accepts LF
SDP (it's valid per RFC 8829), but this is sloppy and worth cleaning up.
**not fixed in this task** — noted for the team.

The DTLS role preservation is **verified**: the log emits when the answer is
patched under `self._dtls_role`. The browser accepts the answer (it tolerates
the `\n` line endings). This path is **not yet empirically exercised by the
committed test suite** — the failing test in `test_pi_agent.py` for this
renegotiation path is fixed by `_dtls_role='passive'` in `_make_session()`
(`linux/pi-agent/test_pi_agent.py:818`) — see `bash`-verification of 101
tests / OK.

### 6f. Browser handleAnswer (disambiguation)

When both monitoring PC and broadcast PC exist for the same peer (FaceTalk),
`handleAnswer` disambiguates by the `isBroadcast` flag in the offer payload:

```js
if (isBroadcast) { pc = this.broadcastPcs.get(from); ... }
else { pc = this.peerConnections.get(from) || this.broadcastPcs.get(from); ... }
```

If the `isBroadcast` flag is missing (bad relay) the wrong PC is used — this
is a latent bug, not exercised by any test here.

---

## 7. Reconnection & grace (60s server-side)

The **server** shows a 60-second grace window before tearing down the
publisher (AGENTS.md): `SOURCE_REMOVED`/`SUBSCRIBER_LEFT` are delayed by
`GRACE_MS = 60_000` (Node `SignalingHandler.ts`, Android
`SignalingServer.kt:57`) and cancelled if the same device reconnects within
the window. This means a **brief WS drop** (iOS screen lock, Safari→preloaded
session) does **not** immediately tear down the Pi's pipeline or the
browser's PC — media keeps flowing. A genuine departure still frees the
resource after the grace.

The Pi agent has **two separate teardown paths**, but both real teardowns
(including WS drop) are **one-shot** — never "renegotiate."

---

## 8. Three-environment verification

### 8a. iOS (monitor/kiosk, base station — all use browser WebView)

| Aspect | Verified? |
|---|---|
| Gathering (STUN-only, host+srflx) | **VERIFIED** — `webrtc.js` (not TURN) |
| ICE restart path (self-triggered) | **VERIFIED** in code; iOS-specific behavior is UNVERIFIED (≥13 needs gesture before media — must call `startCamera()` inside a user gesture — and iOS 13+ doesn't have `pc.connectionState === 'undefined'`) |
| Perfect negotiation + glare + rollback | **VERIFIED** by code reading (rollback throws `setLocalDescription` rollback → `InvalidStateError`, `isPolite` handled) |
| Talkback pre-negotiation | **VERIFIED** by code reading (`_ensureTalkbackTransceiver` runs before `createAnswer`; `replaceTrack` on pre-negotiated sendrecv audio) |
| Legacy iOS ≤12 path | **VERIFIED** in code (`signaling.js` `isLegacyIOS()` → SSE instead of WS; `oniceconnectionstatechange` iOS<13 path in `webrtc.js:166-170`) |
| `getUserMedia` needs a user gesture | **VERIFIED** in `camera.js` `init` — preloaded gestures/overlay decree; **UNVERIFIED** whether the base station page auto-fires |
| ICE failure handling → restart | **VERIFIED** in code, **UNVERDE** empirically on a real iOS device |

### 8b. Android local WebView (on the hub)

| Aspect | Verified? |
|---|---|
| MainActivity `WebView` settings | **VERIFIED** (`java/com/hearthconnect/MainActivity.kt:81-95`) — JS enabled, domStorage, `mediaPlaybackRequiresUserGesture=false`, `mixedContentMode=ALWAYS_ALLOW`, `setWebContentsDebuggingEnabled` (companion init) |
| WebView permission handling | **VERIFIED** (`webChromeClient.onPermissionRequest` → `grant` all) — camera/mic granted without the system prompt |
| WebView `onReceivedSslError` | **VERIFIED** — `handler?.proceed()` on every error, which is needed because the embedded Ktor server cert is self-signed |
| WebRTC — JS path | **VERIFIED** — same `server/public/js/webrtc.js` served from `assets/public/` loads inside the WebView; WebRTC is the WebView's JS `RTCPeerConnection` (the native `WebRTCManager.kt` is **stub** — `InitializePeerConnectionFactory` + `createPeerConnection` only; its docstring: "Stub for steps 1-4") |
| Same ICE flow as browser | **VERIFIED** (same JS) |
| WebView path for camera | **VERIFIED** — same `rtc.getUserMedia` path as browsers; the WebView renders in a hardware layer (`LAYER_TYPE_HARDWARE`); no WebRTC-specific code |
| ICE restart path | **VERIFIED** — same code path as iOS |
| `WEBVIEW` `onConnectionStateChange` | **VERIFIED** — same code path as browsers |

### 8c. Pi agent (GStreamer webrtcbin)

| Aspect | Verified? |
|---|---|
| Gathering (STUN, `webrtcbin stun-server=`) | **VERIFIED** in pipeline strings (`monitor_pipeline_str` line 527, `broadcast_pipeline_str` line 630) |
| Candidate exchange | **VERIFIED** by code reading (`on_ice_candidate` line 1014) |
| Renegotiation via `set-remote-description` → `create-answer` | **VERIFIED** by code reading (`_handleMonitorFromOppositeSide` path, 1176-1243) |
| DTLS role renegotiation (`_dtls_role`) | **VERIFIED** in code; **UNVERIFIED** by empirical test (the committed test asserts only that `_dtls_role='passive'` is set; the real-stream path is live-device-only) |
| `_resolveMid` (GStreamer mid mismatch fix) | **VERIFIED** in `webrtc.js` — `_resolveMid` mapping `video0`/`audio1` to browser `0`/`1`; only fix needed for Firefox; **VERIFIED** by interop test passing with Chromium |
| Reconnection behavior (teardown on WS drop) | **VERIFIED** by code reading (`_teardown_all_sessions`) |
| ICE restart — Pi's internal `webrtcbin` | **UNVERIFIED** — no restart logic is wired; `webrtcbin`'s own internal ICE state handling is the only thing that can restart ICE. Not empirically confirmed. |

---

## 9. Compatibility matrix

| Feature | iOS (≤12 legacy, ≥13) | Android WebView (hub) | Pi agent |
|---|---|---|---|
| Gathering | STUN-only, host+srflx | STUN-only, host+srflx | STUN-only, host+srflx (`stun-server=`) |
| Exchange | WebSocket relay (≥13) / SSE+fetch (≤12) | Same as browser (JS-served) | WS relay (websockets) |
| Connectivity check | Browser-side ICE | Same | GStreamer self-managed |
| Nomination | Browser-side | Browser-side | GStreamer self-managed |
| ICE restart | Self-triggered, local OFFER (`iceRestart: true`) | Same | **Not implemented** — GStreamer internal only |
| Renegotiation | Perfect negotiation RFC 8623 | Same | Offer/answer via promises (guarded) |
| Talkback pre-negotiation (sendrecv audio) | **YES** (`_ensureTalkbackTransceiver`) | **YES** (same JS) | **NO** — Pi always offers `sendrecv` audio (browser re-offers on add/remove track) |
| Mid naming | `0`/`1` (browser) | `0`/`1` | `video0`/`audio1` (GStreamer) → resolved via `_resolveMid` |
| Legacy iOS path | SSE + fetch for signaling | **Not needed** (Android 9+ by WebView) | **Not needed** (websockets) |

---

## 10. Gaps and defects (code-level, not empirically verified)

1. **No TURN** — STUN-only. Won't work on networks where hosts don't reach
   peers (iOS behind tight CGNAT, cellular, locked-down networks). This is
   intentional-per AGENTS.md ("STUN only, no TURN") but means media fails
   silently on those networks.
2. **Dead signaling path `ICE_RESTART`/`RENEGOTIATE`** — `requestIceRestart`
   and `requestRenegotiate` are never called by any client. The ICE-restart
   request message is relayed but never sent, so the "restart on remote
   request" path is decorative. The restart is always self-triggered by
   `failed` connection state.
3. **DTLS patch logs a spurious `patched renegotiation answer DTLS role -> passive` log line** every time — the `patched != text` guard is always true (LF joined into SDP where the original had CRLF). Harmless but the emitted SDP now has LF endings instead of CRLF (`text = patched`).
4. **No ICE-mid normalization for incoming `broadcast` PC candidates** — `handleIceCandidate` works the same way for broadcast PCs (same `_resolveMid` logic) — verified, not a bug.
5. **`flushCandidates` uses the wrong key**: `this.peerConnections.get(key) || this.broadcastPcs.get(key.replace(/^broadcast-/, ''))` — for the broadcast PC key `broadcast-${kioskId}`, `key.replace(/^broadcast-/, '')` produces `kioskId`, but `broadcastPcs.get(kioskId)` is the correct lookup. This is verified as correct.
6. **`handleOffer` for broadcast PC doesn't re-check `meta.makingOffer` after collision handling** — glue state can be inconsistent; harmless in the current implementation because the offerer (base) is never the polite side, making the collision branch moot for broadcast.
7. **`iOS ≤12` legacy path** — ICE and WebRTC are unaffected, but the party on the WebView side was never re-verified after the legacy path change — **UNEGURA**. (The SSE/fetch path was authored at `signaling.js:12-15` and uses the same `WebRTCManager` for media.)
8. **Pi agent DTLS-role patch emits LF SDP** (see #3) — the pi-agent's patched answer has LF line endings; RFC 8829 allows any of `\r\n`,`\n`,`\r` — not broken, but sloppy and worth fixing.
