# 18 — Record-then-Play Broadcast (clip announcements)

> Replaces the live WebRTC path for **audio-only announcements** only.
> FaceTalk and talkback stay on WebRTC. See plan 17 for the as-built live path.

## Why

The live announcement path opens a **brand-new peer connection per broadcast**. Cold
ICE/DTLS takes 1–2 s, which is why `base-station.js` needs an 8 s grace teardown
(`stopAnnounce()`), and why the first word of every announcement is clipped. For a
one-way, audio-only PA message that entire machinery is unnecessary.

Recording the clip and handing every endpoint a URL:

- **Removes WebRTC from the announcement path** — no negotiation, no ICE, no stale-PC bugs.
- **Cannot clip the first word.**
- Survives iOS backgrounding (AGENTS.md: WebRTC does not).
- Makes non-WebRTC endpoints (Sonos / network speakers, plan 19) fall out for free —
  they become just another `PLAY_CLIP` consumer.

## Wire protocol

```
base                          server                    kiosk / Pi / speaker
 │                               │                             │
 ├─ POST /api/clip (WAV bytes) ─►│  store, TTL 5 min           │
 │◄─ {clipId, url, durationMs} ──┤                             │
 ├─ BROADCAST_CLIP ─────────────►│                             │
 │   {clipId, targetDeviceId}    ├─ PLAY_CLIP ────────────────►│  GET /clip/<id>.wav
 │                               │   {clipId,url,from,label}   │  → play
```

Two new message types: `BROADCAST_CLIP` (client→server, base-only) and `PLAY_CLIP`
(server→client). Both mirrored into the Kotlin hub.

## Audio format

**16 kHz mono 16-bit PCM WAV.** The only format playable by iOS Safari, GStreamer *and*
Sonos. ~32 KB/s, so a 5 s announcement is ~160 KB — trivial on a LAN.

`MediaRecorder` is deliberately **not** used: Chrome/Android WebView emits
`audio/webm;codecs=opus` (Sonos cannot play it) while Safari emits `audio/mp4`. Raw PCM
captured via Web Audio and wrapped in a WAV header is uniform everywhere.

`ScriptProcessorNode`, not `AudioWorklet`: this codebase still supports iOS 12
(`legacyIOS` in `ConfigManager.defaultConfig`, the eager-AudioContext comment at
`camera.js:443`), and `AudioWorklet` needs iOS 14.5+. Deprecated but universally
supported, and adequate for mono voice.

## Components

| Component | Change |
|---|---|
| `server/src/types.ts` | `BROADCAST_CLIP`, `PLAY_CLIP` in `MessageType`; `ClipInfo` |
| `server/src/ClipStore.ts` | **new** — in-memory store, TTL sweep, size cap |
| `server/src/index.ts` | `POST /api/clip`, `GET /clip/:id.wav` |
| `server/src/SignalingHandler.ts` | `handleBroadcastClip()` → fan-out `PLAY_CLIP` |
| `android/.../SignalingServer.kt` | same two routes + fan-out, clips in `cacheDir` |
| `server/public/js/signaling.js` | `broadcastClip()`, `playClip` event |
| `server/public/js/base-station.js` | capture → WAV → upload → `BROADCAST_CLIP` |
| `server/public/js/camera.js` | `PLAY_CLIP` → `remoteAudio.src` |
| `server/public/js/room-control.js` | same as camera.js |
| `linux/pi-agent/pi-agent.py` | `PLAY_CLIP` → urllib → `playbin` |

## Rules

- **Base-only** to send `BROADCAST_CLIP` (matches `BROADCAST_SOURCE`).
- `targetDeviceId` reuses the existing `'all'` → `undefined` normalization
  (`SignalingHandler.ts:504-509`) — a device literally named `all` must not match.
- `broadcastDisabled` is re-checked **server-side** at fan-out, not trusted to the client
  (same posture as `handleSubscribeBroadcast`).
- Clips expire after 5 minutes and are capped (2 MB each) to bound memory.
- Endpoints play at their configured `speakerVolume`.

## Rollout

`startAnnounce`/`stopAnnounce` switch to clip mode. The live broadcast code stays in place
for FaceTalk. Once clips are proven on real devices, the Pi's `BroadcastSession` can be
retired for announcements (it is still needed for FaceTalk video).

## Follow-on

Plan 19 (network speakers / Sonos) consumes `PLAY_CLIP` and needs only a plain-HTTP
connector, since Sonos will not accept the self-signed cert.
