./gradlew clean assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
sleep 5
adb shell am start -n com.hearthconnect/.MainActivity
