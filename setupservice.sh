#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building server..."
cd "$DIR/server"
npm run build

echo "Installing systemd service..."
sudo cp "$DIR/deploy/hearth-connect.service" /etc/systemd/system/hearth-connect.service
sudo systemctl daemon-reload
sudo systemctl enable hearth-connect.service
sudo systemctl restart hearth-connect.service
sudo systemctl status hearth-connect.service --no-pager
