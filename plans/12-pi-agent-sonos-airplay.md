# 12 — Pi Agent → Sonos AirPlay (DEFERRED)

> Status: **deferred** (filed for later). Not part of the iOS app work. Depends on the
> existing `deploy/pi-agent/pi-agent.py` (plan 02). Scope: "broadcasts out only" — route the
> base station's "Broadcast Message" announcements to Sonos AirPlay 2 speakers, independent
> of the monitor's state.

## Why the Pi agent is the right place

`deploy/pi-agent/pi-agent.py` already:

- Subscribes to broadcast sources (`SUBSCRIBE_BROADCAST`) and answers the base's offer
  (`BroadcastSession`, lines 248–348).
- Decodes the incoming Opus audio to PCM and plays it through an ALSA sink
  (`make_audio_recv_chain`, lines 84–98; wired in `BroadcastSession.on_pad_added`, lines 282–285).

It runs on the Debian LAN box (same subnet as the Sonos), so the audio is **already terminated
and decoded there** — only the *output* changes. No browser changes, no WebRTC added to the
Node server, no new native base app.

## Steps

1. **Spike (gate — the only real unknown).** On the Debian box:
   - `pip install pyatv` (or build `play-acting` / try `airplay2`).
   - `pyatv scan` to confirm the Sonos appears as an AirPlay 2 target.
   - Stream a local test WAV/MP3 to it; confirm playback + measure latency.
   - If Sonos is flaky over AirPlay 2 from Linux, fall back to an AirPlay 1 speaker or a
     different sender lib. This step decides feasibility before any code is written.
2. **Config (env).** Add to the agent:
   - `AIRPLAY_TARGET` — device name/id, or `auto` (first discovered AirPlay 2 speaker).
   - `AIRPLAY_VOLUME` — 0.0–1.0, fed from `speaker_volume()` (already in `Agent`).
   - `AIRPLAY_MODE` — `sonos` (Sonos only) | `both` (Sonos + local `alsasink`, default).
   - `RECEIVE_ONLY=1` — subscribe to broadcasts without forcing a published camera+mic source,
     so the agent can be a dedicated "broadcast → Sonos" appliance (no capture hardware needed).
3. **Audio routing.** In `BroadcastSession`, replace/augment the `alsasink` with a GStreamer
   `tee` so the decoded PCM is also encoded (ALAC for AirPlay 1, AAC for AirPlay 2 via
   `avenc_aac` / `avenc_alac`) and piped to the AirPlay sender. Default `both` keeps the local
   Pi speaker too.
4. **Discovery.** mDNS/Bonjour lookup of AirPlay targets on the LAN (reuse `pyatv scan` or a
   `zeroconf`/avahi call) to resolve `AIRPLAY_TARGET` to an IP.
5. **Volume.** Drive per-speaker volume through the sender/Sonos API from `speaker_volume()`;
   re-apply in `apply_config` (`Agent.apply_config`, lines 568–609) when `CONFIG_UPDATED` arrives.
6. **Docs.** Note in AGENTS.md / README that the Pi agent can act as an AirPlay broadcast sink.

## Caveats

- **AirPlay 2 (Sonos) sender from Linux is the risk.** If the spike fails, this whole feature
  is blocked until a working sender is found. AirPlay 1 speakers are the safe fallback.
- The agent remains a signaling client of the Debian hub; it does not replace the hub.
- This solves only *outbound* announcement audio to speakers. The monitor's *mic capture*
  while locked is a separate (iOS-native) concern — see plan 13.
