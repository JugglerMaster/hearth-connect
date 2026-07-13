# iOS Safari Debug Bridge (Linux → USB → iOS)

## Goal
Drive real iOS Safari on a tethered device from this Linux box to:
- Load `monitor.html`, `base-station.html`, `viewer.html` against the running
  server (default `https://<host>:8090`, TLS self-signed in `server/certs/`).
- Inspect the DOM, read console logs, evaluate client JS, capture screenshots.
- Exercise the signaling handshake (WebSocket) and assert UI state changes.

This does NOT automate camera/mic capture (iOS requires a real user gesture +
secure context that automation cannot satisfy). That part stays a manual
on-device check (see AGENTS.md "Client-Side Verification" for the Node-vm
logic tests that cover the press-and-hold race without a device).

## Architecture
```
Linux host
  ├─ server/  (node + ts-node, serves static + WS signaling on :8090, TLS)
  │
  ├─ ios-webkit-debug-proxy        (usbmuxd → Safari inspector tunnel)
  │     run as: ios_webkit_debug_proxy -c "*:9222" -d
  │     exposes WebInspector JSON-RPC on localhost:9222
  │
  ├─ remotedebug-ios-webkit-adapter (wraps 9222 as Chrome DevTools Protocol)
  │     run as: remotedebug_ios_webkit_adapter -p 9000
  │     exposes CDP endpoint on localhost:9000
  │
  └─ tests/ios-debug-bridge/  (Node + ws, raw CDP — NOT puppeteer)
        bridge.js → cdp.js (CDPPage): talks directly to the page target's
        WebSocket. Drives iOS Safari: navigate, evaluate, capture console.
```

Data flow: CDPPage (ws) ↔ adapter (CDP) ↔ ios-webkit-debug-proxy
(WebInspector) ↔ usbmuxd (USB) ↔ iOS Safari.

### Why raw CDP, not puppeteer
`remotedebug-ios-webkit-adapter` does NOT implement puppeteer's browser-level
target handshake, so `puppeteer.connect()` hangs forever. Talking directly to
the page target's `webSocketDebuggerUrl` (via the `ws` package) works reliably.
See `cdp.js` for the minimal CDP client.

## Required components & install (see README.md for the one-liner)

### Host (Linux) packages
- `libimobiledevice`  (provides `idevice_id`, `idevicepair`, `idevicesyslog`)
- `usbmuxd`           (USB multiplexing daemon)
- `libusbmuxd` / `libplist` (deps)
- `ios-webkit-debug-proxy` (build from source; Debian/Ubuntu package is stale)
- `automake autoconf libtool pkg-config` (build deps for the proxy)

### Node packages (local to this folder, NOT server/)
- `puppeteer-core`   (connect to external browser, no bundled Chromium download)
- `ws`               (talk to the adapter's JSON/WS endpoints)
- `chalk`            (optional, nicer logs)

We deliberately use `puppeteer-core` so we don't pull a 150MB Chromium that
Linux can't use to drive iOS anyway.

### Device (iOS) requirements
- Safari → Settings → Safari → Advanced → **Web Inspector = ON**
- For first pairing: `idevicepair pair` and tap "Trust" on the device.
- A real user must open the target page in Safari and keep Safari foregrounded;
  the inspector attaches to an *already-open* tab (it cannot launch Safari
  headlessly). bridge.js can list open tabs and pick by URL, or navigate.

## Server-side expectations (grounded in server/src/index.ts)
- Default port `8090` (env `SERVER_PORT`), TLS via `server/certs` when
  `--tls` or `TLS_ENABLED=true`. Self-signed → Puppeteer must pass
  `ignoreHTTPSErrors: true` and the device must already trust the CA
  (see deploy/gen-cert.sh; otherwise Safari blocks the page).
- For a friction-free debug loop on LAN, run the server with TLS OFF on a
  plain HTTP port OR serve over `localhost`-style tunnel; camera/mic still
  needs HTTPS for real capture, but for DOM/signaling inspection plain HTTP
  to a trusted dev host is fine.
- `npm run dev` (ts-node) gives hot-reload while you iterate on the client JS.

## Bridge script design (`bridge.js`)
1. Locate device via `idevice_id -l`; bail with a friendly message if none.
2. Connect to the adapter at `http://localhost:9000/json/version` to obtain the
   CDP `webSocketDebuggerUrl`.
3. `puppeteer.connect({ browserWSEndpoint, ignoreHTTPSErrors: true })`.
4. `browser.targets()` → find the Safari tab whose URL matches the requested
   page; if not found (and allowed), `page.goto(<serverUrl>/<page>)`.
5. Attach `console` + `pageerror` listeners; forward to host stdout.
6. Expose helpers: `page.evaluate(fn)`, `page.screenshot({path})`, log buffer.
7. Run a small assertion suite (`assertions.js`) — DOM/state only, no camera.

## Runner / orchestration (`run.sh`)
- `run.sh start` launches usbmuxd, ios-webkit-debug-proxy, adapter as background
  processes (pidfiles + logs under `./.run/`), then runs `bridge.js`.
- `run.sh stop` tears them down.
- `run.sh status` checks which services are alive.
- Idempotent; checks for already-running services before spawning.

## Limitations & gotchas (call them out up front)
- No headless Safari launch; a human opens the page and keeps it foregrounded.
- No camera/mic capture under automation. Logic already covered by Node-vm
  tests in AGENTS.md; media path stays manual.
- iOS version drift: the WebInspector protocol changes between iOS majors;
  adapter compatibility is best on recent iOS. Pin a known-good iOS if flaky.
- USB only: if the cable drops, the inspector session dies; bridge should
  detect disconnect and print "reconnect device".
- This is a dev/debug aid, NOT CI. Keep it out of the production Docker image.

## Files in this folder
- `PLAN.md`       (this file)
- `package.json`  (puppeteer-core + ws + chalk)
- `bridge.js`     (CDP connect + helpers + console capture)
- `assertions.js` (DOM/state assertions, no camera)
- `run.sh`        (launch orchestration + teardown)
- `README.md`     (host install one-liner)
- `.gitignore`    (node_modules, .run/)

## Out of scope (future, separate branch)
- Appium/WebDriverAgent on a Mac for true automation incl. gestures.
- BrowserStack/device-cloud integration for CI without Apple hardware.
