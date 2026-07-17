#!/usr/bin/env bash
set -e

echo "Installing Hearth-Connect Pi Agent dependencies..."

sudo apt-get update
sudo apt-get install -y \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-nice \
  libnice10 \
  python3-gi \
  python3-gi-cairo \
  gir1.2-gst-rtsp-server-1.0 \
  gir1.2-gstreamer-1.0 \
  libssl-dev \
  v4l-utils \
  alsa-utils \
  python3-pip \
  python3-websockets

if python3 -c "import websockets" 2>/dev/null; then
  echo "websockets already available"
elif python3 -m pip --version >/dev/null 2>&1; then
  python3 -m pip install --break-system-packages websockets
else
  echo "WARNING: could not install websockets; install manually: apt install python3-websockets"
fi

# ─── Install agent + enable systemd service (no manual steps needed) ───
INSTALL_DIR=/opt/hearth-pi-agent
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sudo mkdir -p "$INSTALL_DIR"
sudo cp "$SCRIPT_DIR/pi-agent.py" "$SCRIPT_DIR/config.env" "$INSTALL_DIR/"
sudo cp "$SCRIPT_DIR/hearth-pi-agent.service" /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now hearth-pi-agent

echo "Done. The Pi Agent is installed at $INSTALL_DIR and running as a systemd service."
echo "  status: sudo systemctl status hearth-pi-agent"
echo "  logs:   sudo journalctl -u hearth-pi-agent -f"
