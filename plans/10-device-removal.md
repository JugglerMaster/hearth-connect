# 10 — Manual Device Removal from the Device List

The base station's device list (`base-station.js:64`) is built from `recentlySeenDevices`, which
is **in-memory and only pruned when a same-type device rejoins with a new id**
(`ChannelManager.ts:67`). Offline/stale kiosks linger for the 24h window (or forever until a
conflicting join), and there is no way to manually clear them. This adds a **Remove** button in
the device settings panel.

## A. New signaling message: `REMOVE_DEVICE`

Add `MessageType` `'REMOVE_DEVICE'` to `types.ts:99`.

Base station → server:
```
{ type:'REMOVE_DEVICE', payload: { targetDeviceId } }
```
Server may also broadcast a `DEVICE_REMOVED` so all base stations update:
```
{ type:'DEVICE_REMOVED', payload: { deviceId } }
```
(reuse this name to avoid colliding with `SOURCE_REMOVED`; if preferred, add
`'DEVICE_REMOVED'` to `MessageType`.)

## B. Server handler — `SignalingHandler.ts`

Add `case 'REMOVE_DEVICE'` (only base stations allowed, like `handleSetConfig`):

1. Validate `targetDeviceId`.
2. If the target is **currently connected**, close its WebSocket so it disconnects cleanly
   (`this.channels.getClient(targetDeviceId)?.ws` → `ws.close()`). This triggers the normal
   `handleDisconnect` grace flow.
3. Remove from in-memory recently-seen:
   `this.channels.removeRecentlySeen(targetDeviceId)` — **add this method to `ChannelManager`**
   (delete the entry from `recentlySeenDevices`).
4. Persist removal: `this.config.deleteDevice(targetDeviceId)` (already implemented,
   `ConfigManager.ts:193`).
5. Broadcast `DEVICE_REMOVED` to all clients (excluding sender optional) so every base station
   drops the row immediately:
   `this.channels.broadcastAll({ type:'DEVICE_REMOVED', payload:{ deviceId: targetDeviceId } })`.

> Online devices: removing a connected one closes its socket; it *can* rejoin later (a new
> `JOIN_ROOM` re-creates the record). That matches the request — "if it's online it can come
> back." The removal is a manual de-clutter, not a ban.

## C. ChannelManager addition

```ts
removeRecentlySeen(deviceId: string): void {
  this.recentlySeenDevices.delete(deviceId);
}
```

## D. Base station UI — `base-station.js`

In `showConfig(device)` (`base-station.js:159`), add a **Remove device** button **above Save**:

```
<button id="removeDeviceBtn" class="btn btn-danger" style="margin-top:12px">Remove device</button>
<button id="saveConfigBtn" class="btn btn-primary" style="margin-top:12px">Save</button>
```

- Wire a click handler (alongside the existing `saveConfigBtn` handler, `base-station.js:203`):
  ```
  document.getElementById('removeDeviceBtn').addEventListener('click', () => {
    if (confirm('Remove ' + device.label + ' from the list?')) {
      sig.removeDevice(device.id);
      configPanel.classList.add('hidden');
    }
  });
  ```
- Add `sig.removeDevice(id)` to `signaling.js` (mirrors `setConfig`):
  `removeDevice(targetDeviceId){ this.send('REMOVE_DEVICE',{targetDeviceId}); }`

## E. Base station: handle `DEVICE_REMOVED`

Add `sig.on('deviceRemoved', (data) => { ... })`:
- Remove from `devices`: `devices = devices.filter(d => d.id !== data.deviceId);`
- If it was being watched, call `stopView()` (the stream is gone).
- `renderDevices()`.

(Mirror the existing `sourceRemoved`/`deviceStatus` handling patterns.)

## F. UX notes

- Show the Remove button for any device in the list (online or offline). Online devices are just
  disconnected; they may reappear on next join — acceptable per requirements.
- No server restart needed; removal is immediate + persisted.
- If the removed device is the one whose settings panel is open, close the panel.
