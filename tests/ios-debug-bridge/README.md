# iOS Safari Debug Bridge (Linux → USB)

Drive **real iOS Safari** on a USB-tethered device from this Linux box for
DOM inspection, console capture, and signaling-handshake checks.

> ⚠️ This is a **debug aid**, not camera/mic automation. iOS requires a real
> user gesture + secure context that automation cannot satisfy. The
> press-and-hold broadcast logic is covered by the Node-`vm` tests documented
> in `AGENTS.md`; the real media path stays a manual on-device check.

## What it does
- Attaches to an already-open Safari tab (or navigates to one).
- Evaluates JS in the page (DOM/state inspection).
- Captures `console` + `pageerror` output to your terminal.
- Runs DOM-only assertions (`assertions.js`) on a real device.
- Screenshot is NOT supported on iOS WebInspector (`Page.captureScreenshot`
  is absent) — the `SCREENSHOT` env var is accepted but will warn and skip.

## Architecture
```
CDPPage (ws, in bridge.js/cdp.js)
  ↔ remotedebug-ios-webkit-adapter  (localhost:9000, Chrome DevTools Protocol)
  ↔ ios-webkit-debug-proxy          (localhost:9222, WebInspector; run as -c "*:9222" -d)
  ↔ usbmuxd                         (USB)
  ↔ iOS Safari
```
NOTE: We use raw CDP via the `ws` package, NOT puppeteer — the adapter does
not implement puppeteer's browser handshake (puppeteer.connect hangs).

## Host install (Debian/Ubuntu)
```bash
# 1. USB + device tooling
sudo apt-get update
sudo apt-get install -y usbmuxd libimobiledevice-utils \
  automake autoconf libtool pkg-config libusbmuxd-dev libplist-dev

# 2. ios-webkit-debug-proxy (distro package is stale; build from source)
git clone https://github.com/google/ios-webkit-debug-proxy.git /tmp/iwdp
cd /tmp/iwdp
./autogen.sh && make && sudo make install

# 3. adapter (Node)
sudo npm install -g remotedebug-ios-webkit-adapter

# 4. this folder's deps
cd tests/ios-debug-bridge
npm install
```

## Device setup (one time)
1. Settings → Safari → Advanced → **Web Inspector = ON**.
2. Plug in via USB, then:
   ```bash
   idevicepair pair      # tap "Trust" on the device
   ```
3. Open the target page in Safari and keep Safari **foregrounded**
   (the inspector attaches to an open tab; it can't launch Safari headlessly).

## Run
```bash
# From tests/ios-debug-bridge/
bash run.sh start    # launches usbmuxd-proxy + adapter + bridge.js
bash run.sh status   # what's alive
bash run.sh stop     # tear down

# Or run the bridge directly with env knobs:
SERVER_URL=https://192.168.1.50:8090 PAGE=base-station.html ROOM=test \
  NAVIGATE=1 node bridge.js
```

### Env knobs (bridge.js)
| Var | Default | Meaning |
|-----|---------|---------|
| `SERVER_URL` | `https://localhost:8090` | Hearth-Connect server base URL |
| `PAGE` | `base-station.html` | `monitor.html` \| `base-station.html` \| `viewer.html` |
| `ROOM` | _(empty)_ | appended as `?room=` |
| `NAVIGATE` | _(unset)_ | set `1` to auto-open the page if no matching tab |
| `SCREENSHOT` | _(empty)_ | **not supported** on iOS; warn+skip |
| `DEVICE_UDID` | _(auto)_ | pin a specific device |
| `ADAPTER_PORT` | `9000` | adapter CDP port |
| `PROXY_PORT` | `9222` | ios-webkit-debug-proxy port |

## Limitations
- No headless Safari launch — a human opens/keeps the page foregrounded.
- No camera/mic capture under automation.
- iOS WebInspector protocol drifts between major versions; adapter compat is
  best on recent iOS.
- USB drop kills the session; re-run `bash run.sh start` after reconnecting.
- Not for CI — keep it out of the production Docker image.

## Files
- `bridge.js` — CDP attach + console capture + assertions hook (raw CDP)
- `cdp.js` — minimal CDP client over `ws` (no puppeteer)
- `assertions.js` — DOM/state assertions (no camera)
- `run.sh` — start/stop/status orchestration
- `package.json` — `ws` + `chalk`
- `PLAN.md` — design notes and server-fit analysis
