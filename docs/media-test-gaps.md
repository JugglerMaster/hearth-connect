# Media Test Coverage Gaps (Audio/Video)

> Findings for another agent to act on. Origin: ad-hoc review of the device-auth
> (hub pairing) change + the user's recurring audio/video "not passing between
> devices" reports.

## Context

Recurring reports of audio/video not passing between devices. The current suite
is **video-heavy and audio-blind**: no test fails when audio is dead while video
works. The device-auth change (commit `5d69511`) added a second, new risk:
media-setup messages (`JOIN_ROOM`/`SUBSCRIBE`) are now queued until `AUTH_OK`
(`server/public/js/signaling.js:send`), then flushed — a race there yields
"connected but no media."

## Status

- ✅ **G1** — implemented. Both E2E tests now split inbound-rtp bytes by
  `kind === 'audio'` and **FAIL** when `audioBytes === 0`.
- ✅ **G2** — implemented. `tests/hermes-verify-auth.mjs` section 5 asserts the
  queued `JOIN_ROOM`/`SUBSCRIBE_SOURCE` flush in-order before `open` fires and
  that a media consumer (`WebRTCManager`) reaches `connected` after the handoff.
- ✅ **G3** — implemented. `tests/e2e-browser/e2e-pi-agent-interop.mjs` samples `rtt` from `rtcp-received` over a 5s window after media is flowing and **FAILs** if `maxRtt > 500` (sub-500ms goal); warns if no RTT stats.
- ✅ **G4** — implemented. `linux/pi-agent/test_pi_agent.py::TestMonitorPipelineStr.test_audio_downmix_forces_mono` asserts the monitor pipeline forces `channels=1` after `audioconvert` (both the `audio_channels=4` PS3Eye path and the zero-channel default path), guarding the 4-channel Opus silence regression.
- ⬜ **G5** — talkback audio bytes (open).
- ✅ **G6** — implemented. `tests/e2e-browser/e2e-pi-agent-interop.mjs` **FAILs** immediately if `RTCPeerConnection.connectionState` reaches `failed` during the steady-state window.

## Current coverage

| Test | Asserts |
|---|---|
| `tests/e2e-browser/e2e-pi-agent-interop.mjs` | `RTCPeerConnection` → `connected`, ≥1 remote track, `audioBytes > 0` (**FAIL** if 0) [G1] |
| `tests/e2e-browser/e2e-verify-pi-video.mjs` | `connected`, ≥1 track, `videoBytes > 0` **and** `audioBytes > 0` (**FAIL** if either 0) [G1] |
| `tests/e2e-browser/e2e-talkback-glare.mjs` | talkback (browser→Pi) — **verify** it asserts audio bytes, not just connection [G5] |
| `tests/hermes-verify-auth.mjs` | client auth handshake (AUTH-first, queueing, one-time token, denied path) + **auth→media handoff: flush-in-order-before-open, media reaches connected** [G2] |
| `tests/node-verify-auth-settings.mjs` | Node reference-server auth kill-switch loopback gate (18/18) |

## Gaps

### G1 (P0) — No test fails if audio is dead — **DONE**
- **Evidence:** `e2e-verify-pi-video.mjs` asserted `videoBytes > 0` only.
  `e2e-pi-agent-interop.mjs` asserted total `bytesReceived` and only WARNed
  (exit 0) when it was 0. Neither separated audio from video.
- **Fix (applied):** In both tests, split inbound-rtp bytes by `kind === 'audio'`
  and **FAIL** when `audioBytes === 0` (mirror the existing `videoBytes` check).
  The interop test now *waits* for `audioBytes > 0` (not just `connected` + track)
  before resolving, and the timeout now reports a `note` instead of a bare
  `connected` success.
- **Files:** `tests/e2e-browser/e2e-verify-pi-video.mjs`,
  `tests/e2e-browser/e2e-pi-agent-interop.mjs`.

### G2 (P0) — Auth→media handoff untested — **DONE**
- **Evidence:** The auth change queues `JOIN_ROOM`/`SUBSCRIBE` until `AUTH_OK`
  (`signaling.js.send`), then flushes. Nothing tested that the flush happens
  in-order and media actually connects *after* auth.
- **Fix (applied):** `tests/hermes-verify-auth.mjs` section 5 now loads `webrtc.js`
  (with a minimal fake `RTCPeerConnection`) and asserts, after `AUTH_OK`:
  - the queued `JOIN_ROOM`/`SUBSCRIBE_SOURCE` flush in-order **before** `open`
    fires (a media consumer acting on `open` never sees it before room/sub are
    registered);
  - the signaling connection is fully connected (`authed`, `connected`,
    `authState === 'authed'`);
  - a `WebRTCManager` that creates a monitor PC in response to `open` reaches
    `connected` (its `onConnectionStateChange` is invoked and `pcMeta.connected`
    is set).
- **Files:** `tests/hermes-verify-auth.mjs`.

