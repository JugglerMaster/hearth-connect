# Plan: Home Assistant Integration for Hearth-Connect

## Goal
Turn the Hearth-Connect kiosk (base station / monitor / viewer) into a **Home
Assistant control surface**:
- **Show** HA data — lights, switches, sensors, scenes — as live tiles/buttons on
  the HC UI (the "buttons and other data" the user wants to see).
- **Send** commands to HA — e.g. "turn on light 1" — straight from those tiles.
- (Secondary) HC also surfaces *its own* events (motion/audio/broadcast) into HA
  so HA automations can react. That part is covered under "HC → HA events" below.

This is HA-as-backend, HC-as-client. The local, private, sub-second nature of both
projects fits well: the kiosk talks to HA over LAN.

## What Hearth-Connect needs from HA
Home Assistant exposes two local APIs (both need a **long-lived access token**,
created in HA Profile → Security):
- **WebSocket API** (`ws(s)://<ha>/api/websocket`) — auth, subscribe to
  `state_changed` (real-time entity updates), and `call_service` (send commands).
  This is the right one for a live dashboard.
- **REST API** (`/api/states`, `/api/services/<domain>/<service>`) — simpler,
  polling-based fallback.

## Integration options (HC displays HA + sends commands)

### Option A — HA WebSocket client in the kiosk (RECOMMENDED)
Add a `homeAssistant.js` (browser) / `HomeAssistantClient` (Android) module that:
1. Connects to `ws(s)://<ha-host>/api/websocket` with the long-lived token.
2. Calls `subscribe_entities` / `subscribe_events` (`state_changed`) and keeps a
   local map of entity states.
3. Renders a configurable panel of HA entities as tiles (light on/off, switch,
   sensor readout, scene button) inside `base-station.html` / `monitor.html`.
4. On tile tap → `call_service` (`light.turn_on`, `switch.turn_off`, etc.).
- **Pros**: Real-time, local, two-way, no HA add-ons, no polling. Natural fit for
  an always-on wall kiosk.
- **Cons**: Token storage in `config.json` (keep out of git); WS reconnect/backoff
  logic (mirror the existing signaling reconnect approach); HA schema drift.

### Option B — HA REST polling (fallback / simpler)
`GET /api/states` + `POST /api/services/...`, polled on an interval (e.g. 2–5s).
- **Pros**: Trivial; no WS state machine; easy to unit-test with a mock server.
- **Cons**: Latency; chattier; no push. Use only if WS is unwanted.

### Option C — Embed the HA dashboard via iframe / HA Cast
Render HA's own Lovelace view inside the HC kiosk using an `iframe` panel pointed
at a dedicated HA dashboard URL (or HA Cast to take over the screen).
- **Pros**: Zero HC UI code; full HA feature set.
- **Cons**: Heavy; pulls the entire HA frontend; weak integration with HC's own
  camera/monitor tiles; auth/cookie handling on a kiosk; not great on low-RAM tabs.
  Good as a quick win, poor as the long-term design.

## Recommended path
**Option A** as the real integration, **B** as a testable fallback, **C** only as a
throwaway quick demo. Keep the HA connection settings in the existing
`ConfigManager` JSON store (`ha: { url, token, entities: [...] }`).

## Config model
```jsonc
{
  "homeAssistant": {
    "url": "http://homeassistant.local:8123",  // or https
    "token": "<long-lived-access-token>",       // secret, gitignored
    "panel": {
      "entities": ["light.living_room_1", "switch.coffee", "sensor.nursery_temp"],
      "areas": ["Nursery"]                        // optional: pull all entities in area
    }
  }
}
```
A settings section in `base-station.html` lets the user paste the URL + token and
pick which entities/areas to surface. The token is write-only (never echoed back).

## Build steps (Option A)
1. **Config schema** — extend `types.ts` + `ConfigManager` with `homeAssistant`
   (url, token, panel). Add a "Home Assistant" settings card to `base-station.html`
   and the native base-station UI.
2. **`homeAssistant.js`** (browser client):
   - `connect()` → WS auth handshake (`auth` / `auth_required` / `auth_ok`).
   - `subscribeEntities(ids)` → `subscribe_events` filtered to `state_changed`;
     maintain `Map<entityId, state>`.
   - `callService(domain, service, target)` → `call_service` message.
   - Reconnect with exponential backoff (reuse `signaling.js` pattern).
3. **Render panel** — a `homeAssistantPanel` component that draws a tile per
   configured entity: toggle for `light`/`switch`, button for `scene`/`script`,
   readout for `sensor`/`binary_sensor`. Tiles reflect live `state_changed` pushes.
4. **Android parity** — `HomeAssistantClient` in `WebRTCManager`/service context
   using `okhttp` WS, same message protocol; render tiles in the native UI.
5. **Security** — token in gitignored config; TLS verification note (self-signed
   HA needs cert trust or `verify_ssl: false` for dev); never log the token.
6. **Tests** — mock HA WS server (Node `ws`) asserting: auth handshake, subscribe,
   `state_changed` → panel update, `call_service` payload shape. No real HA needed.
7. **Docs** — `examples/homeassistant/` with token-creation steps + a sample panel
   config + the entity list to expose.

## HC → HA events (secondary, the earlier idea)
Independent of the dashboard above, HC can also *emit* its own events into HA:
- **Outgoing webhooks** (already a README todo): HC POSTs audio/motion/broadcast
  alerts to an HA Webhook trigger (`/api/webhook/<id>`), ntfy, or Pushover.
- **MQTT bridge** (optional): publish HC source state via HA MQTT Discovery and
  subscribe command topics so HA can wake/broadcast/select a monitor.
These are one-directional (HC → HA) and complement the dashboard; ship them after
Option A if desired.

## Risks / caveats
- **Token secrecy**: long-lived token in `config.json`; ensure config is gitignored
  and never returned by any API/UI read.
- **HA availability**: if HA is down, panel shows "unavailable"; tiles must degrade
  gracefully and not block the camera UI.
- **Schema drift**: entity IDs / service signatures change as HA versions move;
  keep the client tolerant (ignore unknown entity types, render generic tile).
- **Self-signed HA TLS**: dev HA often uses a self-signed cert; document trusting it
  or disabling verification for LAN-only use.
- **Scope**: the kiosk shows a *curated* subset of HA (the `panel.entities` list),
  not the full Lovelace editor — keep it simple on-purpose.
