#!/usr/bin/env bash
# Install the Hearth-Connect Pi Agent as a systemd service.
#
# This is the RECOMMENDED install path on a Raspberry Pi running Pi OS Lite
# (systemd). Unlike the old deploy-pi.sh (which hard-coded /opt/hearth-pi-agent),
# this script resolves the repo location dynamically so the service runs the
# agent straight from your git checkout — no copying, and `git pull` updates it.
#
# Usage:
#   ./install-systemd.sh            # system service, run agent in-place from repo
#   ./install-systemd.sh --user     # systemd --user service (no root needed)
#   ./install-systemd.sh --copy     # copy files to /opt/hearth-pi-agent (classic)
#   ./install-systemd.sh --target-dir /srv/hearth   # override where files live
#
# The unit is generated at runtime with the resolved paths substituted in, so
# WorkingDirectory / ExecStart always point at the actual git directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the repo root dynamically (the git directory), falling back to the
# grandparent of this script's dir if not inside a git worktree.
if REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

PI_AGENT_DIR="$REPO_ROOT/deploy/pi-agent"

USE_USER=0
COPY_TO_OPT=0
TARGET_DIR="$PI_AGENT_DIR"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USE_USER=1 ;;
    --copy) COPY_TO_OPT=1 ;;
    --target-dir) TARGET_DIR="${2:-}"; shift ;;
    -h|--help)
      awk 'NR==1 && /^#!/{next} /^[[:space:]]*#/{sub(/^# ?/,""); print; next} /^[[:space:]]*$/{next} {exit}' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

if [[ ! -f "$PI_AGENT_DIR/pi-agent.py" ]]; then
  echo "ERROR: pi-agent.py not found under $PI_AGENT_DIR" >&2
  exit 1
fi

# Optional: copy to /opt (classic layout). Otherwise run in place.
if [[ "$COPY_TO_OPT" -eq 1 ]]; then
  TARGET_DIR=/opt/hearth-pi-agent
  echo "Copying agent to $TARGET_DIR ..."
  sudo mkdir -p "$TARGET_DIR"
  sudo cp "$PI_AGENT_DIR/pi-agent.py" "$PI_AGENT_DIR/config.env" "$PI_AGENT_DIR/hearth-pi-agent.service" "$TARGET_DIR/"
  sudo cp "$PI_AGENT_DIR/install.sh" "$TARGET_DIR/" 2>/dev/null || true
  echo "Copied. (Edit $TARGET_DIR/config.env for your SERVER_URL / ROOM_ID.)"
fi

UNIT_NAME=hearth-pi-agent.service
if [[ "$USE_USER" -eq 1 ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  sudo=    # no sudo for user units
  ENABLE_CMD="systemctl --user enable --now $UNIT_NAME"
  STATUS_CMD="systemctl --user status $UNIT_NAME"
  LOG_CMD="journalctl --user -u $UNIT_NAME -f"
  RUN_AS="%i"   # systemd --user runs as the invoking user
else
  UNIT_DIR=/etc/systemd/system
  sudo=sudo
  ENABLE_CMD="sudo systemctl enable --now $UNIT_NAME"
  STATUS_CMD="sudo systemctl status $UNIT_NAME"
  LOG_CMD="sudo journalctl -u $UNIT_NAME -f"
  RUN_AS=pi
fi

# Resolve the [Install] WantedBy target based on user vs system install.
if [[ "$USE_USER" -eq 1 ]]; then
  WANTED_BY=default.target
else
  WANTED_BY=multi-user.target
fi

# Generate the unit with dynamically resolved paths.
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
TMP_UNIT="$(mktemp)"
cat > "$TMP_UNIT" <<EOF
[Unit]
Description=Hearth-Connect Pi Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$TARGET_DIR
EnvironmentFile=$TARGET_DIR/config.env
ExecStart=/usr/bin/python3 $TARGET_DIR/pi-agent.py
Restart=always
RestartSec=5

[Install]
WantedBy=$WANTED_BY
EOF

echo "Installing systemd unit -> $UNIT_PATH"
if [[ "$USE_USER" -eq 1 ]]; then
  mkdir -p "$UNIT_DIR"
  cp "$TMP_UNIT" "$UNIT_DIR/$UNIT_NAME"
else
  $sudo mkdir -p "$UNIT_DIR"
  $sudo cp "$TMP_UNIT" "$UNIT_DIR/$UNIT_NAME"
  $sudo chmod 644 "$UNIT_DIR/$UNIT_NAME"
fi
rm -f "$TMP_UNIT"

if [[ "$USE_USER" -eq 1 ]]; then
  # Enable lingering so the user service survives logout (headless Pi).
  sudo loginctl enable-linger "$(id -u)" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
else
  $sudo systemctl daemon-reload
  $sudo systemctl enable --now "$UNIT_NAME"
fi

echo
echo "=== Pi Agent installed as a systemd service ==="
echo "  Unit:        $UNIT_NAME"
echo "  Source dir:  $TARGET_DIR  (resolved from repo: $REPO_ROOT)"
echo "  Status:      $STATUS_CMD"
echo "  Logs:        $LOG_CMD"
echo
echo "Edit $TARGET_DIR/config.env to set SERVER_URL / ROOM_ID / SPEAKER_DEVICE, then:"
echo "  $sudo systemctl restart $UNIT_NAME"
