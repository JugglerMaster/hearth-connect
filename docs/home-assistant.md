# Home Assistant Integration

Hearth-Connect can act as a Home Assistant control surface: a curated dashboard
of light/climate tiles that show live state and send commands, with the hub
(mobile app or Node server) owning the single connection to HA.

## Architecture: server-owned relay

The kiosk never talks to Home Assistant directly and never holds the
long-lived token:

```
kiosk  ──WS signaling──▶  hub (HA relay)  ──WS /api/websocket──▶  Home Assistant
                         (injects token,                              (auth_required
                          tolerates self-signed cert)                 → auth → auth_ok)
```

- The base station saves the HA **URL + long-lived token** in server settings
  (base-station.html → "Server Settings — Home Assistant"). The token is
  write-only: reads return `hasToken: true` only.
- The hub opens the outbound WebSocket to `…/api/websocket`, replies to HA's
  `auth_required` with the token, and relays raw frames (`HA_CONNECT`,
  `HA_FRAME`, `HA_CONNECTED`, `HA_DISCONNECTED`, `HA_ERROR`) over the existing
  signaling channel.
- The dashboard (`home-assistant.html`) renders editable, multi-page tiles of
  lights (on/off + brightness) and climate (HVAC mode + setpoint). Layout is
  saved as `homeAssistant.pages[]` in server settings.

This keeps HA's (often self-signed) cert and the token server-side, off every
device on the wall.

## Create a long-lived token

In Home Assistant: **Profile → Security → Long-lived access tokens → Create
token**. Copy it once; it is stored only on the hub.

## Sample server settings

```jsonc
{
  "homeAssistant": {
    "url": "http://homeassistant.local:8123", // or https
    "token": "<long-lived-access-token>",      // secret, not echoed back
    "pages": [
      {
        "id": "p1",
        "name": "Nursery",
        "entities": ["light.nursery_lamp", "climate.nursery_thermostat"]
      }
    ]
  }
}
```

Edit the layout live from the Home Assistant page: open **Edit layout**,
**Add entities** (filters to `light`/`climate`), then **Save**. The change is
pushed to all base stations via `SETTINGS_UPDATED`.

## HA availability / TLS

- If HA is down or unconfigured, the dashboard shows the error state and tiles
  degrade gracefully — camera/monitor UI is never blocked.
- Dev HA frequently uses a self-signed cert. The hub tolerates it
  **LAN-only** (server-side `rejectUnauthorized` / a trust-all `SSLContext`);
  the token still never leaves the hub.
- Entity IDs / service signatures drift across HA versions; the client renders
  unknown entity types as a generic tile and ignores the rest.
