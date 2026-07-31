#!/usr/bin/env python3
"""Captive portal for Hearth-Connect Pi Agent.

When the Pi starts without WiFi, this module:
1. Creates an open WiFi hotspot (SSID = device name, no password)
2. Serves a captive portal page on port 80
3. Lets the user select/enter WiFi credentials
4. Configures WiFi via nmcli and tears down the hotspot

The agent continues running and detects WiFi via the monitor loop in pi-agent.py.
"""

import json
import logging
import os
import re
import socket
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

log = logging.getLogger('hearth-pi-agent')

HOTSPOT_IP = '192.168.4.1'
HOTSPOT_SUBNET = '24'
HOTSPOT_RANGE = '192.168.4.10,192.168.4.200'

# Set by _configure_wifi once the user has just provisioned WiFi via the portal,
# so the agent's connect loop can immediately fall back to mDNS discovery
# (instead of retrying a possibly-stale SERVER_URL).
wifi_configured_event = threading.Event()


def check_wifi_connected():
    """Check if WiFi is connected (as a *client* station) and has an IP address.

    The agent's own hotspot connection ('hearth-hotspot', AP mode) is excluded —
    otherwise the WiFi monitor would see the AP as "connected" and tear it down.
    """
    try:
        # Check for an active WiFi connection with an IP
        out = subprocess.check_output(
            ['nmcli', '-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'],
            text=True, timeout=5
        )
        for line in out.strip().split('\n'):
            parts = line.split(':')
            if len(parts) >= 4 and parts[1] == 'wifi' and parts[2] == 'connected':
                if parts[3] == 'hearth-hotspot':
                    continue
                # Check if this device has an IP
                iface = parts[0]
                ip = subprocess.check_output(
                    ['nmcli', '-t', '-f', 'IP4.ADDRESS', 'device', 'show', iface],
                    text=True, timeout=5
                ).strip()
                if ip:
                    return True
        return False
    except Exception:
        return False


def has_internet(timeout=3):
    """Return True if the device can reach the internet (or the configured server).

    Prefers the configured SERVER_URL host so a LAN-only deployment still counts
    as "online", then falls back to public DNS endpoints.
    """
    import socket
    hosts = []
    srv = os.environ.get('SERVER_URL', '').strip().rstrip('/')
    if srv:
        try:
            from urllib.parse import urlparse
            h = urlparse(srv).hostname
            if h:
                port = 443 if srv.startswith('wss') else 80
                hosts.append((h, port))
        except Exception:
            pass
    hosts += [('8.8.8.8', 53), ('1.1.1.1', 53), ('8.8.4.4', 53)]
    for host, port in hosts:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            continue
    return False


def get_wifi_interface():
    """Return the first WiFi (wlan*) interface, falling back to 'wlan0'."""
    try:
        out = subprocess.check_output(
            ['nmcli', '-t', '-f', 'DEVICE,TYPE', 'device'],
            text=True, timeout=5
        )
        for line in out.strip().split('\n'):
            parts = line.split(':')
            if len(parts) >= 2 and parts[1] == 'wifi' and parts[0].startswith('wlan'):
                return parts[0]
    except Exception:
        pass
    return 'wlan0'


def get_device_name():
    """Get the hotspot SSID. Uses the device hostname (e.g. pivideo1) so the AP
    is recognizable on the network; falls back to the board model only if the
    hostname is unset/generic, and finally to a static name."""
    try:
        name = socket.gethostname()
        if name and name.lower() not in ('localhost', 'localhost.localdomain', '(none)', ''):
            return name
    except Exception:
        pass
    # Fallback: human-readable board model.
    try:
        with open('/proc/device-tree/model', 'r') as f:
            model = f.read().strip().rstrip('\x00')
        # e.g. "Raspberry Pi 4 Model B Rev 1.5" -> "Raspberry Pi 4"
        parts = model.split()
        if 'Raspberry' in model and 'Pi' in model:
            idx = parts.index('Pi')
            return ' '.join(parts[:idx + 2])
    except Exception:
        pass
    return 'Hearth Pi'