### G3 (P1) — No latency check — **DONE**
- **Evidence:** Sub-500ms latency is a stated goal but nothing measured it.
- **Fix:** `tests/e2e-browser/e2e-pi-agent-interop.mjs` collects `rtt` from
  `rtcp-received` stats (moving avg, ms), samples a 5s latency window after
  `audioBytes > 0`, and **FAILs** if `maxRtt > 500` (sub-500ms goal). Warns
  (not fails) when no RTT stats are available.
- **Files:** `tests/e2e-browser/e2e-pi-agent-interop.mjs`.

### G4 (P1) — Audio channel count / downmix unverified — **DONE**
- **Evidence:** The Pi pipeline forces `channels=1` after `audioconvert`
  (`linux/pi-agent/pi-agent.py` ~598-605) to avoid the PS3Eye 4-channel
  silence regression, but nothing asserted the *encoded* stream is mono.
- **Fix:** `linux/pi-agent/test_pi_agent.py::TestMonitorPipelineStr.test_audio_downmix_forces_mono`
  asserts the monitor pipeline string forces `channels=1` after `audioconvert`
  (both the `audio_channels=4` PS3Eye path and the zero-channel default path),
  guarding the 4-channel Opus silence regression.
- **Files:** `linux/pi-agent/test_pi_agent.py` (unit).
- **Note:** A browser-side E2E assertion of the *encoded* stream's channel count
  is not feasible with `getStats()` (no channel-count field), so the pure
  `monitor_pipeline_str()` unit test is the strongest available guard.

### G5 (P1) — Talkback may be audio-blind — **spec**
- **Evidence:** `tests/e2e-browser/e2e-talkback-glare.mjs` exists, but it only
  asserts talkback attached + no renegotiation + stream stayed up. It does **not**
  assert that audio bytes actually reach the Pi.
- **Fix:** Add an `audioBytes > 0` assertion (Pi side) to the talkback test.
- **Files:** `tests/e2e-browser/e2e-talkback-glare.mjs`, `linux/pi-agent/pi-agent.py`.

**Implementation spec (Pi-side measurement):**
1. The Pi receive chain (`make_audio_recv_chain`) currently is:
   `queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! volume name=rxvol ! <sink>`.
   Insert a named `level` element (`rxlevel`) after `audioresample` and before
   `volume name=rxvol` so the received talkback audio is measured.
2. The bus `ELEMENT` handler currently routes *any* `level` structure to
   `on_audio_level` (peak alerts). Distinguish by element name (`message.get_source().get_name()`):
   - `rxlevel` → new `on_rx_audio_level(self, db)` (logs received talkback level, throttled).
   - the send `level` (audio peak) → `on_audio_level(self, db)` (unchanged).
3. `on_rx_audio_level` logs e.g. `rx audio level: <db> dB` only when the received
   level is above a small threshold (so the log only fires when audible talkback
   actually arrives).
4. The talkback test, after enabling talkback and the wait window, parses the
   agent log (`/tmp/opencode/talkback-agent.log`) for the `rx audio level` marker
   and **FAILs** if the Pi never received audible audio.

**Constraints:** keep the receive chain's existing `volume`/`mute` behavior and
  dynamic-pad handling; do not trigger renegotiation; keep the test CI-safe
  (auto-skip when GStreamer/`websockets`/server/Chromium are absent).

**Verification:** `python3 -m unittest test_pi_agent` (GStreamer-free pure path
  unchanged); `node --check` the talkback test; run the talkback test against a
  live hub + Pi (or `TEST_SOURCE=1`) to confirm the `rx audio level` marker
  appears when talkback is active.

### G6 (P2) — ICE resilience untested — **DONE**
- **Evidence:** Nothing asserted ICE never settles to `failed`, or that it
  recovers after a network blip (reconnection strategy is documented but
  untested).
- **Fix:** `tests/e2e-browser/e2e-pi-agent-interop.mjs` **FAILs** immediately
  if `RTCPeerConnection.connectionState` reaches `failed` during the steady-state
  window. (Blip-simulation/recovery is out of scope for now.)
- **Files:** `tests/e2e-browser/e2e-pi-agent-interop.mjs`.

## Recommended order of work
1. **G5** — talkback audio bytes.

(G1, G2, G3, G4 and G6 are implemented — see *Status*.)

## Acceptance criteria
- Running the full media suite **fails** when audio is dead (not just video).
- A post-auth media-setup race is caught by the suite.
- A latency regression (>500ms) is caught.
- A 4-channel PS3Eye-style stream is caught (mono assertion).

## Notes for the agent
- E2E tests auto-SKIP when GStreamer / `websockets` / the server / Chromium are
  absent, so they are CI-safe; keep any new test auto-skip-friendly.
- The interop test must run against a live server (`SERVER_URL`) and a Pi agent
  (or `TEST_SOURCE=1`); the live-device variant is `e2e-verify-pi-video.mjs`.
- Audio-bytes checks need the browser to actually receive an audio track; assert
  the track exists *and* has bytes (a track that never starts delivering should
  also fail).
