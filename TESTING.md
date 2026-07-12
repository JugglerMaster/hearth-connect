# Hearth-Connect — Testing & Manual Verification

## What is covered by automated tests
`server/test/server.test.ts` runs under Node (`npm test` in `server/`).
It covers signaling message routing with mock transports:
- Source publish / capabilities relay / late-join capabilities
- AUDIO_PEAK relay with server-authoritative deviceId
- REMOVE_DEVICE authorization + side effects
- **DOORBELL** relayed to all bases, never echoed to the ringer
- **CALL_STATE** relayed only to the target device
- `ChannelManager.broadcastToType()` type-scoped delivery

Run with:
```
cd server && npm install && npm test
```

## Server smoke test (real WebSocket)
Start the server, then connect two base clients and one kiosk over `ws://localhost:8090`,
have the kiosk send `DOORBELL`. Both bases should receive it; the kiosk should not.
Verified manually during this work.

## WebRTC — can NOT be verified headlessly here
No camera/microphone/iOS device is available in this environment. The negotiation
logic below was implemented to spec (RFC 8623 perfect negotiation) but MUST be
verified on real devices before shipping.

### Manual test matrix (baby monitor + intercom)

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Monitor video+audio | Base opens a kiosk feed | Base sees live video + hears room audio; volume slider + Mute affect audio live |
| 2 | Talkback (base→kiosk) | Base taps 🎙 Talk | Kiosk speaker plays base voice; base mic indicator active; tapping again stops |
| 3 | Two-way intercom | Base taps Talk while monitoring | Both directions audible (full duplex; no local echo) |
| 4 | Doorbell | Kiosk taps 🔔 Ring Doorbell | Every base shows "Incoming call" modal; Answer → feed opens + talkback on; Dismiss → modal closes |
| 5 | Call state on kiosk | Base answers/dismisses | Kiosk shows "Call connected"/"Call ended" toast |
| 6 | Connection quality | Base monitoring a kiosk | Monitor overlay shows bitrate / RTT / packet loss / jitter, updating |
| 7 | Renegotiation without dropping video | During monitoring, toggle talkback on/off repeatedly | Video keeps playing; no black flash / no frozen frame |
| 8 | ICE restart | Put device on/off WiFi mid-call | Stream recovers within ~10s; no full reconnect storm |
| 9 | Reconnect / grace period | Kill kiosk network 30s, restore | Source stays 60s; recovers on reconnect; no zombie PCs |
| 10 | iOS Safari quirks | iPad kiosk + iPhone base | HTTPS or localhost; camera prompt only after user tap (legacy iOS overlay); Wake Lock engaged; `playsinline` honored; backgrounding stops stream as expected |
| 11 | Audio focus / echo | Two kiosks monitored, talk to one | Only selected device's base audio is live; kiosk never plays its own mic (no feedback) |
| 12 | Broadcast (announcement) | Base starts broadcast, kiosk in `base` audio mode | Kiosk shows base video + plays base audio |

### Known limitations / not yet built
- **Announcement mode** (one-way audio push to selected/all kiosks without a full
  call) is partially covered by the existing broadcast feature; a dedicated
  "announce" button that pushes audio only (no video) is stubbed at the protocol
  level (CALL_STATE/DOORBELL exist) but not surfaced as its own UI action.
- **Per-device mute from the base on the kiosk speaker** is wired via the
  `audioMode` display config (set to `mute`); a quick per-row mute toggle in the
  device list is not yet added (the monitor-overlay Mute button covers the
  currently-viewed device).
- Real-device iOS verification (items 1–12) remains TODO.
