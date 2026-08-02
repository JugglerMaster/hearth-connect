# 17 — Live WebRTC Broadcast (REFERENCE / AS-BUILT)

> **Status: superseded for announcements by plan 18 (record-then-play clips).**
>
> This document is an as-built record of how the **live WebRTC "Broadcast Message"**
> path worked before plan 18. It is filed for later because:
>
> - **FaceTalk still uses this machinery** (`video+audio`, live, base → kiosk). Only the
>   audio-only *announcement* moves to clips.
> - Every workaround below was a real bug fix. If clips are ever reverted, or if FaceTalk
>   is refactored, these are the traps.
>
> Line numbers are as of commit `0690d48`.

## Wire flow (as-built)

```
base                     server                    kiosk / Pi agent
 │                          │                            │
 ├─ BROADCAST_SOURCE ──────►│                            │
 │  {sourceId,label,type,   ├─ SOURCE_ADDED ────────────►│  (targeted or all)
 │   targetDeviceId}        │   {…, isBroadcast:true,    │
 │                          │    targetDeviceId}         │
 │                          │◄──── SUBSCRIBE_BROADCAST ──┤
 │◄─ SUBSCRIBER_JOINED ─────┤                            │
 ├─ OFFER ─────────────────►├───────────────────────────►│
 │◄─ ANSWER ────────────────┤◄───────────────────────────┤
 │◄─ ICE_CANDIDATE ────────►├◄──────────────────────────►│
 │      … audio flows over a dedicated broadcast PC …    │
 ├─ UNBROADCAST_SOURCE ────►│                            │
 │                          ├─ SOURCE_REMOVED ──────────►│
```

Note the asymmetry: `BROADCAST_SOURCE` fan-out is **room-scoped** (the only handler that
is), while `UNBROADCAST_SOURCE` uses `broadcastAll`.

## Base station — `server/public/js/base-station.js`

| Concern | Location |
|---|---|
| Press-and-hold wiring | `attachBroadcastPanelListeners()` `:787-830` |
| Start | `startAnnounce()` `:869-908` |
| Stop | `stopAnnounce()` `:910-942` |
| Mic acquisition | `ensureAnnounceStream()` `:835-846` |
| Outgoing stream resolution | `:1850` |

**Traps encoded in this code:**

1. **Fast-tap race.** `announceHolding` + `announceGen`/`currentAnnounceGen` (`:869-884`) let a
   release that lands *during* the `await getUserMedia` cancel a broadcast that never started.
   Without it, a quick tap leaves the mic hot and a source published forever.
2. **8 second grace teardown.** `stopAnnounce()` does **not** close the peer connections on
   release. A broadcast opens a *brand-new* PC (cold ICE/DTLS ≈ 1–2 s), so immediate teardown
   killed the handshake before any audio arrived. `broadcastCloseTimer` (`:924-935`) defers it.
   *This is the root cause that record-then-play eliminates entirely.*
3. **`announceStream` is deliberately separate from `localBroadcastStream`** (FaceTalk's
   video+audio) so the two features never fight over the same mic tracks (`:833-835`).
4. **`broadcastTarget` `'all'` sentinel** (`:634`) — the dropdown's default value.
5. Window-level `mouseup`/`touchend` are bound **once** via `announceWindowBound` (`:823-829`);
   `renderDevices()` recreates the button repeatedly and would otherwise leak listeners.
   `endHold` only calls `preventDefault()` when actually ending a held broadcast — doing it
   unconditionally cancelled iOS's synthesized `click` and broke every delegated button.
6. **Duplicate function name:** `attachBroadcastPanelListeners` is defined twice (`:659` and
   `:787`). Hoisting means the second wins, so the `broadcastTargetSelect` change listener in
   the first is dead code.

## Server — `server/src/SignalingHandler.ts` (Kotlin mirror: `SignalingServer.kt`)

| Handler | TS | Kotlin |
|---|---|---|
| `BROADCAST_SOURCE` | `handleBroadcastSource` `:485-545` | `:~700` |
| `UNBROADCAST_SOURCE` | `handleUnbroadcastSource` `:547-573` | — |
| `SUBSCRIBE_BROADCAST` | `handleSubscribeBroadcast` `:575-620` | — |

