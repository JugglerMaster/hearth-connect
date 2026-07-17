#!/usr/bin/env bash
# Deploy Hearth-Connect Pi Agent to a remote Raspberry Pi
# Usage: ./linux/deploy-pi.sh <pi-host> [pi-user] [config.env path]

set -euo pipefail

PI_HOST="${1:-}"
PI_USER="${2:-pi}"
CONFIG_FILE="${3:-linux/pi-agent/config.env}"

if [[ -z "$PI_HOST" ]]; then
    echo "Usage: $0 <pi-host> [pi-user] [config.env]"
    echo "Example: $0 192.168.1.50 pi ./linux/pi-agent/config.env"
    exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Config file not found: $CONFIG_FILE"
    exit 1
fi

echo "=== Deploying to $PI_USER@$PI_HOST ==="

# Read config to get SERVER_URL for validation
SERVER_URL=$(grep '^SERVER_URL=' "$CONFIG_FILE" | cut -d'=' -f2-)
ROOM_ID=$(grep '^ROOM_ID=' "$CONFIG_FILE" | cut -d'=' -f2-)
DEVICE_LABEL=$(grep '^DEVICE_LABEL=' "$CONFIG_FILE" | cut -d'=' -f2-)

echo "Config:"
echo "  SERVER_URL: $SERVER_URL"
echo "  ROOM_ID: $ROOM_ID"
echo "  DEVICE_LABEL: $DEVICE_LABEL"

# Copy files
echo "Copying files..."
ssh "$PI_USER@$PI_HOST" "mkdir -p ~/hearth-pi-agent"
scp linux/pi-agent/install.sh linux/pi-agent/pi-agent.py linux/pi-agent/hearth-pi-agent.service linux/pi-agent/config.env "$PI_USER@$PI_HOST:~/hearth-pi-agent/"

# Also copy CA cert if it exists
if [[ -f docker/certs/ca.pem ]]; then
    scp docker/certs/ca.pem "$PI_USER@$PI_HOST:~/hearth-pi-agent/ca.pem"
fi

# Run install on Pi
echo "Running install on Pi..."
ssh "$PI_USER@$PI_HOST" << 'REMOTE_EOF'
set -euo pipefail
cd ~/hearth-pi-agent
chmod +x install.sh
./install.sh

# Create target directory and copy files
sudo mkdir -p /opt/hearth-pi-agent
sudo cp pi-agent.py config.env /opt/hearth-pi-agent/
sudo cp hearth-pi-agent.service /etc/systemd/system/

# Install CA cert if present
if [[ -f ca.pem ]]; then
    sudo cp ca.pem /usr/local/share/ca-certificates/hearth-ca.crt
    sudo update-ca-certificates
fi

# Reload and enable service
sudo systemctl daemon-reload
sudo systemctl enable --now hearth-pi-agent

echo "=== Pi Agent deployed successfully ==="
echo "Check status: sudo systemctl status hearth-pi-agent"
echo "Follow logs:  sudo journalctl -u hearth-pi-agent -f"
REMOTE_EOF

echo "=== Deployment complete ==="
echo "On the Pi:"
echo "  sudo systemctl status hearth-pi-agent"
echo "  sudo journalctl -u hearth-pi-agent -f"
