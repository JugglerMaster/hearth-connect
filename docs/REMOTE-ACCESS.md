<!--
  "Go therefore and make disciples of all nations... and surely I am with you
  always, to the very end of the age." — Matthew 28:19-20
  Built so the home stays connected wherever the family goes.
-->

# Remote Access (Tailscale)

Reach Hearth-Connect from your iPhone over **cellular** while traveling — no
port forwarding, no public IP, works through hotel Wi-Fi / CGNAT.

This uses Tailscale (encrypted WireGuard mesh) as a **subnet-router gateway**:
install on the home server + the phones only, and the iPhone reaches the
Raspberry Pi cameras *through* the server's LAN by their existing IPs. The Pis
need **no** Tailscale install.

## Topology

```
   iPhone (cellular)  ──Tailscale──▶  Home Server (Tailscale + subnet router)
                                          │  advertises 192.168.1.0/24
                                          ▼
                                   RPi3 cameras (plain LAN IPs)
```

## 1. Install on the home server + enable subnet router

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --advertise-routes=192.168.1.0/24
```

Replace `192.168.1.0/24` with your actual LAN subnet.

Then approve the route once in the Tailscale admin console:
**Machines → your server → "Review route" → approve**.

## 2. Install on each iPhone

- App Store → **Tailscale**, log in with the **same** account used on the server.
- Open the app and toggle the connection on. It auto-reconnects on cell.

## 3. ⚠️ Re-issue the TLS cert for the address the iPhone will use

iOS Safari does a **strict** cert name match. The hostname/IP you type on the
phone MUST be in the server cert's `subjectAltName` (see `docker/gen-cert.sh`),
or you'll get a security warning and a fresh camera/mic permission prompt on
every reload.

### Option A — subnet gateway (recommended): reach server by its LAN IP

If you already generated the cert with `EXTRA_IPS=<server-lan-ip>`, you're done.
Otherwise re-issue including the LAN IP:

```bash
cd docker
EXTRA_IPS=192.168.1.50 ./gen-cert.sh hearth.local ./certs
```

Then open on the iPhone: `https://192.168.1.50:8090`

### Option B — Tailscale on everything (full mesh): use the tailnet name/IP

Install Tailscale on each Pi too, then use either the MagicDNS name or the
Tailscale IP as the cert SAN:

```bash
cd docker
./gen-cert.sh hearth-server.yourtailnet.ts.net ./certs
```

Then open on the iPhone: `https://hearth-server.yourtailnet.ts.net:8090`

After re-issuing certs, restart the server (e.g. `sudo systemctl restart hearth-connect`).

## 4. Connect

On the iPhone, with Tailscale connected, open the URL from step 3. WebRTC media
between the iPhone and the Pis flows directly — the Pi advertises its LAN IP as
an ICE candidate and the iPhone has a route to that subnet via the gateway.

## Gateway vs. full-mesh tradeoff

| | Subnet gateway (recommended) | Tailscale on every Pi |
|---|---|---|
| Installs | server + phones only | server + Pis + phones |
| Pi down/reboot | still reachable (plain LAN device) | per-Pi tailnet identity |
| Single point of failure | the server/gateway | none |
| Per-device ACLs on Pis | no (shared gateway identity) | yes |

Use the gateway for travel. Install on the Pis too only if you want to manage/
kill individual Pis remotely or your server and Pis live on network segments a
single subnet route can't cover.
