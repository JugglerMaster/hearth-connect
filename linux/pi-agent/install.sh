#!/usr/bin/env bash
set -e

echo "Installing Hearth-Connect Pi Agent dependencies..."

sudo apt-get update
sudo apt-get install -y \
  gstreamer1.0-tools \
  gstreamer1.0-alsa \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly \
  gstreamer1.0-nice \
  gstreamer1.0-libcamera \
  libnice10 \
  python3-gi \
  python3-gi-cairo \
  gir1.2-gst-rtsp-server-1.0 \
  gir1.2-gstreamer-1.0 \
  gir1.2-gst-plugins-bad-1.0 \
  libssl-dev \
  v4l-utils \
  alsa-utils \
  python3-pip \
  python3-websockets \
  python3-zeroconf

if python3 -c "import websockets" 2>/dev/null; then
  echo "websockets already available"
elif python3 -m pip --version >/dev/null 2>&1; then
  python3 -m pip install --break-system-packages websockets
else
  echo "WARNING: could not install websockets; install manually: apt install python3-websockets"
fi

if python3 -c "import zeroconf" 2>/dev/null; then
  echo "zeroconf already available"
elif python3 -m pip --version >/dev/null 2>&1; then
  python3 -m pip install --break-system-packages zeroconf
else
  echo "WARNING: could not install zeroconf; install manually: apt install python3-zeroconf"
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
sudo cp "$SCRIPT_DIR/pi-agent.py" "$INSTALL_DIR/"
sudo cp "$SCRIPT_DIR/mdns_discover.py" "$INSTALL_DIR/"

# ─── Install the server's CA so the agent trusts the self-signed TLS cert ───
# The Pi agent verifies the server's WSS certificate. For a self-hosted LAN
# server this means trusting its CA. Look for ca.pem next to this script
# (e.g. copied alongside by deploy-pi.sh), in the server's certs dir, or in
# /opt/hearth-pi-agent; install whichever is found into the system trust store.
CA_CANDIDATES=(
  "$SCRIPT_DIR/ca.pem"
  "$SCRIPT_DIR/../server/certs/ca.pem"
  "/opt/hearth-pi-agent/ca.pem"
)
CA_FOUND=""
for c in "${CA_CANDIDATES[@]}"; do
  if [[ -f "$c" ]]; then CA_FOUND="$c"; break; fi
done
if [[ -n "$CA_FOUND" ]]; then
  echo "Installing CA from $CA_FOUND into system trust store..."
  sudo cp "$CA_FOUND" /usr/local/share/ca-certificates/hearth-ca.crt
  sudo update-ca-certificates
else
  echo "NOTE: no ca.pem found to trust — if the server uses a self-signed cert,"
  echo "      copy its ca.pem to /opt/hearth-pi-agent/ca.pem and run:"
  echo "      sudo cp /opt/hearth-pi-agent/ca.pem /usr/local/share/ca-certificates/hearth-ca.crt && sudo update-ca-certificates"
fi

# ─── Prompt for the server URL (used by the agent to connect) ───
# Precedence: $SERVER_URL env/arg > user prompt > blank (auto-discover via mDNS).
# We never read the installed config.env as a prompt default — a stale IP or
# placeholder from a previous install would prevent the blank autodiscovery
# default from taking effect.
CONFIG_SRC="$SCRIPT_DIR/config.env"
INSTALLED_CFG="$INSTALL_DIR/config.env"

if [[ -n "${SERVER_URL:-}" ]]; then
  : # already set via environment or CLI arg
elif [[ -t 0 ]]; then
  echo "Enter the server URL (leave blank to auto-discover the server via mDNS):"
  read -r -p "Server URL [blank = auto-discover]: " SERVER_URL
fi

# Build the installed config.env.  If the user gave a URL (or left it blank for
# autodiscovery), write a fresh config from the template with that value.  Only
# preserve the existing installed config when re-running non-interactively with
# no env var — that means "don't touch my setup."
if [[ -n "${SERVER_URL:-}" ]]; then
  TMP_CFG="$(mktemp)"
  sed "s|^SERVER_URL=.*|SERVER_URL=$SERVER_URL|" "$CONFIG_SRC" > "$TMP_CFG"
  sudo cp "$TMP_CFG" "$INSTALLED_CFG"
  rm -f "$TMP_CFG"
elif [[ -t 0 ]]; then
  # User was prompted and hit Enter with no input → blank = autodiscover.
  if [[ -f "$INSTALLED_CFG" ]]; then
    # Ensure the installed config has a blank SERVER_URL.
    if grep -qE '^SERVER_URL=.+' "$INSTALLED_CFG"; then
      TMP_CFG="$(mktemp)"
      sed 's|^SERVER_URL=.*|SERVER_URL=|' "$INSTALLED_CFG" > "$TMP_CFG"
      sudo cp "$TMP_CFG" "$INSTALLED_CFG"
      rm -f "$TMP_CFG"
    fi
  else
    sudo cp "$CONFIG_SRC" "$INSTALLED_CFG"
  fi
elif [[ ! -f "$INSTALLED_CFG" ]]; then
  # Non-interactive, no env var, no existing config — copy template as-is.
  sudo cp "$CONFIG_SRC" "$INSTALLED_CFG"
fi

# The agent runs as a non-root user but the files were copied via sudo, so make
# the install dir owned by that user. Otherwise the agent can't persist its
# stable device_id (or rewrite config.env), and each restart shows as a new
# "Pi Agent" device.
sudo chown -R "$AGENT_USER" "$INSTALL_DIR"

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

# If the service was already running before install.sh ran, `enable --now`
# is a no-op for the process — it won't pick up new files/config.  Force a
# restart so the updated code and config.env take effect immediately.
if systemctl is-active --quiet hearth-pi-agent; then
  sudo systemctl restart hearth-pi-agent
fi

echo "Done. The Pi Agent is installed at $INSTALL_DIR and running as user '$AGENT_USER'."
echo "  server: ${SERVER_URL:-<blank — will auto-discover via mDNS>}"
echo "  status: sudo systemctl status hearth-pi-agent"
echo "  logs:   sudo journalctl -u hearth-pi-agent -f"
