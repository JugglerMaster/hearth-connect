# 11 — Testing Strategy

## What is tested now (runnable, zero new deps)

Server-side protocol/logic is covered by `server/test/server.test.ts` using Node's built-in
`node --test` runner with `ts-node/register` (already a devDependency). Run with:

```
cd server && npm test
```

`ts-node` lets the tests import the TypeScript source directly (`src/ChannelManager`,
`src/ConfigManager`, `src/SignalingHandler`) with a lightweight fake `WebSocket`, so no browser
or running server is required. A config `after` hook disposes each `ConfigManager` so the
autosave interval doesn't keep the process alive.

### Coverage map (which change each test verifies)

| Plan / stage | Behavior | Test |
|---|---|---|
| 01 / Stage 0 | `SourceType` extended; `addSource` updates type in place, no duplicate | `addSource updates type in place` |
| 01 / Stage 0 | `removeRecentlySeen` clears in-memory list | `removeRecentlySeen deletes…` |
| 01 / Stage 0 | capabilities stored per client | `capabilities roundtrip…` |
| 01 §7 / Stage 0 | `videoDevice`/`audioDevice` persisted & deletable | `deleteDevice removes…` |
| 01 / Stage 0 | `PUBLISH_SOURCE` accepts `video-only` | `PUBLISH_SOURCE accepts extended SourceType` |
| 01 / Stage 0 | `PUBLISH_SOURCE` unknown type → `video+audio` fallback | `PUBLISH_SOURCE falls back…` |
| 01 §6 / Stage 0 | `CAPABILITIES` stored + relayed to other clients | `CAPABILITIES is stored and relayed…` |
| 01 §6 / Stage 0 | late-joining base gets prior `CAPABILITIES` | `late-joining base receives…` |
| 07 / Stage 0 | `AUDIO_PEAK` relayed with server-side `deviceId` (no spoof) | `AUDIO_PEAK is relayed…` |
| 10 / Stage 0 | `REMOVE_DEVICE` (base) closes socket, clears list + config, broadcasts | `REMOVE_DEVICE as base…` |
| 10 / Stage 0 | `REMOVE_DEVICE` rejected for non-base | `REMOVE_DEVICE rejected for non-base` |

## Browser-side tests (not yet automated)

`camera.js` and `base-station.js` are IIFEs that touch the DOM + WebRTC, so they aren't directly
importable. Two options:

1. **jsdom + fake signaling (recommended for logic)** — add `jsdom` as a devDependency and:
   - Extract pure helpers (`sourceTypeFor`, `hasVideo`, `hasAudio`, audio-dB → peak decision,
     capabilities→`<select>` option building) into small exported functions, then unit-test them.
   - For integration, load `signaling.js` + a stub `WebRTCManager` under jsdom, drive
     `sig.on('capabilities'|'audioPeak'|'deviceRemoved')`, and assert `deviceList.innerHTML`
     (greyed buttons, `.audio-alert` class, removed row).
2. **Manual / e2e** — use `public/test.html` + a real base station + iPhone kiosk and the
   `sigtest.js` script (already present) to confirm relay end-to-end.

## Pi agent tests (not runnable here)

`pi-agent.py` requires GStreamer + a camera/mic, so it can't run in CI. Strategy:
- Unit-test the **pure logic** (device enumeration parsing of `v4l2-ctl`/`arecord -l` output,
  `source_type()` decision, peak/hysteresis state machine) by importing those functions with
  GStreamer/websockets mocked.
- Validate the GStreamer **pipeline strings** by constructing a `WebrtcSession` with fake devices
  and asserting the launch string (without `set_state(PLAYING)`), on a Pi or a Linux box with
  GStreamer installed.
- End-to-end: run on a Pi OS Lite box against the real server and watch the base station.

## Recommendations
- Keep `npm test` green as the gating check for all server changes.
- Before merging browser/Pi work, add the jsdom tests (option 1) for the grey-out, red-box, and
  watch-reconnect logic — those are the highest-risk UI behaviors added in Stages 1–2.
