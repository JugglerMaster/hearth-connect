# Code Review — Device Authentication (deny-by-default hub pairing)

**Date:** 2026-11-13
**Scope:** Uncommitted working-tree changes on `main` (21 files, ~1,750 insertions),
implementing the AUTH-first pairing protocol described in `AGENTS.md`.

**Verdict:** Solid, well-documented feature. The core security design (token-not-deviceId
identity, SHA-256-at-rest, one-time token delivery, loopback-only admin plane, bounded
pending table with TTL) is sound. **One high-severity gap** (remote kill-switch flip via
`SET_SETTINGS`) and a few medium/minor items below. Recommend fixing H-1 before shipping;
the rest can be follow-ups.

## Verification performed

| Check | Result |
|---|---|
| `cd android && ./gradlew compileDebugKotlin` | ✅ rc=0 |
| `cd server && npx tsc --noEmit` | ✅ rc=0 |
| `node tests/hermes-verify-auth.mjs` | ✅ all checks passed |
| `cd linux/pi-agent && python3 -m unittest test_pi_agent.py` | ⚠️ 1 failure — **pre-existing on HEAD** (verified via `git stash`): `TestTalkbackRenegotiation.test_set_remote_offer_answers_renegotiation` expects 1 ANSWER, gets 0. Not caused by this diff, but main is red. |

## What's good

