# 02 — Raspberry Pi Agent (Native Headless Client)

A headless Raspberry Pi (Pi OS Lite, no desktop, no screen) runs a **native Node.js WebRTC
client** that joins a Hearth-Connect room and publishes whatever media is available
(camera, mic, or both independently). No browser, no X server, no Chromium — minimal footprint
and no bloat to the existing kiosk page or its settings UI.

## Why native (not Chromium)

- Pi OS Lite has no desktop; Chromium headless is heavy and adds a V8 + display stack we don't need.
- The agent only **publishes** media; it never renders video locally, so a browser buys us nothing.
- A native client keeps the `camera.html` / `camera.js` kiosk code untouched — no feature creep
  into the regular iPad kiosk path.
- Direct V4L2 (camera) + ALSA (mic) access via GStreamer is reliable and scriptable over SSH.

## A. Media capture stack

Use **GStreamer + `webrtcbin`** (the reference native WebRTC implementation on Linux) OR a
**Node + `aiortc`/Rust `webrtc`** approach. Recommended for a Pi:

- **GStreamer `webrtcbin`** pipeline for capture + encode + WebRTC sendonly.
  - Video: `v4l2src` → `videoconvert` → `x264enc` (or `omx`/`v4l2h264enc` on Pi) → `rtph264pay`.
  - Audio: `alsasrc` → `audioconvert` → `opusenc` → `rtpopuspay`.
  - Each source is optional; the pipeline is built from whatever devices exist.
- `nicesrc`/`niceagent` (libnice) for ICE; `dtlssrtpenc`/`dec` for DTLS-SRTP.
- A small **control script** (Python or Node) drives `webrtcbin` via GStreamer's API
  (Python `gi` bindings are simplest on Pi OS) and speaks the Hearth-Connect signaling protocol
  over a WebSocket client.

### Capability detection (no camera / no mic)

- Probe devices at startup (see plan 06 for the full enumeration approach):
  - Camera: enumerate `/dev/video*` and confirm V4L2 capture capability.
  - Mic: `arecord -l` lists a capture card; map to ALSA ids.
- Build the `SourceType` from what's found:
  - video + audio → `video+audio`
  - video only    → `video-only`
  - audio only    → `audio-only`
  - neither       → join but publish `none` (or skip publishing; still appears in device list).
- **Report the device lists** to the base station via `CAPABILITIES` (plan 06 / plan 01 §6) so
  the base station can switch the active video/audio source. Re-send on hotplug.

## B. Signaling client (reuse protocol, not browser code)

Implement a thin WebSocket client in the control script that speaks the existing protocol
(see `server/src/SignalingHandler.ts` and `server/public/js/signaling.js` for the wire format):

1. `JOIN_ROOM { roomId, deviceId, deviceType: 'kiosk', label }`.
2. On `WELCOME`, read `config` and start media per current config.
3. `PUBLISH_SOURCE { sourceId, label, type }` with the detected `SourceType`.
4. On `SUBSCRIBER_JOINED { subscriberId }`:
   - Create a WebRTC sendonly `webrtcbin` session for that subscriber.
   - Add the video/audio `rtp` streams present (based on detected caps).
   - Perform SDP offer/answer exchange: send `OFFER { to: subscriberId, sdp }`,
     receive `ANSWER`, exchange `ICE_CANDIDATE` both ways.
5. On `SUBSCRIBER_LEFT`: tear down that session.
6. On `CONFIG_UPDATED`: adjust resolution/framerate/camera selection at runtime if possible;
   restart the pipeline for affected subscribers.
7. `HEARTBEAT` ping/pong every ~15s (server expects heartbeats; see `SignalingHandler.handleHeartbeat`).

> The wire protocol is JSON `{ type, payload }` over `ws`/`wss`. The native client mirrors
> `signaling.js` message types exactly — no server changes beyond the `SourceType` extension
> in plan 01.

## C. OS / Deployment (Pi OS Lite)

Create `deploy/pi-agent/`:

1. `install.sh` — install deps on Pi OS Lite:
   ```
   sudo apt-get update
   sudo apt-get install -y gstreamer1.0-tools gstreamer1.0-plugins-base \
     gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
     gstreamer1.0-nice libnice10 python3-gi python3-gi-cairo \
     gir1.2-gst-rtsp-server-1.0 libssl-dev
   # Python WebSocket client:
   pip3 install websockets
   ```
2. `pi-agent.py` — the control script (GStreamer `webrtcbin` + `websockets`).
3. `config.env` — `SERVER_URL`, `ROOM_ID` (default `default`), `DEVICE_LABEL`, optional
   `VIDEO_DEVICE`, `AUDIO_DEVICE`, `RESOLUTION`, `FRAMERATE`.
4. `hearth-pi-agent.service` — systemd unit:
   ```
   [Unit]
   Description=Hearth-Connect Pi Agent
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=pi
   WorkingDirectory=/opt/hearth-pi-agent
   EnvironmentFile=/opt/hearth-pi-agent/config.env
   ExecStart=/usr/bin/python3 /opt/hearth-pi-agent/pi-agent.py
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
5. `README-pi.md` — flash Pi OS Lite, `ssh` in, run `install.sh`, copy files to
   `/opt/hearth-pi-agent`, set `config.env`, `sudo systemctl enable --now hearth-pi-agent`.
   Notes: enable camera (`sudo raspi-config` → Interface → Camera / `libcamera`), set USB mic
   as default ALSA capture (`~/.asoundrc` or `alsactl`), install the self-signed CA cert so
   `wss://` is trusted (or use `ws://` on LAN).

## D. Notes / edge cases

- **No screen required** — pure headless; media goes straight from devices to the peer.
- **Reconnect** — on WS drop, exponential backoff (1s→30s) and re-JOIN_ROOM; re-publish source.
- **Hotplug** — optional: watch udev/`v4l2-ctl` for camera appearing; rebuild pipeline and
  re-publish with updated `SourceType` (pairs with `CAPABILITIES_CHANGED` from plan 01 if used).
- **Two-way audio / talkback** — agent receives `TALK_ENABLED`/`TALK_DISABLED`; if it has a
  speaker it can play talkback audio. On a headless Pi this is optional.
- **Source switching** — agent applies `config.videoDevice` / `config.audioDevice` from
  `CONFIG_UPDATED` by rebuilding the GStreamer branch for the chosen device (plan 06 §E).
- **Audio threshold alerts** — insert a GStreamer `level` element in the audio branch and send
  `AUDIO_PEAK` (level + rising-edge peak) per plan 07 §D. Honors `config.audioAlert*`.
- **Resource use** — `x4l2h264enc`/x264enc on Pi is light; no browser means ~100s of MB RAM
  vs ~500MB+ for Chromium.
