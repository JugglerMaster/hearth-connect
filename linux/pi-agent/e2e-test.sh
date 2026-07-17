#!/usr/bin/env bash
# Spin up the real Hearth-Connect server in Docker (self-signed TLS) and run a
# wire-level end-to-end test of the Pi agent's signaling against it, driven by a
# fake "base station" peer. GStreamer (gi) is mocked (not installable here); the
# websocket transport to the live server is REAL, so this exercises the agent's
# actual protocol handling against the actual server, not a mock.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

PI_AGENT_DIR="$REPO_ROOT/deploy/pi-agent"
VENV=/tmp/hc-venv
PORT=8443   # host port mapped to container 443

cleanup() { docker rm -f hc-e2e 2>/dev/null || true; }
trap cleanup EXIT

echo "== Building server image (if needed) =="
docker build -t hearth-connect-server:test -f server/Dockerfile server >/dev/null 2>&1 || \
  docker image inspect hearth-connect-server:test >/dev/null 2>&1

echo "== Starting server container on 127.0.0.1:$PORT (TLS) =="
mkdir -p deploy/certs deploy/data
docker run -d --name hc-e2e -p 127.0.0.1:$PORT:443 \
  -e SERVER_PORT=443 -e TLS_ENABLED=true -e CERT_DIR=/certs -e DATA_DIR=/data \
  -v "$PWD/deploy/certs":/certs -v "$PWD/deploy/data":/data \
  hearth-connect-server:test >/dev/null

# Wait for health endpoint (HTTP redirect port not used; hit /api/status over https)
for i in $(seq 1 30); do
  if curl -sk "https://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
    echo "== Server up after ${i}s =="
    break
  fi
  sleep 1
done
curl -sk "https://127.0.0.1:$PORT/api/status" && echo

echo "== Running Pi-agent signaling E2E against live server =="
SERVER_URL="wss://127.0.0.1:$PORT" PYTHONPATH="$PI_AGENT_DIR" \
  "$VENV/bin/python" /tmp/hc-e2e-pi.py