- **Identity model is right.** The hub stores only `SHA-256(token)`; `deviceId` is
  explicitly treated as a display field, not identity (`handleJoinRoom` updates the
  credential's label/deviceId without re-auth). Token is 32 bytes from `SecureRandom`,
  delivered exactly once over the live socket, and approval is discarded if the socket
  is gone (no plaintext ever persisted server-side).
- **Strict pre-auth state machine.** Any non-`AUTH` frame from an unauthenticated socket
  gets `ERROR{AUTH_REQUIRED}` + close `4009`; no room state leaks. Heartbeat is
  sensibly exempted while PENDING.
- **Admin plane is loopback-gated.** `AUTH_DECISION`, `REVOKE_CREDENTIAL`,
  `GET_AUTH_STATE` all reject non-loopback callers; `AUTH_STATE`/`AUTH_PENDING`
  broadcasts go only to loopback sockets.
- **DoS guards.** 3 pending max, 5-min TTL, sweeper every 5 s, one pending row per IP
  (retry reattaches instead of stacking), input lengths capped (`.take(16)`/`.take(64)`).
- **Client behavior is careful.** `signaling.js` queues all sends until `AUTH_OK`, emits
  `open` only once, handles 4003/4004/4008/4009 distinctly, has a 4 s fallback for
  pre-auth servers, and the overlay is injected on every page.
- **Legacy migration is thought through.** Harvest-once window in its own file
  (survives restarts), revoke consumes the window (no silent fallback), legacy JOIN
  clients keep the window open until a real token is presented, and the UI badges them.
- **Tests updated consistently:** `sigtest.js`, `e2e_smoke.py`, both Playwright interop
  tests (skip-with-instructions on `AUTH_REQUIRED`, hard-fail on `AUTH_INVALID`), plus a
  new `tests/hermes-verify-auth.mjs` that exercises the real `signaling.js` handshake.
- **Docs:** `AGENTS.md` section is thorough and matches the implementation.
- **XSS hygiene in the new UI:** `base-station.js` escapes all interpolated
  label/ip/code values via `esc()` before `innerHTML`.

## Findings

### H-1 · The auth kill-switch can be flipped by any remote `base` device
`SignalingServer.kt:handleSetSettings` (~line 1707) accepts **any section** from any
client with `deviceType == "base"` that has joined the room. `signaling.js:setRequiresApproval`
sends `SET_SETTINGS {section:"auth", value:{requiresApproval:false}}` — which means a
remote (LAN) base station can disable approval gating for the whole hub, after which
every new device is auto-trusted (`handleAuth` → credentialId `"open"`), and can also
re-enable it to cover tracks. The rest of the admin plane (`AUTH_DECISION`,
`REVOKE_CREDENTIAL`, `GET_AUTH_STATE`) is carefully loopback-only; this one door is open.

**Fix:** in `handleSetSettings`, reject `section == "auth"` unless
`connLoopback[connId] == true` (same guard as `handleAuthDecision`). Ideally whitelist
sections writable by non-loopback bases at all.

### M-1 · Legacy JOIN_ROOM trust window never closes for old clients
`handleUnauthenticatedJoin` trusts a pre-auth `JOIN_ROOM` whenever the *claimed*
`deviceId` is in `legacyPending` — and deliberately does **not** consume the entry
(old JS can't store a token). Until the real device reloads and AUTHs with a minted
token, anyone on the LAN who knows/guesses a legacy deviceId can claim it and join
without pairing. `AGENTS.md` acknowledges deviceId is spoofable; this is the one path
where spoofing still buys room access indefinitely.

**Mitigations to consider:** bound the window in time (e.g. auto-consume legacy entries
N days after upgrade), consume on first legacy JOIN and re-derive from persisted
`device_configs.json`, or at least log legacy-JOIN joins at WARNING and surface a
persistent "legacy client still active — reload it" row in the Access panel so the
owner closes the window.

### M-2 · `GET /clip/{file}` is unauthenticated — recorded announcements are LAN-readable
Documented as intentional (unpaired devices must be able to play `PLAY_CLIP` URLs),
but the recorded WAVs can contain family voices, and clip IDs are the only barrier.
`POST /api/clip` is now token-gated while the read side is open.

**Consider:** require `X-Hearth-Token` on the GET too, with a fallback: endpoints that
receive `PLAY_CLIP` over an authenticated socket could get a short-lived per-clip nonce
embedded in the URL. At minimum, note the exposure in `AGENTS.md`/`REMOTE-ACCESS.md`
(the current AGENTS.md line does mention it — good — but the privacy implication
deserves an explicit callout).

### M-3 · One-pending-per-IP starves the first device behind NAT
`grantPending` reattaches the outstanding row to the newest `connId`. With two devices
pairing simultaneously from the same IP (normal for a household behind one NAT), the
second device's AUTH steals the row; approval delivers the token only to the latest
socket, and the first device sits on its overlay until TTL with no `AUTH_DENIED`
(pending row is gone, sweeper has nothing to expire for it). The anti-spam rationale is
sound, but the first socket should at least be closed (`4008`-style) when its pending
row is reattached to a different connId, so its client retries and re-enters the queue.

### L-1 · Pre-existing red test on main
`test_set_remote_offer_answers_renegotiation` fails identically with and without this
diff (0 answers instead of 1). Unrelated to auth, but it makes the pi-agent suite
unusable as a gate. Fix or xfail before relying on CI.

### L-2 · `signaling.js` 4 s auth fallback can race a slow hub
If `AUTH_REQUIRED` takes >4 s (loaded hub, slow TLS handshake on a Pi-class device),
`_sendAuth`'s fallback declares `legacy-server` authed, flushes `JOIN_ROOM`, and gets
`4009`-closed; the client then loops (backoff reset for 4009) until a reply beats the
timer. Consider: only arm the fallback when the server is *silent* (no `AUTH_REQUIRED`
ever received) — it already is — but also skip the fallback flush while `authState ===
'pending'`, and/or raise the timeout. Low likelihood; noting for completeness.

### L-3 · `ws_pump` silently drops pre-auth messages (pi-agent)
`if not self._auth_ok: continue` discards queued messages instead of deferring them.
In practice the only pre-auth producers are startup capabilities (already dropped
pre-change when ws is down) and the 10 s refresh loop, so nothing important is lost —
but a `log.debug` on drop would save someone an hour of head-scratching.

### L-4 · Pairing code in logcat at DEBUG
`Log.d(TAG, "pairing code for ...")` — commented as deliberate ("human cross-check, not
a secret"), and approval requires physical hub access, so acceptable. Debug builds on
rooted/userdebug devices do capture it; consider gating behind `BuildConfig.DEBUG`.

### L-5 · `retryAuth()` stale-socket `onclose` writes shared state
`retryAuth` nulls `this.ws` and connects a new socket, but the *old* socket's `onclose`
handler still fires asynchronously and sets `this.connected = false; this.authed =
false;` + emits `close`. Ordering (old close before new open) makes this benign in
practice, but if it ever fires late it would mark a healthy authed socket as down until
the next reconnect. Detach handlers (`this.ws.onclose = null`) before closing in
`retryAuth`.

### L-6 · `send()` now returns `true` while disconnected
Previously `send()` returned `false` + warned when not connected; now everything is
queued and returns `true`, with a silent cap at 100 (`outbox.length < 100` drops
without a word). Callers that checked the return value get different semantics. Add a
`console.warn` on outbox overflow.

### Nits
- `SignalingServer.kt`: `connIdCounter` is a plain `var` incremented from coroutine
  context (`"conn-${++connIdCounter}"`) — pre-existing, but the auth maps now key off
  it; make it `AtomicInteger` while nearby.
- `startAuthSweeper` uses `runBlocking` inside `teardownScheduler.scheduleAtFixedRate` —
  fine for a 5 s sweep, but it shares the scheduler with teardown work.
- `sha256Hex`/`hexId` use `java.lang.String.format` per byte — fine at this scale,
  slightly unidiomatic.
- `server/dist/*` rebuilt and included — consistent with repo convention (dist is
  tracked); the compiled output matches the `src` change.
- `e2e_smoke.py`: AUTH_OK wait is 10×1 s of *timeout* iterations; a chatty server could
  extend the effective wait, which is fine.
- `base-station.js`: `renderRequireToggle` defaults to ON until `settingsResult`
  arrives — correct default, matches server.

## Security model summary (as implemented)

| Surface | Gate |
|---|---|
| WebSocket (non-loopback) | `AUTH` first; token or pending-approval; else 4009 |
| Approve/deny/revoke/read device list | loopback only ✅ |
| `auth.requiresApproval` kill-switch | any joined `base` ❌ (**H-1**) |
| `POST /api/clip` | token header or loopback ✅ |
| `GET /clip/*.wav`, static pages, `/api/server-url`, cert | open (documented) ⚠️ (M-2) |
| Node reference server | always `AUTH_OK` — ungated by design (documented) |

## Recommended actions before commit

1. **H-1:** loopback-guard `SET_SETTINGS{section:"auth"}` in `handleSetSettings`.
2. Add a hermes/e2e assertion that a non-loopback base cannot flip `requiresApproval`
   (mirrors the existing `AUTH_DECISION` loopback tests).
3. Decide on M-1 (time-bounded legacy window) — even just a TODO + AGENTS.md note.
4. File/fix L-1 separately so the pi-agent suite is green again.
5. Rebuild the APK with `./gradlew clean assembleDebug` when deploying (symlinked
   assets gotcha per AGENTS.md — `compileDebugKotlin` alone doesn't ship the new JS).
