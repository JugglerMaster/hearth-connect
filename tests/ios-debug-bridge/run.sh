#!/usr/bin/env bash
#
# Orchestrate the iOS debug bridge stack on Linux:
#   usbmuxd  →  ios-webkit-debug-proxy  →  remotedebug-ios-webkit-adapter  →  bridge.js
#
# Usage:
#   bash run.sh start   # launch services, then run bridge.js
#   bash run.sh stop    # tear everything down
#   bash run.sh status  # show what's running
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$HERE/.run"
mkdir -p "$RUN"

ADAPTER_PORT="${ADAPTER_PORT:-9000}"
PROXY_PORT="${PROXY_PORT:-9222}"
PROXY_BIN="${IOS_WEBKIT_DEBUG_PROXY:-ios_webkit_debug_proxy}"
ADAPTER_BIN="${IOS_ADAPTER:-remotedebug_ios_webkit_adapter}"

pidfile() { echo "$RUN/$1.pid"; }
logfile() { echo "$RUN/$1.log"; }

is_running() {
  local pf="$1"; [[ -f "$pf" ]] || return 1
  local pid; pid="$(cat "$pf" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start_service() {
  local name="$1"; shift
  if is_running "$(pidfile "$name")"; then
    echo "[run] $name already running ($(cat "$(pidfile "$name")"))"
    return 0
  fi
  echo "[run] starting $name…"
  "$@" >"$(logfile "$name")" 2>&1 &
  echo $! >"$(pidfile "$name")"
  sleep 1
}

stop_service() {
  local name="$1"; local pf="$(pidfile "$name")"
  if is_running "$pf"; then
    local pid="$(cat "$pf")"
    echo "[run] stopping $name ($pid)"
    kill "$pid" 2>/dev/null || true
    rm -f "$pf"
  fi
}

cmd_start() {
  # 1. usbmuxd (needs root; skip if already running).
  if ! pgrep -x usbmuxd >/dev/null 2>&1; then
    echo "[run] usbmuxd not running — start it as root: sudo usbmuxd -U usbmux"
    echo "[run] (continuing; the proxy will fail if usbmuxd is absent)"
  fi

  # 2. ios-webkit-debug-proxy → localhost:9222 (syntax: "*:PORT" = all devices).
  start_service proxy "$PROXY_BIN" -c "*:${PROXY_PORT}" -d

  # 3. adapter → localhost:9000 (wraps 9222 as CDP).
  start_service adapter "$ADAPTER_BIN" --port "${ADAPTER_PORT}" --proxy-port "${PROXY_PORT}"

  # 4. bridge.js (requires npm install in this folder first).
  if [[ ! -d "$HERE/node_modules" ]]; then
    echo "[run] node_modules missing — run: cd $HERE && npm install"
    exit 1
  fi
  echo "[run] launching bridge.js"
  ( cd "$HERE" && SERVER_URL="${SERVER_URL:-https://localhost:8090}" PAGE="${PAGE:-base-station.html}" ROOM="${ROOM:-}" node bridge.js ) &
  echo $! >"$(pidfile bridge)"
}

cmd_stop() {
  stop_service bridge
  stop_service adapter
  stop_service proxy
  echo "[run] done. (usbmuxd left as-is; stop it manually if desired.)"
}

cmd_status() {
  for n in proxy adapter bridge; do
    if is_running "$(pidfile "$n")"; then
      echo "[run] $n: RUNNING ($(cat "$(pidfile "$n")"))"
    else
      echo "[run] $n: stopped"
    fi
  done
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *) echo "usage: bash run.sh {start|stop|status}"; exit 2 ;;
esac
