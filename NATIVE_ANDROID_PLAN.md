# Plan: Native Self-Contained Hearth-Connect Android App

## Goal
One Android APK that is BOTH:
- the always-on signaling/config/static-file **server** (so iPads/browsers join it), and
- a **native WebRTC peer** (camera/monitor + base-station viewer) using `google-webrtc`.

## Earliest Android version it will work on

| Constraint | Floor |
|---|---|
| `google-webrtc` native (Camera2 capture) | **API 21 (Android 5.0 Lollipop)** |
| 64-bit native lib (arm64-v8a) | API 21+ **64-bit devices** (most 2015+ flagships; Tab S4 is 64-bit) |
| Ktor embedded server (Coroutines/Netty-CIO) | API 21+ fine |
| Foreground service + notification channel | API 26+ needs channels; gracefully handled |
| Play Store publish requirement | `targetSdk 34` (device runs anything >= minSdk) |

**Floor: Android 5.0 (API 21), 64-bit.** Recommended `minSdk = 24` (Nougat) to avoid
pre-Doze/legacy quirks — still covers the recommended target device Tab A7 (API 28+).

## Recommended target device: Samsung Galaxy Tab A7 (SM-T500, 2020)
Chosen for wall-mount, always-plugged use:
- **10.4" LCD** — no OLED burn-in risk (unlike the Tab S4).
- **Samsung "Protect battery" (85% cap)** — native charge limit for 24/7 plugged-in use.
- **64-bit** Snapdragon 662, Android 11, 3GB RAM — meets all requirements; enough for server + 2–3 streams.
- Same used price as the Tab S4, without the S4's OLED burn-in downside.
- Fallback if A7 unavailable: any 64-bit LCD tablet with a charge-limit (e.g. Lenovo Tab M8 TB-8505F — verify its battery-protection in Settings).

### Excluded: 32-bit-only devices
The plan requires an `arm64-v8a` WebRTC build. Tablets that are **32-bit ARM only**
(armeabi-v7a, no 64-bit) will NOT work, e.g.:
- Samsung Galaxy Tab S (2014) SM-T800/T805 — Exynos 5420 (32-bit)
- Samsung Galaxy Tab S2 (2015) Exynos variant SM-T710/T810 (32-bit)
- Samsung Galaxy Tab 4 (2014) — 32-bit SoCs
- Samsung Galaxy Tab 3 / Tab 2 (2013/2012) — 32-bit
- most pre-2016 budget/no-name tablets, older Amazon Fire HD models

Rule of thumb: launched before ~2016 or a budget 32-bit SoC -> excluded.
(If a future `google-webrtc` build still ships armeabi-v7a, some of these could work,
but we exclude them for reliability.)

## Architecture
```
App (one APK, foreground service)
├── Ktor signaling server  (WebSocket + static files + JSON config + TLS)
│     └── serves existing server/public/* to BROWSER peers (iPads, etc.)
├── Native WebRTC module   (google-webrtc: capture, peer conn, render)
│     └── speaks the SAME JSON signaling protocol as webrtc.js
└── Native UI              (base-station / monitor screens)
```
The device is both the hub (server) and a native WebRTC peer. Browser/iOS peers
connect to its URL and use the served HTML/JS unchanged.

## Build steps
1. **Project scaffold** — Android Gradle (Kotlin DSL), `minSdk 24`, `targetSdk 34`, Kotlin + Coroutines.
2. **Embedded server (Ktor CIO)** — port `SignalingHandler.ts` + `ChannelManager.ts` + `ConfigManager.ts` to Kotlin. HTTPS via self-signed cert (bundle or generate at first run; reuse `deploy/gen-cert.sh` logic).
3. **Static assets** — bundle `server/public/*` into `assets/`; Ktor serves them so iPads/browsers still work as peers.
4. **Native WebRTC** — add `org.webrtc:google-webrtc`. Port the protocol from `webrtc.js`: `JOIN_ROOM / OFFER / ANSWER / ICE / SUBSCRIBER_JOINED` etc. Use `Camera2Capturer` + `SurfaceViewRenderer`.
5. **Foreground service** — `startForeground` with persistent notification; `WakeLock`/`WifiLock`; handle Doze (API 23+) and `foregroundServiceType` (API 34).
6. **Config persistence** — JSON file on internal storage (port `ConfigManager`).
7. **Discovery/QR** — expose `/api/server-url` (reuse existing) so iPads scan to join.
8. **Native UI** — base-station grid + monitor broadcast, reusing AGENTS.md press-and-hold flow logic.
9. **Test on Tab A7 (SM-T500)** — verify server reachable on LAN, native camera publishes, browser peer subscribes.
10. **Publish** — Play console $25, declare `FOREGROUND_SERVICE`, justify always-on server.