def connect_saved_wifi():
    """Try to bring up any saved (non-hotspot) WiFi connection, to recover
    internet when the hotspot has been up with no connectivity. Returns True if a
    saved connection was activated."""
    try:
        out = subprocess.check_output(
            ['nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show'],
            text=True, timeout=5)
        for line in out.strip().split('\n'):
            parts = line.split(':')
            if (len(parts) >= 2 and parts[1] == '802-11-wireless'
                    and parts[0] != 'hearth-hotspot'):
                log.info('trying saved WiFi connection: %s', parts[0])
                r = subprocess.run(
                    ['sudo', '-n', 'nmcli', 'connection', 'up', parts[0]],
                    capture_output=True, text=True, timeout=30)
                if r.returncode == 0:
                    log.info('activated saved WiFi: %s', parts[0])
                    return True
                log.warning('saved WiFi %s failed: %s', parts[0], r.stderr.strip())
    except Exception as e:
        log.warning('saved WiFi connect error: %s', e)
    return False


def scan_networks():
    """Scan for available WiFi networks using nmcli."""
    try:
        subprocess.run(['nmcli', 'device', 'wifi', 'rescan'],
                       timeout=10, capture_output=True)
        out = subprocess.check_output(
            ['nmcli', '-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list'],
            text=True, timeout=10
        )
        networks = []
        seen = set()
        for line in out.strip().split('\n'):
            if not line:
                continue
            parts = line.split(':')
            if len(parts) >= 3:
                ssid = parts[0]
                if ssid and ssid not in seen and ssid != '':
                    seen.add(ssid)
                    networks.append({
                        'ssid': ssid,
                        'signal': int(parts[1]) if parts[1].isdigit() else 0,
                        'security': parts[2] if parts[2] else 'Open',
                    })
        # Sort by signal strength
        networks.sort(key=lambda n: n['signal'], reverse=True)
        return networks
    except Exception as e:
        log.warning('WiFi scan failed: %s', e)
        return []


def setup_hotspot(device_name):
    """Create an open WiFi hotspot using NetworkManager."""
    ssid = device_name
    iface = get_wifi_interface()
    log.info('setting up hotspot SSID=%s on %s', ssid, iface)

    # Remove any stale hotspot connection from a previous run.
    subprocess.run(['sudo', '-n', 'nmcli', 'connection', 'delete', 'hearth-hotspot'],
                   capture_output=True, timeout=10)

    # Create the connection (open, no password). The agent runs as a non-root
    # user, so nmcli needs sudo (same as the dnsmasq call below).
    # NOTE: use ipv4.method=manual (static IP) and let OUR dnsmasq (started in
    # _setup_captive_dns) handle DHCP + captive DNS. Using ipv4.method=shared
    # makes NetworkManager launch its OWN dnsmasq, which collides with ours and
    # causes the connection to fail with 'ip-config-unavailable'.
    subprocess.run([
        'sudo', '-n', 'nmcli', 'connection', 'add',
        'type', 'wifi',
        'con-name', 'hearth-hotspot',
        'ifname', iface,
        'wifi.ssid', ssid,
        'wifi.mode', 'ap',
        'wifi.band', 'bg',
        'connection.autoconnect', 'no',
        'ipv4.method', 'manual',
        'ipv4.addresses', f'{HOTSPOT_IP}/{HOTSPOT_SUBNET}',
        'ipv4.never-default', 'yes',
    ], check=True, timeout=10)

    # Activate the hotspot
    subprocess.run(['sudo', '-n', 'nmcli', 'connection', 'up', 'hearth-hotspot'],
                   check=True, timeout=15)

    # Configure dnsmasq for captive portal DNS
    _setup_captive_dns(iface)

    log.info('hotspot active: %s (open, no password)', ssid)


