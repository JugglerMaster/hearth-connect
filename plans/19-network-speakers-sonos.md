# 19 — Network Speakers / Sonos on the Android hub (plan 18 follow-on)

> Consumes `PLAY_CLIP` (plan 18). The **Android hub** discovers Sonos / UPnP
> renderers on the LAN and plays recorded announcements to them. This is the
> explicit **exception** to the "server is a matchmaker only — no media passes
> through it" rule (see AGENTS.md): recorded audio only, not live WebRTC.

## Why on the hub (not the agent)

Originally scoped for the Pi agent (plan 12/18), but reconsidered: the hub
already stores the clip bytes, is always-on, and sits on the same LAN as the
speakers. Pushing a recorded WAV to a Sonos is a one-shot file + UPnP call, not
a stream relay — so the "keep media off the server" rationale (avoid an SFU,
avoid a media-process burden) does not apply. Live WebRTC (FaceTalk / talkback)
still never touches the hub. **Soft** reasons the hub is acceptable: failure
isolation is weaker (a hub crash also drops signaling), but on a single LAN
that is a minor risk; the upside is one place to own discovery + playback.

The one hard constraint that does not move with placement: **SSDP discovery
must run on a device sharing the Sonos's subnet** (multicast is link-local).
The hub qualifies (it is the LAN's central server).

## Discovery (zero-dep, Android stdlib)

`SonosManager` (new Kotlin file) does an SSDP M-SEARCH to `239.255.255.250:1900`,
identifies Sonos by the `ZonePlayer` URN in the `USN`, fetches each device
description for the friendly name + AVTransport control URL. Runs on a daemon
thread every 30 s. No external libraries.

## Visibility (no UI change)

`handleCapabilities` augments the relayed `audioOutputDevices` with discovered
speakers (`sonos://<ip>:<port>`). The base station already renders
`audioOutputDevices` in its speaker `<select>` (base-station.js), so a Sonos
appears in the picker with no UI change. (Caveat: it shows on the next
CAPABILITIES refresh from a client — reconnect / refresh if it does not appear
immediately.)

## Routing PLAY_CLIP → Sonos

In `handleBroadcastClip`, after fan-out, if the broadcaster's `speakerDevice`
config is a `sonos://` id, the hub:
1. writes the clip WAV to a temp file,
2. serves it from a short-lived **plain-HTTP** `ServerSocket` on the tablet's
   LAN IP (Sonos rejects the self-signed cert and cannot play WebRTC/Opus),
3. `POST`s UPnP AVTransport `SetAVTransportURI` + `SetVolume` + `Play` to the
   speaker's control URL, then tears the server down after `durationMs` + margin.

Local/WebRTC announcement paths are unchanged.

## Wiring

| Component | Change |
|---|---|
| `android/.../SonosManager.kt` | **new** — SSDP discovery + UPnP playback (plan 19) |
| `android/.../SignalingServer.kt` | `startDiscovery()` on boot; augment `CAPABILITIES` with Sonos; `PLAY_CLIP` → Sonos when `speakerDevice` is `sonos://` |
| `linux/pi-agent/pi-agent.py` | **no Sonos code** (rolled back) — Pi still plays PLAY_CLIP locally via ALSA as before |
| `server` / `base-station.js` | **no change** (audioOutputDevices round-trips; picker renders Sonos) |
| AGENTS.md | exception to "matchmaker only" noted for recorded audio |

## Caveats / testing required

- **Untested against real Sonos hardware** — the logic mirrors the (also
  untested) Pi-agent prototype but must be verified on a real speaker.
- **Cleartext HTTP:** the hub makes plain-HTTP UPnP requests to Sonos and runs
  a plain-HTTP server. Android P+ blocks cleartext unless the app allows it
  (`android:usesCleartextTraffic="true"` / network-security-config). Verify the
  manifest permits LAN cleartext; add it if UPnP POSTs fail.
- **Sonos config location:** the hub keys off the *broadcaster's*
  (`speakerDevice`) config. If the base station sends the Sonos selection as a
  different device's config, the lookup must be adjusted.
- **Multi-room:** only the targeted ZonePlayer plays; group playback (push to
  the group coordinator) is a follow-up.
