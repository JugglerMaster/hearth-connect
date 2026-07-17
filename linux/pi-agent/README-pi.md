# Hearth-Connect Pi Agent

> **⚠️ Hardware-unvalidated** — Pure logic is covered by unit tests (`test_pi_agent.py`,
> runnable anywhere). The GStreamer media path still needs validation on real Pi hardware
> (or a Linux box with GStreamer) via `e2e_smoke.py`. Use at your own risk until then.

A headless Raspberry Pi client for Hearth-Connect. Runs on **Pi OS Lite** (no desktop, no
screen) as a native Python + GStreamer WebRTC publisher. It streams the camera and/or
microphone to a Hearth-Connect room, and the base station can monitor, talk back to, and
broadcast announcements to it — exactly like the browser kiosk.

This is a **kiosk client deployment** — the Pi acts as a camera/mic publisher (like a browser kiosk).

## What it does

- Enumerates V4L2 cameras (`v4l2-ctl`) and ALSA microphones (`arecord -l`).
- Publishes `video+audio`, `video-only`, or `audio-only` depending on what's attached.
- Reports its device list to the base station via `CAPABILITIES` so inputs can be switched.
- Sends `AUDIO_PEAK` alerts when audio rises above the configured threshold (with hysteresis).
- **Two-way talkback**: the monitor peer connection is sendrecv, so the base station's
  talkback audio arrives on the same audio m-line and is played to the attached speaker,
  gated by `TALK_ENABLED` / `TALK_DISABLED` (and by `audioMode: 'base'` set during FaceTalk).
- **Receives broadcasts**: subscribes to base-station broadcast sources (`SOURCE_ADDED` →
  `SUBSCRIBE_BROADCAST`), answers the base's offer, and plays incoming audio. "Broadcast
  Message" announcements always play; FaceTalk (`video+audio`) is received and its video is
  dropped (the Pi is headless). Respects `broadcastDisabled`.
- Auto-reconnects to the server with exponential backoff.
- Reacts to `CONFIG_UPDATED` (resolution, frame rate, selected video/audio device, alert
  config, talkback/broadcast toggles).

## Install (Pi OS Lite)

```bash
sudo apt-get install -y git
git clone https://github.com/JugglerMaster/hearth-connect hearth-connect
cd hearth-connect/linux/pi-agent
bash install.sh

sudo mkdir -p /opt/hearth-pi-agent
sudo cp pi-agent.py config.env /opt/hearth-pi-agent/
sudo cp hearth-pi-agent.service /etc/systemd/system/
```

> **Note:** run the scripts with `bash` (e.g. `bash install.sh`) rather than `./install.sh`
> so you never need to `chmod +x` them. Git tracks the executable bit, so if you `chmod +x`
> a script that was committed without the bit, Git sees a mode change and a later `git pull`
> will refuse to overwrite it ("would be overwritten by merge").
>
> **Pulling updates when you hit that error:**
> ```bash
> # temp fix: discard the local mode change, then pull
> git checkout -- linux/pi-agent/install.sh linux/deploy-pi.sh
> git pull
> ```
> Or, to stop Git from ever flagging mode changes in this clone:
> ```bash
> git config core.fileMode false
> ```
> (`core.fileMode` is a per-clone setting and cannot be enforced from the repo, so each
> user sets it locally if they want it.)

## Configure

Edit `/opt/hearth-pi-agent/config.env`:

| Variable     | Meaning                                                        |
|--------------|----------------------------------------------------------------|
| `SERVER_URL` | `wss://host:8090` of your Hearth-Connect server                |
| `ROOM_ID`    | Room to join (default `default`)                               |
| `DEVICE_LABEL` | Name shown in the base station device list                   |
| `VIDEO_DEVICE` | V4L2 path, e.g. `/dev/video0`; blank = first available      |
| `AUDIO_DEVICE` | ALSA id, e.g. `hw:1,0`; blank = first available             |
| `RESOLUTION` | `480p` / `720p` / `1080p`. Also changeable live from the base station's camera config — the agent rewrites this file on change so it persists across restarts. |
| `FRAMERATE`  | `15` / `24` / `30`. Same as `RESOLUTION`: live-editable from the base station. |
| `SPEAKER_DEVICE` | ALSA speaker id (e.g. `hw:0,0`); blank = default. Used for talkback + announcements |
| `AUDIO_SINK` | Full ALSA sink override (e.g. `alsasink device=hw:0,0`); takes precedence over `SPEAKER_DEVICE` |
| `MAX_SUBSCRIBERS` | Max simultaneous viewer connections (1GB-Pi guard, default `4`) |
| `TEST_SOURCE` | Set `1` to substitute `videotestsrc`/`audiotestsrc` for the real camera/mic (headless e2e testing, no hardware needed) |

