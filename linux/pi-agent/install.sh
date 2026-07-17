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
  python3-pip

if python3 -m pip --version >/dev/null 2>&1; then
  python3 -m pip install --upgrade pip
  python3 -m pip install websockets
else
  echo "WARNING: pip is unavailable; install manually: python3 -m pip install websockets"
fi

echo "Done. Copy config.env and enable the service:"
echo "  sudo cp hearth-pi-agent.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now hearth-pi-agent"
