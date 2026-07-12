# Hearth-Connect Pi Agent

> **⚠️ UNTESTED** — This agent has not been validated on hardware. Use at your own risk.

A headless Raspberry Pi client for Hearth-Connect. Runs on **Pi OS Lite** (no desktop, no
screen) as a native Python + GStreamer WebRTC publisher. It streams the camera and/or
microphone to a Hearth-Connect room, and the base station can monitor and switch its inputs.

This is a **kiosk client deployment** — the Pi acts as a camera/mic publisher (like a browser kiosk).

## What it does

- Enumerates V4L2 cameras (`v4l2-ctl`) and ALSA microphones (`arecord -l`).
- Publishes `video+audio`, `video-only`, or `audio-only` depending on what's attached.
- Reports its device list to the base station via `CAPABILITIES` so inputs can be switched.
- Sends `AUDIO_PEAK` alerts when audio rises above the configured threshold (with hysteresis).
- Auto-reconnects to the server with exponential backoff.
- Reacts to `CONFIG_UPDATED` (resolution, frame rate, selected video/audio device, alert config).

## Install (Pi OS Lite)

```bash
sudo apt-get install -y git
git clone <your-repo> hearth-connect
cd hearth-connect/deploy/pi-agent
chmod +x install.sh
./install.sh

sudo mkdir -p /opt/hearth-pi-agent
sudo cp pi-agent.py config.env /opt/hearth-pi-agent/
sudo cp hearth-pi-agent.service /etc/systemd/system/
```

## Configure

Edit `/opt/hearth-pi-agent/config.env`:

| Variable     | Meaning                                                        |
|--------------|----------------------------------------------------------------|
| `SERVER_URL` | `wss://host:8090` of your Hearth-Connect server                |
| `ROOM_ID`    | Room to join (default `default`)                               |
| `DEVICE_LABEL` | Name shown in the base station device list                   |
| `VIDEO_DEVICE` | V4L2 path, e.g. `/dev/video0`; blank = first available      |
| `AUDIO_DEVICE` | ALSA id, e.g. `hw:1,0`; blank = first available             |
| `RESOLUTION` | `480p` / `720p` / `1080p`                                      |
| `FRAMERATE`  | `15` / `24` / `30`                                             |

For the camera, enable it once: `sudo raspi-config` → Interface → Camera (or `libcamera`).
Set a USB mic as the default capture device if needed (`~/.asoundrc` / `alsactl`).

## Install the self-signed CA (optional)

If your server uses the self-signed TLS cert from `deploy/gen-cert.sh`, install the CA on the
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

## Notes

- The agent only **publishes** media; it never renders video locally, so no display server
  (X/Wayland) is required.
- Encoder preference: `v4l2h264enc` (Pi hardware) when available, else `x264enc`.
- Audio alerting uses the GStreamer `level` element; `audioAlertEnabled`,
  `audioAlertThresholdDb`, and `audioAlertHysteresisDb` are pushed from the base station.