For the camera, enable it once: `sudo raspi-config` → Interface → Camera (or `libcamera`).
Set a USB mic as the default capture device if needed (`~/.asoundrc` / `alsactl`).
To hear talkback/broadcasts, attach a speaker/headphones and set `SPEAKER_DEVICE` (or leave
blank for the default ALSA playback device).

## Install the self-signed CA (optional)

If your server uses the self-signed TLS cert from `docker/gen-cert.sh`, install the CA on the
Pi so `wss://` is trusted:

```bash
sudo cp ca.pem /usr/local/share/ca-certificates/hearth-ca.crt
sudo update-ca-certificates
```

Or, for LAN use, point `SERVER_URL` at `ws://host:8090` (plaintext) instead of `wss://`.

## Run

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hearth-pi-agent
sudo systemctl status hearth-pi-agent
sudo journalctl -u hearth-pi-agent -f
```

To run manually (foreground) for debugging:

```bash
cd /opt/hearth-pi-agent
python3 pi-agent.py
```

## Testing

The agent's pure logic is unit-tested without GStreamer, a camera, or a server, so the
tests run anywhere (CI, a dev box — see plan 11). The native media path is exercised
end-to-end on a Pi (or a Linux box with GStreamer) via a smoke test that auto-skips when
the native stack is missing.

**Local unit tests (runnable now, no deps):**
```bash
cd linux/pi-agent
python3 -m unittest test_pi_agent.py -v
```
Covers: `v4l2-ctl`/`arecord -l` parsing, `SourceType` decision, the audio
threshold + hysteresis state machine, and monitor/broadcast GStreamer pipeline-string
construction (including `TEST_SOURCE` substitution).

**End-to-end smoke test (needs GStreamer + a running server):**
```bash
# On a Pi, or any Linux box with GStreamer + `websockets` installed:
cd linux/pi-agent
SERVER_URL=wss://host:8090 ROOM_ID=test python3 -m unittest e2e_smoke.py -v
```
`e2e_smoke.py` launches the real agent with `TEST_SOURCE=1` (no real camera/mic needed),
then acts as a base station + subscriber and asserts the agent publishes a source and
produces a WebRTC OFFER — proving the GStreamer pipeline builds and SDP negotiation starts.
It self-skips when GStreamer/websockets/the server are unavailable, so it's safe in CI.

**Manual hardware validation:** deploy as above, open the base station in a browser, and
confirm a live feed appears for the Pi, talkback audio plays on the Pi's speaker when you
hold "Broadcast", and a base-station broadcast announcement plays on the Pi.

## Notes

- The agent only **publishes** media; it never renders video locally, so no display server
  (X/Wayland) is required. Received broadcast/FaceTalk video is dropped to a `fakesink`.
- Encoder preference: `v4l2h264enc` (Pi hardware) when available, else `x264enc` (software,
  higher RAM/CPU — avoid on 1GB Pis; prefer `480p`/`720p`).
- Talkback and broadcast audio are decoded and played to the ALSA speaker. Volume follows
  `speakerVolume` from config; talkback is gated by `TALK_ENABLED`/`TALK_DISABLED`.
- Audio alerting uses the GStreamer `level` element; `audioAlertEnabled`,
  `audioAlertThresholdDb`, and `audioAlertHysteresisDb` are pushed from the base station.
- **RAM on 1GB Pis**: the dominant cost is GStreamer + the encoder, not the Python glue
  (~50-100MB). Use the Pi hardware encoder, keep `RESOLUTION` at `720p` or below, and lower
  `MAX_SUBSCRIBERS` if many viewers watch at once.

## Future plans

- **Physical push-to-talk button**: wire a GPIO button so the Pi can send audio (an
  announcement) directly, without the base station. Likely implemented as a **broadcast to
  all** subscribers in the room — the agent captures from the mic and publishes a broadcast
  source that every other device in the room receives and plays. This needs a new agent
  message (e.g. `START_BROADCAST`/`STOP_BROADCAST` over the existing monitor/broadcast peer
  connection) plus debounce/hold handling on the GPIO edge.
