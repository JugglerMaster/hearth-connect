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

## Current coverage

| Test | Asserts |
|---|---|
| `tests/e2e-browser/e2e-pi-agent-interop.mjs` | `RTCPeerConnection` → `connected`, ≥1 remote track, total `bytesReceived` (**WARN only** if 0) |
| `tests/e2e-browser/e2e-verify-pi-video.mjs` | `connected`, ≥1 track, `videoBytes > 0` (**FAIL** if 0) |
| `tests/e2e-browser/e2e-talkback-glare.mjs` | talkback (browser→Pi) — **verify** it asserts audio bytes, not just connection |
| `tests/hermes-verify-auth.mjs` | client auth handshake (AUTH-first, queueing, one-time token, denied path) |
| `tests/node-verify-auth-settings.mjs` | Node reference-server auth kill-switch loopback gate (18/18) |

## Gaps

### G1 (P0) — No test fails if audio is dead
- **Evidence:** `e2e-verify-pi-video.mjs` asserts `videoBytes > 0` only.
  `e2e-pi-agent-interop.mjs` asserts total `bytesReceived` and only WARNs
  (exit 0) when it's 0. Neither separates audio from video.
- **Fix:** In both tests, split inbound-rtp bytes by `kind === 'audio'` and
  **FAIL** when `audioBytes === 0` (mirror the existing `videoBytes` check).
- **Files:** `tests/e2e-browser/e2e-verify-pi-video.mjs`,
  `tests/e2e-browser/e2e-pi-agent-interop.mjs`.

### G2 (P0) — Auth→media handoff untested
- **Evidence:** The auth change queues `JOIN_ROOM`/`SUBSCRIBE` until `AUTH_OK`
  (`signaling.js.send`), then flushes. Nothing tests that the flush happens
  in-order and media actually connects *after* auth.
- **Fix:** Extend `tests/hermes-verify-auth.mjs` to assert that after `AUTH_OK`,
  the queued room/sub messages flush and the connection reaches `connected`.
- **Files:** `tests/hermes-verify-auth.mjs`.

### G3 (P1) — No latency check
- **Evidence:** Sub-500ms latency is a stated goal but nothing measures it.
- **Fix:** In the interop test, sample `RTCPeerConnection` stats over a window
  and assert one-way/round-trip RTT stays under ~500ms.
- **Files:** `tests/e2e-browser/e2e-pi-agent-interop.mjs`.

### G4 (P1) — Audio channel count / downmix unverified
- **Evidence:** The Pi pipeline forces `channels=1` after `audioconvert`
  (`linux/pi-agent/pi-agent.py` ~598-605) to avoid the PS3Eye 4-channel
  silence regression, but nothing asserts the *encoded* stream is mono.
- **Fix:** Assert the Pi's encoded audio is 1 channel (or the browser's inbound
  audio track reports 1 channel).
- **Files:** `linux/pi-agent/pi-agent.py` (unit), `tests/e2e-browser/*` (E2E).

### G5 (P1) — Talkback may be audio-blind
- **Evidence:** `tests/e2e-browser/e2e-talkback-glare.mjs` exists, but verify
  it asserts **audio bytes reach the Pi**, not just peer connection.
- **Fix:** Add an `audioBytes > 0` assertion (Pi side) to the talkback test.
- **Files:** `tests/e2e-browser/e2e-talkback-glare.mjs`.

### G6 (P2) — ICE resilience untested
- **Evidence:** Nothing asserts ICE never settles to `failed`, or that it
  recovers after a network blip (reconnection strategy is documented but
  untested).
- **Fix:** Assert `connectionState` never ends in `failed` during a steady-state
  window; optionally simulate a blip and assert recovery.
- **Files:** `tests/e2e-browser/e2e-pi-agent-interop.mjs`.

## Recommended order of work
1. **G1** — audio-bytes assertions (highest signal for the reported problems).
2. **G2** — auth→media handoff (newest risk).
3. **G3** — latency.
4. **G4** — audio channel count.
5. **G5** — talkback audio bytes.
6. **G6** — ICE resilience.

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
