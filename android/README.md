# Hearth-Connect — Native Android App

Self-contained Android hub: an embedded Ktor signaling server + native `google-webrtc`
peer, packaged as one APK. Target device: **Samsung Galaxy Tab A7 (SM-T500), Android 11**.

## What's scaffolded (steps 1-4)
- Gradle (Kotlin DSL) + Android manifest with foreground-service + camera/mic perms.
- `MainActivity` → launches `HubService`.
- `HubService` → always-on foreground service; holds wake + wifi locks; starts the
  signaling server and WebRTC manager.
- `SignalingServer` (Ktor CIO) → `/ws` signaling relay + static files from
  `assets/public` + `/api/server-url`.
- `WebRTCManager` → initializes native libwebrtc PeerConnectionFactory (UNIFIED_PLAN).

## Build prerequisites (on your Linux machine — not the sandbox)
1. **JDK 17**
2. **Android SDK** (platform-34 + build-tools). Easiest: install **Android Studio**
   (free; bundles JDK + SDK + emulator + `adb`). Or use `cmdline-tools` + `sdkmanager`.
3. Accept licenses: `sdkmanager --licenses`.

## Build & run
Open this `android/` folder in Android Studio and click Run, or from CLI:

```bash
cd android
./gradlew assembleDebug        # generates app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.hearthconnect/.MainActivity
```

> Note: `gradlew` needs its wrapper jar. Android Studio generates it on first open,
> or run `gradle wrapper` once you have Gradle installed.

## Connect the Tab A7 for testing
- Enable **Developer options → USB debugging** (tap Build number 7×).
- USB: `adb devices` then install.
- Or WiFi: `adb tcpip 5555` then `adb connect <tab-ip>:5555`.

## Next steps (not yet implemented)
- Port room/device logic from `server/src/SignalingHandler.ts` into `SignalingServer`.
- Camera capture (`Camera2Capturer`) + `SurfaceViewRenderer` in `WebRTCManager`.
- JSON config persistence (port `ConfigManager.ts`) in app-internal storage.
- HTTPS self-signed cert for the Ktor server (reuse `deploy/gen-cert.sh`).
- Wall-mount: enable Samsung "Protect battery", kiosk/screen-pin, disable auto-revoke.