**Traps:**

1. **`'all'` normalization** (`:504-509`). The base sends `'all'`; if passed through as a real
   target the fan-out filters for a device literally *named* `all`, matching nobody — the
   broadcast silently reached no one.
2. **`isBroadcast` / `targetDeviceId` are `as any` casts** (`:524-525`) — they are **not**
   declared on `MediaSourceInfo` in `types.ts:140-149`. The Kotlin `MediaSource`
   (`SignalingServer.kt:940-948`) *does* declare them properly.
3. **Authorization split:** `BROADCAST_SOURCE` is base-only (`:494`); `SUBSCRIBE_BROADCAST` is
   kiosk/room-only (`:581`). The Kotlin hub uses `BASE_TYPES = setOf("base","room")`
   (`SignalingServer.kt:1117`), so `room` devices can broadcast there but not on Node.
4. **Authoritative `broadcastDisabled` re-check** on subscribe (`:598-602`) — the server does
   not trust the client to honour its own opt-out.

## Browser kiosk — `server/public/js/camera.js`

| Concern | Location |
|---|---|
| `SOURCE_ADDED` gate | `:840-853` |
| Subscribe | `subscribeToBroadcast()` `:243-249` |
| Teardown | `unsubscribeFromBroadcast()` `:251-280` |
| Track attach | `rtc.onRemoteTrack` `:686-724` |
| Audio unmute | `applyRemoteAudio()` `:675-684` |

**Traps:**

1. **Broadcast PCs live in a separate map** (`broadcastPcs`) and must be closed with
   `closeBroadcastPeerConnection` — `closePeerConnection` only touches the monitor-PC map.
   Missing this left a stale PC that the *next* broadcast reused: the classic
   "worked once then stopped" bug (`:253-257`).
2. **`broadcastAudioActive` overrides the kiosk mute** (`:713-717`). Without it the kiosk stayed
   muted and every plain announcement was silently inaudible.
3. **`wasShowingBaseVideo` guard** (`:262-273`). An audio-only announcement never touches the
   `<video>`, so unconditionally re-applying the display config on teardown blanked a live
   camera preview the announcement had never disturbed.
4. `remoteAudio` (`monitor.html:15`) is shared by talkback, FaceTalk and announcements.
   **It is already unlocked inside a user gesture** — this is what makes plan 18's
   `remoteAudio.src = clipUrl` work on iOS without a new gesture.

## Pi agent — `linux/pi-agent/pi-agent.py`

| Concern | Location |
|---|---|
| `BroadcastSession` (recvonly answerer) | `:1132-1320` |
| `SOURCE_ADDED` gate | `:1954-1968` |
| `SOURCE_REMOVED` | `:1975-1982` |
| `broadcastDisabled` teardown | `:2141-2148` |
| WS-drop teardown | `_teardown_all_sessions()` `:2038-2053` |

**Traps:**

1. **`webrtcbin` is built programmatically, not via `parse_launch`** (`:1150-1172`). A single
   unlinked element string parses fine but `get_by_name('wb')` then returns `None`, so every
   `.connect()` crashed and the answer was never produced.
2. **Video is dropped to `fakesink`** — the Pi is headless (`make_video_recv_chain` `:633`).
3. **`_teardown_all_sessions()` on WS drop** (`:2038`). `self.sessions` is Agent-level and
   survives the WS reconnect loop; orphaned pipelines held `/dev/video*` open, keeping the
   camera red light on and blocking the next session.
4. **`broadcastDisabled` must unsubscribe queued sources too** (`:2146-2148`), not just live
   sessions — a source can be recorded before its OFFER arrives.

## What plan 18 replaces vs. keeps

| | Live WebRTC (this doc) | Clips (plan 18) |
|---|---|---|
| Audio-only announcement | **replaced** | `BROADCAST_CLIP` → `PLAY_CLIP` |
| FaceTalk (`video+audio`) | **kept** | — |
| Talkback (monitor PC) | **kept** | — |
| `BroadcastSession` (Pi) | retained for FaceTalk | `playbin`, ~50 lines |
| Cold-ICE grace window | needed (8 s) | **not needed** |
| First-word clipping | present | **eliminated** |