def _setup_captive_dns(iface='wlan0'):
    """Configure dnsmasq for captive portal DNS + DHCP on the hotspot interface."""
    import os

    # Stop any existing dnsmasq
    subprocess.run(['sudo', '-n', 'killall', 'dnsmasq'], capture_output=True)

    config = f'''# Hearth-Connect captive portal dnsmasq config
interface={iface}
bind-interfaces
dhcp-range={HOTSPOT_RANGE},255.255.255.0,12h
dhcp-option=option:router,{HOTSPOT_IP}
dhcp-option=option:dns-server,{HOTSPOT_IP}
address=/#/{HOTSPOT_IP}
'''
    conf_path = '/opt/hearth-pi-agent/hearth-dnsmasq.conf'
    with open(conf_path, 'w') as f:
        f.write(config)

    subprocess.Popen(
        ['sudo', '-n', 'dnsmasq', f'--conf-file={conf_path}'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    log.info('captive DNS started on %s', iface)


def teardown_hotspot():
    """Tear down the hotspot and captive DNS."""
    log.info('tearing down hotspot')
    subprocess.run(['sudo', '-n', 'killall', 'dnsmasq'], capture_output=True)
    # Tolerate if the connection was already removed (e.g. by the portal's
    # _configure_wifi after user submitted credentials).
    subprocess.run(['sudo', '-n', 'nmcli', 'connection', 'down', 'hearth-hotspot'],
                   capture_output=True, timeout=10)
    subprocess.run(['sudo', '-n', 'nmcli', 'connection', 'delete', 'hearth-hotspot'],
                   capture_output=True, timeout=10)


PORTAL_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hearth Connect — WiFi Setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f7; color: #1d1d1f;
    padding: 20px; max-width: 480px; margin: 0 auto;
  }
  .header { text-align: center; padding: 30px 0 20px; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header p { color: #86868b; margin-top: 6px; font-size: 14px; }
  .card {
    background: #fff; border-radius: 12px;
    padding: 16px; margin-bottom: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
  }
  .section-title {
    font-size: 13px; font-weight: 600; color: #86868b;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 10px;
  }
  .network-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 0; border-bottom: 1px solid #f0f0f0;
    cursor: pointer;
  }
  .network-item:last-child { border-bottom: none; }
  .network-item:active { background: #f5f5f7; margin: 0 -16px; padding: 12px 16px; }
  .network-name { font-size: 16px; font-weight: 500; }
  .network-signal { font-size: 13px; color: #86868b; }
  .network-lock { color: #86868b; font-size: 14px; margin-left: 6px; }
  .form-group { margin-bottom: 14px; }
  .form-group label {
    display: block; font-size: 13px; font-weight: 500;
    color: #86868b; margin-bottom: 4px;
  }
  .form-group input {
    width: 100%; padding: 10px 12px; border: 1px solid #d2d2d7;
    border-radius: 8px; font-size: 16px; outline: none;
    -webkit-appearance: none;
  }
  .form-group input:focus { border-color: #0071e3; }
  .btn {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    font-size: 16px; font-weight: 500; cursor: pointer;
    background: #0071e3; color: #fff;
  }
  .btn:active { background: #0077ed; }
  .btn:disabled { background: #d2d2d7; cursor: not-allowed; }
  .btn-secondary {
    background: none; color: #0071e3; font-size: 14px;
    padding: 8px; margin-top: 6px;
  }
  .scan-btn {
    background: none; border: none; color: #0071e3;
    font-size: 14px; cursor: pointer; padding: 4px 0;
  }
  .status {
    text-align: center; padding: 10px; font-size: 14px;
    color: #86868b; display: none;
  }
  .status.error { color: #ff3b30; display: block; }
  .status.success { color: #34c759; display: block; }
  .status.loading { display: block; }
  .manual-toggle {
    text-align: center; margin-top: 12px;
  }
  .hidden { display: none !important; }
  .modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.4); display: flex;
    align-items: flex-end; justify-content: center;
    z-index: 100;
  }
  .modal {
    background: #fff; border-radius: 16px 16px 0 0;
    padding: 24px 20px 32px; width: 100%; max-width: 480px;
    animation: slideUp 0.2s ease-out;
  }
  @keyframes slideUp {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }
  .modal h3 { font-size: 18px; margin-bottom: 16px; text-align: center; }
  .modal .btn { margin-top: 8px; }
  .modal .btn-cancel {
    background: none; color: #0071e3; margin-top: 4px;
  }
</style>
</head>
<body>

<div class="header">
  <h1>Hearth Connect</h1>
  <p>Connect this device to your WiFi network</p>
</div>

<div class="card" id="networks-card">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div class="section-title">Available Networks</div>
    <button class="scan-btn" onclick="scanNetworks()">Refresh</button>
  </div>
  <div id="network-list">
    <p style="color:#86868b;font-size:14px;padding:8px 0">Scanning...</p>
  </div>
</div>

<div class="card">
  <div class="section-title">Manual Entry</div>
  <form id="manual-form" onsubmit="return connectManual(event)">
    <div class="form-group">
      <label>Network Name (SSID)</label>
      <input type="text" id="manual-ssid" placeholder="Enter WiFi name" autocomplete="off">
    </div>
    <div class="form-group" id="password-group">
      <label>Password</label>
      <input type="password" id="manual-password" placeholder="Enter password">
    </div>
    <button type="submit" class="btn" id="connect-btn">Connect</button>
  </form>
</div>

<div class="status" id="status"></div>

<div class="modal-overlay hidden" id="password-modal" onclick="closeModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <h3 id="modal-ssid"></h3>
    <form onsubmit="return connectFromModal(event)">
      <div class="form-group" id="modal-password-group">
        <label>Password</label>
        <input type="password" id="modal-password" placeholder="Enter password" autocomplete="off">
      </div>
      <button type="submit" class="btn" id="modal-connect-btn">Connect</button>
      <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    </form>
  </div>
</div>

<script>
let selectedSecurity = '';

async function scanNetworks() {
  const list = document.getElementById('network-list');
  list.innerHTML = '<p style="color:#86868b;font-size:14px;padding:8px 0">Scanning...</p>';
  try {
    const res = await fetch('/scan');
    const networks = await res.json();
    if (networks.length === 0) {
      list.innerHTML = '<p style="color:#86868b;font-size:14px;padding:8px 0">No networks found. Tap Refresh.</p>';
      return;
    }
    list.innerHTML = '';
    for (const net of networks) {
      const item = document.createElement('div');
      item.className = 'network-item';
      item.onclick = () => selectNetwork(net.ssid, net.security);
      const lock = net.security && net.security !== 'Open' ? '<span class="network-lock">🔒</span>' : '';
      item.innerHTML = `
        <div>
          <span class="network-name">${escHtml(net.ssid)}</span>${lock}
        </div>
        <span class="network-signal">${net.signal}%</span>
      `;
      list.appendChild(item);
    }
  } catch(e) {
    list.innerHTML = '<p style="color:#ff3b30;font-size:14px;padding:8px 0">Scan failed. Tap Refresh.</p>';
  }
}

function selectNetwork(ssid, security) {
  selectedSecurity = security;
  document.getElementById('modal-ssid').textContent = ssid;
  document.getElementById('modal-password').value = '';
  const pwGroup = document.getElementById('modal-password-group');
  if (security && security !== 'Open') {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  document.getElementById('password-modal').classList.remove('hidden');
  document.getElementById('modal-connect-btn').disabled = false;
}

function closeModal(e) {
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('password-modal').classList.add('hidden');
}

async function connectFromModal(e) {
  e.preventDefault();
  const ssid = document.getElementById('modal-ssid').textContent;
  const password = document.getElementById('modal-password').value;
  document.getElementById('modal-connect-btn').disabled = true;
  await doConnect(ssid, password);
}

function connectManual(e) {
  e.preventDefault();
  const ssid = document.getElementById('manual-ssid').value.trim();
  if (!ssid) return false;
  const password = document.getElementById('manual-password').value;
  document.getElementById('connect-btn').disabled = true;
  doConnect(ssid, password);
  return false;
}

async function doConnect(ssid, password) {
  const status = document.getElementById('status');
  status.className = 'status loading';
  status.textContent = 'Connecting to ' + ssid + '...';
  try {
    const res = await fetch('/connect', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ssid, password})
    });
    const data = await res.json();
    if (data.ok) {
      status.className = 'status success';
      status.textContent = 'Connected! The device will join your network in a moment.';
    } else {
      status.className = 'status error';
      status.textContent = data.error || 'Connection failed. Try again.';
      document.getElementById('connect-btn').disabled = false;
      document.getElementById('modal-connect-btn').disabled = false;
    }
  } catch(e) {
    status.className = 'status error';
    status.textContent = 'Error. Try again.';
    document.getElementById('connect-btn').disabled = false;
    document.getElementById('modal-connect-btn').disabled = false;
  }
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

scanNetworks();
</script>
</body>
</html>
"""


class PortalHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the captive portal."""

    def log_message(self, fmt, *args):
        log.debug('portal: ' + fmt, *args)

    def _send(self, code, content_type, body):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path

        # OS captive-portal probes. IMPORTANT: returning the platform's
        # "success"/"online" signal here tells the device it has internet and
        # suppresses the sign-in sheet. To *trigger* the captive portal we must
        # return the portal page (non-success content) instead, so the OS
        # detects a captive network and shows it.

        # Apple captive portal detection
        if path == '/hotspot-detect.html':
            self._send(200, 'text/html', PORTAL_HTML)
            return

        # Android / Chrome captive portal detection
        if '/generate_204' in path or path == '/gen_204':
            self._send(200, 'text/html', PORTAL_HTML)
            return

        # Microsoft captive portal detection
        if '/connecttest.txt' in path or '/ncsi.txt' in path or '/redirect' in path:
            self._send(200, 'text/html', PORTAL_HTML)
            return

        # Firefox captive portal detection
        if '/canonical.html' in path or path == '/success.txt':
            self._send(200, 'text/html', PORTAL_HTML)
            return

        # Network scan endpoint
        if path == '/scan':
            networks = scan_networks()
            self._send(200, 'application/json', json.dumps(networks))
            return

        # Serve the portal page for everything else
        self._send(200, 'text/html', PORTAL_HTML)

    def do_POST(self):
        path = urlparse(self.path).path

        if path == '/connect':
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body)
            except Exception:
                self._send(400, 'application/json', '{"error":"bad json"}')
                return

            ssid = data.get('ssid', '').strip()
            password = data.get('password', '')

            if not ssid:
                self._send(400, 'application/json',
                           json.dumps({'error': 'SSID is required'}))
                return

            log.info('user selected WiFi: %s', ssid)
            _configure_wifi(ssid, password)

            self._send(200, 'application/json', '{"ok":true}')
            return

        self._send(404, 'text/plain', 'Not Found')


def _configure_wifi(ssid, password):
    """Configure a WiFi connection and tear down the hotspot."""
    import time as _time

    try:
        # Create or modify the WiFi connection
        conns = subprocess.check_output(
            ['nmcli', '-t', '-f', 'NAME,TYPE', 'connection', 'show'],
            text=True, timeout=5
        )
        # Check if we already have a connection for this SSID
        existing = False
        for line in conns.strip().split('\n'):
            parts = line.split(':')
            if len(parts) >= 2 and parts[0] == ssid and parts[1] == '802-11-wireless':
                existing = True
                break

        if existing:
            # Update existing connection
            subprocess.run([
                'sudo', '-n', 'nmcli', 'connection', 'modify', ssid,
                'wifi.ssid', ssid,
                'wifi-sec.key-mgmt', 'wpa-psk' if password else 'none',
            ], check=True, timeout=10)
            if password:
                subprocess.run([
                    'sudo', '-n', 'nmcli', 'connection', 'modify', ssid,
                    'wifi-sec.psk', password,
                ], check=True, timeout=10)
            # Ensure it autoconnects
            subprocess.run([
                'sudo', '-n', 'nmcli', 'connection', 'modify', ssid,
                'connection.autoconnect', 'yes',
            ], check=True, timeout=5)
        else:
            # Create new connection
            cmd = [
                'sudo', '-n', 'nmcli', 'connection', 'add',
                'type', 'wifi',
                'con-name', ssid,
                'wifi.ssid', ssid,
                'wifi-sec.key-mgmt', 'wpa-psk' if password else 'none',
                'connection.autoconnect', 'yes',
            ]
            subprocess.run(cmd, check=True, timeout=10)
            if password:
                subprocess.run([
                    'sudo', '-n', 'nmcli', 'connection', 'modify', ssid,
                    'wifi-sec.psk', password,
                ], check=True, timeout=10)

        # Tear down the hotspot first so the WiFi interface is freed
        teardown_hotspot()

        # Connect to the new WiFi network
        result = subprocess.run(
            ['sudo', '-n', 'nmcli', 'connection', 'up', ssid],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            log.error('failed to connect to %s: %s', ssid, result.stderr)
            # Re-setup hotspot on failure
            setup_hotspot(get_device_name())
        else:
            log.info('connected to %s', ssid)
            # Signal the agent to fall back to mDNS discovery now that WiFi is up.
            wifi_configured_event.set()
    except Exception as e:
        log.error('WiFi config failed: %s', e)
        try:
            setup_hotspot(get_device_name())
        except Exception:
            pass


class CaptivePortal:
    """Manages the captive portal HTTP server."""

    def __init__(self):
        self._server = None
        self._thread = None

    def start(self):
        """Start the HTTP server on port 80 in a daemon thread.

        Uses ThreadingHTTPServer so concurrent requests from a phone (captive
        probes + page assets) don't block each other and time out.
        """
        self._server = ThreadingHTTPServer(('0.0.0.0', 80), PortalHandler)
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        daemon=True)
        self._thread.start()
        log.info('captive portal HTTP server started on port 80')

    def stop(self):
        if self._server:
            self._server.shutdown()
            log.info('captive portal HTTP server stopped')
