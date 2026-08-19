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

## Live Pi-agent video check

`e2e-verify-pi-video.mjs` — does **not** spawn an agent. It joins the live room
and subscribes to the **existing** Pi source (default looks for a `pi-` publisher
labelled `Cat Room`), then asserts the browser receives a **video track with
non-zero media bytes**. This proves the physical Pi's camera/encoder is actually
publishing watchable WebRTC — i.e. full end-to-end media, not just signaling.

Auto-SKIPS (exit 0) when the server is unreachable or no Pi source is present in
the room, so it is CI-safe. Requires the real Pi to be running and the server
reachable over WSS.

```bash
SERVER_URL=https://<host>:8090 ROOM_ID=default TARGET_LABEL='Cat Room' \
  npm run test:pi-live
```

## Full Pi-agent validation

To fully validate the Pi agent, run the three layers (pure logic, self-contained
interop, and the live device check):

```bash
# 1. Pure Python logic (no GStreamer needed) — linux/pi-agent/
python3 -m unittest test_pi_agent.py

# 2. Self-contained: spawns a TEST_SOURCE agent and drives a browser subscriber
npm run test:pi-interop

# 3. Live: subscribes to the REAL Pi and asserts video frames are received
npm run test:pi-live
```

`npm run test:pi-browser` runs steps 2 and 3 together. Step 2 needs GStreamer +
`websockets` + a Chromium build on the host; step 3 needs the physical Pi online.
Both auto-skip when their dependencies are absent.

