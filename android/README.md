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

Quick rebuild + deploy (from `android/` dir):
```bash
./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
```

> Note: `gradlew` needs its wrapper jar. Android Studio generates it on first open,
> or run `gradle wrapper` once you have Gradle installed.

## Rotation handling

`AndroidManifest.xml` declares `android:configChanges="orientation|screenSize|screenLayout|smallestScreenSize|keyboard|keyboardHidden"` on `MainActivity`. This tells Android to **not** destroy and recreate the Activity on rotation — the WebView, signaling connection, and WebRTC session stay alive. Without it, every rotation would kill the page and force a full reconnect.

## Connect the Tab A7 for testing
- Enable **Developer options → USB debugging** (tap Build number 7×).
- USB: `adb devices` then install.
- Or WiFi: `adb tcpip 5555` then `adb connect <tab-ip>:5555`.

## Local emulator testing (no tablet needed)
Useful for quick iteration when the Tab A7 isn't plugged in. Pick the image that
matches your **host** CPU:
- x86_64 Linux host → `system-images;android-34;default;x86_64` (needs KVM)
- ARM host (Apple Silicon / ARM Linux) → `system-images;android-34;default;arm64-v8a`

```bash
# 1. install emulator binary + image (host arch below is x86_64; swap for arm64-v8a on ARM)
sdkmanager "emulator" "system-images;android-34;default;x86_64" "platforms;android-34" "build-tools;34.0.0"
sdkmanager --licenses

# 2. enable KVM on Linux (required for usable speed); log out/in after
sudo apt install qemu-kvm
sudo usermod -aG kvm $USER

# 3. create + launch an AVD
avdmanager create avd -n test34 -k "system-images;android-34;default;x86_64"
emulator -avd test34 &

# 4. build + install into the emulator (same as a device)
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.hearthconnect/.MainActivity
```
Notes:
- Native `google-webrtc` ships an `x86_64` lib, so WebRTC loads in the emulator;
  the camera is **virtual** (fake feed) — good for code paths, not real video.
- The app also runs unchanged on **Android 12 (API 31)**; our `PendingIntent` is
  already `FLAG_IMMUTABLE` and FGS types cover it.

## adb cheat-sheet
```bash
adb devices                     # list connected devices / emulators
adb tcpip 5555                  # switch a USB device to WiFi-adb (do once over USB)
adb connect 192.168.x.x:5555    # connect over WiFi (Tab A7 LAN IP)
adb forward tcp:8090 tcp:8090   # host:8090 -> device/emulator :8090 (reach the hub server)
adb reverse tcp:8090 tcp:8090   # device -> host (if the device needs to hit a host server)
adb install -r app-debug.apk    # (re)install
adb shell am start -n com.hearthconnect/.MainActivity
adb logcat | grep HearthConnect   # watch app logs
adb logcat -s chromium            # watch WebView/Chromium logs (JS console, errors)
adb logcat -s HearthMain          # activity lifecycle, WebView setup, SSL errors
adb logcat -s HearthSignaling     # Ktor server, WS connections, message routing, device joins
```
After `adb forward tcp:8090 tcp:8090`, open `http://localhost:8090` in a browser
on the host to hit the embedded signaling server.

## Next steps (not yet implemented)
- Port room/device logic from `server/src/SignalingHandler.ts` into `SignalingServer`.
- Camera capture (`Camera2Capturer`) + `SurfaceViewRenderer` in `WebRTCManager`.
- JSON config persistence (port `ConfigManager.ts`) in app-internal storage.
- HTTPS self-signed cert for the Ktor server (reuse `docker/gen-cert.sh`).
- Wall-mount: enable Samsung "Protect battery", kiosk/screen-pin, disable auto-revoke.
