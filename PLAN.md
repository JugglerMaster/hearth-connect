# Phase 2: Room Control + Hamburger Menu

## Phase 2A — Room Control Page

### Goal
Create `room-control.html` + `room-control.js` — a single page that combines
base-station (device list, config, broadcast, monitor feeds) and monitor
(camera publishing, wake lock, audio analyser) into an all-in-one dashboard.

### Files to Create

**`server/public/room-control.html`**
- Layout based on `base-station.html` with additions from `monitor.html`
- Header: "Room Control" + connection dot
- Monitor feed area (`#monitorFeed`): video element + overlay controls (mute, talk,
  FaceTalk, fullscreen, stop) — same structure as base-station.html
- Own camera preview section: `<video id="selfPreview">` for local camera, shown as
  small PiP thumbnail in bottom-right when monitoring a remote feed, or larger when
  no feed is selected
- Enable camera overlay (iOS gesture): `<div id="enableCamOverlay">` with tap button
- `<audio id="remoteAudio">` + `<audio id="noSleepAudio">` for talkback and wake lock
- Camera error dialog
- Home view: device list panel + config panel
- Broadcast panel
- Incoming call modal + toast
- Loads: `signaling.js`, `webrtc.js`, `room-control.js`

**`server/public/js/room-control.js`**
- IIFE combining base-station.js and camera.js logic
- Joins as `deviceType = 'base'`
- Own camera is published as a source (like camera.js does), so other devices can
  subscribe to it
- When monitoring a remote kiosk: own camera shows as small PiP in bottom-right
- When no feed selected: own camera preview is larger, device list is visible
- Init flow:
  1. Generate/restore deviceId from `localStorage.hearth_rcDeviceId`
  2. Set `sig.deviceType = 'base'`
  3. Connect signaling
  4. On open: join room
  5. On welcome: render devices, acquire camera (with iOS gesture fallback),
     publish source, report capabilities
  6. Wire all sig.on handlers (device status, source added/removed, subscriber
     joined/left, config, doorbell, audio peak, talk, call state, broadcast sources)
  7. Wire rtc.onRemoteTrack for both monitoring and broadcast streams
  8. Start watchdog interval

### Files to Modify

**`server/public/index.html`**
- Add third card: `<a href="/room-control.html" class="card card-accent">`
  - Icon: 🎛️
  - Title: "Room Control"
  - Subtitle: "Full control with camera"
  - Badge: "all-in-one"

**`android/.../MainActivity.kt`**
- Change `loadBaseStation()` URL from `base-station.html` to `/` (index.html)

---

## Phase 2B — Hamburger Menu

### Goal
A hamburger button (☰) in the top-left corner of every page **except** `monitor.html`.
Tapping opens a slide-out drawer from the left with navigation and settings.

### Files to Create

**`server/public/js/topbar.js`**
- IIFE that runs on DOMContentLoaded
- Skips injection if `document.body.classList.contains('monitor-page')`
- Builds DOM:
  - `<button id="hamburgerBtn">☰</button>` — fixed top-left, semi-transparent
  - `<div id="drawerOverlay" class="drawer-overlay hidden">` — backdrop
  - `<nav id="sideDrawer" class="side-drawer">` — slides in from left
    - Home link → `/`
    - Page selector `<select id="drawerPageSelect">`:
      - Home (`/`)
      - Monitor (`/monitor.html`)
      - Base Station (`/base-station.html`)
      - Room Control (`/room-control.html`)
    - Restore last page toggle: `<label>` + toggle switch
- Logic:
  - Hamburger click → opens drawer (adds `.open` class, shows overlay)
  - Overlay click or link click → closes drawer
  - Page selector `onchange` → navigates to selected URL
  - Restore toggle: reads/writes `localStorage.hearthRestoreLastPage`
  - On page load: if restore is on and `localStorage.hearthLastPage` exists,
    redirect to saved page (skip if already on that page)
  - Save current path to `localStorage.hearthLastPage` on every load
  - Auto-select current page in the dropdown

### Files to Modify

**`server/public/css/style.css`**
- Add hamburger button styles (fixed top-left, z-index high, semi-transparent bg)
- Add side drawer styles (fixed left, full height, ~240px width, slide transform,
  dark bg matching `--bg-card`)
- Add drawer overlay styles (semi-transparent backdrop)
- Add drawer item styles (menu items with padding, hover states)

**`server/public/index.html`**
- Add `<script src="/js/topbar.js"></script>` after existing scripts

**`server/public/base-station.html`**
- Add `<script src="/js/topbar.js"></script>` after existing scripts

**`server/public/room-control.html`** (created in Phase 2A)
- Add `<script src="/js/topbar.js"></script>` after existing scripts

### Files NOT Modified
- `monitor.html` — explicitly excluded (fullscreen, no UI chrome)
- `camera.js`, `base-station.js`, `signaling.js`, `webrtc.js` — untouched
- `SignalingServer.kt` — catch-all route already serves new pages
- Android layout XML — no native UI changes

---

## Implementation Order
1. Write plan (this file)
2. Create `room-control.html`
3. Create `room-control.js`
4. Update `index.html` with Room Control card
5. Update `MainActivity.kt` to load index
6. Create `topbar.js` with hamburger menu
7. Add drawer CSS to `style.css`
8. Add `topbar.js` script tag to index, base-station, room-control
9. Verify: hamburger appears on all pages except monitor, drawer opens/closes,
   page selector navigates, restore toggle works, last page redirect works
