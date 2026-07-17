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

# Run the agent as the user who invoked the script (honors sudo: if installed
# via `sudo bash install.sh`, use the original user, not root). systemd refuses
# to start the unit if `User=` names a non-existent account (status 217/USER).
if [[ -n "${SUDO_USER:-}" ]]; then
  AGENT_USER="$SUDO_USER"
elif [[ -n "${USER:-}" ]]; then
  AGENT_USER="$USER"
else
  AGENT_USER="$(id -un)"
fi

sudo mkdir -p "$INSTALL_DIR"
sudo cp "$SCRIPT_DIR/pi-agent.py" "$SCRIPT_DIR/config.env" "$INSTALL_DIR/"

# (Re)generate the systemd unit with the correct User= so re-running this
# script updates an existing install too. We substitute into the repo template
# rather than copying it verbatim (the template keeps User=__AGENT_USER__ as a
# placeholder so it is never hardcoded to a missing account).
UNIT_SRC="$SCRIPT_DIR/hearth-pi-agent.service"
if grep -q '__AGENT_USER__' "$UNIT_SRC"; then
  # Write the substituted unit via sudo tee — the > redirect runs as the
  # (non-root) caller, so it would be denied on /etc/systemd/system.
  sed "s/__AGENT_USER__/$AGENT_USER/g" "$UNIT_SRC" | sudo tee /etc/systemd/system/hearth-pi-agent.service > /dev/null
else
  sudo cp "$UNIT_SRC" /etc/systemd/system/hearth-pi-agent.service
fi
sudo systemctl daemon-reload
sudo systemctl enable --now hearth-pi-agent

echo "Done. The Pi Agent is installed at $INSTALL_DIR and running as user '$AGENT_USER'."
echo "  status: sudo systemctl status hearth-pi-agent"
echo "  logs:   sudo journalctl -u hearth-pi-agent -f"
