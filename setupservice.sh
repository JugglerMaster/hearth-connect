#!/usr/bin/env bash
# Install the Hearth-Connect Server as a systemd service.
#
# This is the RECOMMENDED install path on a Linux host (systemd). The unit is
# generated at runtime with the resolved paths substituted in, so
# WorkingDirectory / ExecStart always point at the actual git checkout — no
# hard-coded /home/<user>/... paths, and `git pull` updates the running code.
#
# Usage:
#   ./setupservice.sh            # system service, run server in-place from repo
#   ./setupservice.sh --user     # systemd --user service (no root needed)
#   ./setupservice.sh --port 8090
#   ./setupservice.sh --node /path/to/node   # override node binary
#   ./setupservice.sh --user dadisc01        # override the service User
#
# Options:
#   --user [USER]   install as a systemd --user unit (optional USER; defaults
#                   to the current user). No root needed for start/stop, but
#                   enabling the service as a boot-time unit still needs root
#                   once (loginctl enable-linger).
#   --port N        SERVER_PORT for the unit (default 8090)
#   --node PATH     absolute path to the node binary (default: first `node` on PATH)
#   --no-build      skip `npm run build` (assume dist/ already exists)
#   -h, --help      show this help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve the repo root dynamically (the git directory), falling back to the
# parent of this script's dir if not inside a git worktree.
if REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

SERVER_DIR="$REPO_ROOT/server"
UNIT_NAME=hearth-connect.service

# Defaults
USE_USER=0
SERVICE_USER="${USER:-$(id -un)}"
SERVER_PORT=8090
NODE_BIN=""
DO_BUILD=1

# Resolve node: prefer an explicit arg, else `node` on PATH, else a common
# pi-node location under ~/.local/share/pi-node.
resolve_node() {
  if [[ -n "$NODE_BIN" ]]; then
    return
  fi
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    return
  fi
  # Search ~/.local/share/pi-node for a node binary (version-agnostic).
  local found
  found="$(find "$HOME/.local/share/pi-node" -maxdepth 3 -type f -name node 2>/dev/null | head -n1)"
  if [[ -n "$found" ]]; then
    NODE_BIN="$found"
    return
  fi
  echo "ERROR: node binary not found. Install Node.js 20+ or pass --node /path/to/node" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      USE_USER=1
      if [[ "${2:-}" && "${2}" != -* ]]; then
        SERVICE_USER="$2"; shift
      fi
      ;;
    --port) SERVER_PORT="${2:-8090}"; shift ;;
    --node) NODE_BIN="${2:-}"; shift ;;
    --no-build) DO_BUILD=0 ;;
    -h|--help)
      awk 'NR==1 && /^#!/{next} /^[[:space:]]*#/{sub(/^# ?/,""); print; next} /^[[:space:]]*$/{next} {exit}' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

resolve_node

if [[ ! -f "$SERVER_DIR/dist/index.js" && "$DO_BUILD" -eq 0 ]]; then
  echo "ERROR: $SERVER_DIR/dist/index.js missing and --no-build set. Run 'npm run build' first." >&2
  exit 1
fi

if [[ "$DO_BUILD" -eq 1 ]]; then
  echo "Building server..."
  ( cd "$SERVER_DIR" && npm install && npm run build )
fi

# Resolve the [Install] WantedBy target based on user vs system install.
if [[ "$USE_USER" -eq 1 ]]; then
  WANTED_BY=default.target
else
  WANTED_BY=multi-user.target
fi

# Generate the unit with dynamically resolved paths.
TMP_UNIT="$(mktemp)"
cat > "$TMP_UNIT" <<EOF
[Unit]
Description=Hearth-Connect Server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_BIN $SERVER_DIR/dist/index.js --tls
Restart=on-failure
RestartSec=5
Environment=SERVER_PORT=$SERVER_PORT
Environment=NODE_ENV=production

[Install]
WantedBy=$WANTED_BY
EOF

if [[ "$USE_USER" -eq 1 ]]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  STATUS_CMD="systemctl --user status $UNIT_NAME"
  LOG_CMD="journalctl --user -u $UNIT_NAME -f"
  echo "Installing user systemd unit -> $UNIT_DIR/$UNIT_NAME"
  mkdir -p "$UNIT_DIR"
  cp "$TMP_UNIT" "$UNIT_DIR/$UNIT_NAME"
  rm -f "$TMP_UNIT"
  # Enable lingering so the user service survives logout (headless host).
  sudo loginctl enable-linger "$(id -u)" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"
else
  UNIT_DIR=/etc/systemd/system
  STATUS_CMD="sudo systemctl status $UNIT_NAME"
  LOG_CMD="sudo journalctl -u $UNIT_NAME -f"
  echo "Installing system systemd unit -> $UNIT_DIR/$UNIT_NAME"
  sudo mkdir -p "$UNIT_DIR"
  sudo cp "$TMP_UNIT" "$UNIT_DIR/$UNIT_NAME"
  sudo chmod 644 "$UNIT_DIR/$UNIT_NAME"
  rm -f "$TMP_UNIT"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$UNIT_NAME"
fi

echo
echo "=== Hearth-Connect Server installed as a systemd service ==="
echo "  Unit:        $UNIT_NAME"
echo "  Source dir:  $SERVER_DIR  (resolved from repo: $REPO_ROOT)"
echo "  Node bin:    $NODE_BIN"
echo "  Port:        $SERVER_PORT"
echo "  Status:      $STATUS_CMD"
echo "  Logs:        $LOG_CMD"
echo
echo "To apply config changes after 'git pull' + rebuild:"
if [[ "$USE_USER" -eq 1 ]]; then
  echo "  cd $SERVER_DIR && npm install && npm run build && systemctl --user restart $UNIT_NAME"
else
  echo "  cd $SERVER_DIR && npm install && npm run build && sudo systemctl restart $UNIT_NAME"
fi