## Wall-mount deployment (target use case)
Device is stuck on a wall, always plugged in, screen sleeps to avoid burn-in, server keeps running.

1. **Protect battery (charge limit):** enable Samsung "Protect battery" (caps at 85%) in Settings → Battery. If unavailable on the device, use a **smart plug + automation** (toggle power at 80%/40% via a small battery-% check) or root + ACC.
2. **Avoid burn-in:** Tab A7 is LCD (no OLED burn-in). Let the display time out / force it off on idle; rely on screen-off + wake (below).
3. **Screen OFF but server alive:** hold `PARTIAL_WAKE_LOCK` + `WifiLock` in the foreground service so CPU + network keep running with the display asleep. Foreground service is not killed by Doze while plugged in.
 4. **Wake straight back into the app (no re-launch):** disable the lock screen, or use **Screen Pinning / lock-task mode (kiosk)**, or set the app as the **default launcher**. A `SCREEN_ON` receiver calls `moveTaskToFront()` / `FLAG_TURN_SCREEN_ON`; app state lives in the service, so no re-init.
 5. **Kiosk setup:** first-run guides the user to enable screen pinning / set as home app, enable Protect battery, and disable auto-revoke (below).
 6. **Event-driven wake (camera/audio change):** Because the foreground service holds a `PARTIAL_WAKE_LOCK` with `camera|microphone` foreground types, the camera and mic keep streaming with the **screen off** on Android 11–12 (this is clamped to while-in-use on Android 14+, which is why we stay on the API 30–31 target). So a change can be detected on-device and then the **display** turned on. Detection runs in the service — CameraX `ImageAnalysis` (frame-diff / average-luma) for motion, and mic RMS/peak for audio. To light the screen when a change is seen, either acquire a wake lock with `ACQUIRE_CAUSES_WAKEUP | SCREEN_BRIGHT_WAKE_LOCK`, or bring `MainActivity` forward with `setShowWhenLocked(true)` + `setTurnScreenOn(true)` (+ optional `requestDismissKeyguard`). NOTE: this only wakes the *display*; true CPU-down sleep cannot self-detect camera/audio changes — that needs an external trigger (e.g. FCM high-priority push from another device).
 7. **Scheduled screen-off / dynamic on-off periods:** Optionally let the user define a recurring schedule where the **display is forced off (or the whole kiosk is muted/quiet) during certain windows** — e.g. "always off at night" 22:00–07:00 — independent of the idle timeout. Event-driven wake (6) can stay suppressed during these windows so the screen stays dark until the schedule ends. Implement as a periodic `WorkManager`/`AlarmManager` check in the service that toggles a `screenOffUntil` timestamp; the wake path consults it before turning the display on. Keeps the server + camera/mic alive the whole time (still `PARTIAL_WAKE_LOCK`), only the panel is dark.

## Android 11 permission handling (Tab A7 ships Android 11)
1. **Auto-revoke:** Android 11 revokes camera/mic permissions after ~3 months of no launch — would silently kill an always-running wall cam. On first run, launch `Intent.ACTION_AUTO_REVOKE_PERMISSIONS` and guide the user to disable "auto-revoke", or use the whitelist API.
2. **One-time permissions:** request FULL camera/mic (not "only this time"); re-prompt if missing. Don't assume always-allowed.
3. **Foreground service type:** declare `foregroundServiceType="mediaPlayback"` on API 30; when targeting 34 use `camera`/`microphone` types.
4. **Scoped storage:** store JSON config in app-internal storage (`getFilesDir()`); bundle static assets in `assets/`. Avoid `Environment.getExternalStorage…`.

## Risks
- **LAN reachability** for remote peers -> needs HTTPS (self-signed) or tunnel.
- **Doze/killers** -> foreground service mandatory; document "keep plugged in."
- **WebRTC build ABI** -> confirm `google-webrtc` ships arm64-v8a (it does).
- **Silent permission loss** -> must disable auto-revoke or the wall cam dies after months.
