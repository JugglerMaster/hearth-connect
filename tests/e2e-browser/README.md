# e2e-browser

Automated browser tests for Hearth-Connect client WebRTC.

## Playwright ↔ Pi-agent interop

`e2e-pi-agent-interop.mjs` — loads the real `server/public/js/{webrtc,signaling}.js`
into Chromium, subscribes to a real GStreamer Pi agent (`TEST_SOURCE=1`), and
asserts the peer connection reaches `connected` with a received track. This is
the only automated exercise of the GStreamer `mid` mismatch fix
(`webrtc.js:_resolveMid`).

Requires Playwright + a Chromium build, and a running server (Android hub or
Node server). Spawns the agent itself, but needs GStreamer + `websockets` on
the host. Auto-skips (exit 0) when any dependency is missing.

```bash
npm i -D playwright && npx playwright install chromium
SERVER_URL=https://<host>:8090 ROOM_ID=test npm run test:pi-interop
```

The Pi agent always connects via `wss`, so the server must be reachable over
HTTPS/WSS. For the Node server, start it with `TLS_ENABLED=true` (it
auto-generates a self-signed cert in `server/certs`). The browser loads
`/interop-harness.html` from the server origin so the loopback WebSocket is
same-origin and not blocked by Chromium's Local Network Access check.

LAN/local only (STUN, no TURN) — run the agent and the browser on the same host
or subnet.
