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
  gir1.2-gst-plugins-bad-1.0 \
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
sudo cp "$SCRIPT_DIR/pi-agent.py" "$INSTALL_DIR/"

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
# Precedence: $SERVER_URL env/arg > existing config.env value > prompt.
# If stdin is not a TTY (e.g. automated run) and nothing is provided, the
# placeholder in config.env is left untouched for the user to edit later.
CONFIG_SRC="$SCRIPT_DIR/config.env"
if [[ -f "$CONFIG_SRC" ]]; then
  EXISTING_URL="$(grep -E '^SERVER_URL=' "$CONFIG_SRC" | head -1 | cut -d= -f2-)"
fi
EXISTING_URL="${EXISTING_URL:-wss://your-server-host:8090}"

if [[ -n "${SERVER_URL:-}" ]]; then
  : # already set via environment
elif [[ -t 0 ]]; then
  read -r -p "Server URL for the Hearth-Connect server [${EXISTING_URL}]: " SERVER_URL
  SERVER_URL="${SERVER_URL:-$EXISTING_URL}"
fi
# Write the resolved URL into the copied config.env (only if we have one).
if [[ -n "${SERVER_URL:-}" ]]; then
  TMP_CFG="$(mktemp)"
  if [[ -f "$CONFIG_SRC" ]]; then
    sed "s|^SERVER_URL=.*|SERVER_URL=$SERVER_URL|" "$CONFIG_SRC" > "$TMP_CFG"
  else
    printf 'SERVER_URL=%s\n' "$SERVER_URL" > "$TMP_CFG"
  fi
  sudo cp "$TMP_CFG" "$INSTALL_DIR/config.env"
  rm -f "$TMP_CFG"
else
  sudo cp "$CONFIG_SRC" "$INSTALL_DIR/config.env"
fi

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
echo "  server: ${SERVER_URL:-<not set — edit $INSTALL_DIR/config.env>}"
echo "  status: sudo systemctl status hearth-pi-agent"
echo "  logs:   sudo journalctl -u hearth-pi-agent -f"
