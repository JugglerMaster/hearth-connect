package com.hearthconnect

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Always-on foreground service: hosts the Ktor signaling server.
 * Held alive with a partial wake lock + wifi lock so the server keeps running
 * while the display is asleep.
 *
 * Screen wake on doorbell is gated by the keepAwake preference.
 */
class HubService : Service(), SignalingServer.ServerEventListener {
    private lateinit var server: SignalingServer
    private var mdnsPublisher: MdnsPublisher? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private var lastWakeTime = 0L
    private val wakeCooldownMs = 10_000L     // minimum ms between wakes

    // ─── Keep Awake preference ────────────────────────────
    private val prefs by lazy { getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }
    var keepAwake: Boolean
        get() = prefs.getBoolean(KEY_KEEP_AWAKE, true)
        set(value) {
            prefs.edit().putBoolean(KEY_KEEP_AWAKE, value).apply()
            Log.i(TAG, "keepAwake = $value")
        }

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        acquireLocks()

        server = SignalingServer(this, this)
        server.start(PORT)

        // Publish mDNS service so Pi agents on the LAN can discover the server.
        mdnsPublisher = MdnsPublisher(this).also { it.register(PORT) }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        mdnsPublisher?.unregister()
        server.stop()
        wakeLock?.release()
        wifiLock?.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ─── ServerEventListener ───────────────────────────────
    override fun onDoorbell(fromDeviceId: String, label: String) {
        if (!keepAwake) {
            Log.i(TAG, "Doorbell from $fromDeviceId ($label) — skipped (keepAwake off)")
            return
        }
        Log.i(TAG, "Doorbell from $fromDeviceId ($label) — waking screen")
        wakeScreen("doorbell")
    }

    // ─── Screen wake ───────────────────────────────────────
    private fun wakeScreen(reason: String) {
        val now = System.currentTimeMillis()
        if (now - lastWakeTime < wakeCooldownMs) {
            Log.d(TAG, "Wake suppressed (cooldown): reason=$reason")
            return
        }
        lastWakeTime = now
        Log.i(TAG, "Waking screen: reason=$reason")

        // Method 1: Launch MainActivity over the lock screen.
        val wakeIntent = Intent(this, MainActivity::class.java).apply {
            action = MainActivity.ACTION_WAKE_ON_EVENT
            putExtra(MainActivity.EXTRA_WAKE_REASON, reason)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        startActivity(wakeIntent)

        // Method 2: Use a wake lock with ACQUIRE_CAUSES_WAKEUP (belt + suspenders).
        try {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            val screenLock = pm.newWakeLock(
                PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.SCREEN_BRIGHT_WAKE_LOCK,
                "HearthConnect::ScreenWake"
            )
            screenLock.acquire(5_000) // 5 second timeout — just enough to light the display
            screenLock.release()
        } catch (e: Exception) {
            Log.w(TAG, "Wake lock failed: ${e.message}")
        }
    }

    // ─── Locks ─────────────────────────────────────────────
    private fun acquireLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HearthConnect::Hub").apply {
            setReferenceCounted(false)
            acquire()
        }
        val wm = getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("MissingPermission")
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "HearthConnect::Wifi").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    // ─── Notification ──────────────────────────────────────
    private fun buildNotification(): Notification {
        val channelId = "hub_foreground"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val chan = NotificationChannel(
                channelId,
                "Hearth-Connect Hub",
                NotificationManager.IMPORTANCE_LOW
            )
            getSystemService(NotificationManager::class.java).createNotificationChannel(chan)
        }
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, channelId)
            .setContentTitle("Hearth-Connect Hub")
            .setContentText("Signaling server running on :$PORT")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        private const val TAG = "HearthHub"
        const val NOTIF_ID = 1
        const val PORT = 8090
        private const val PREFS_NAME = "hearth_hub"
        private const val KEY_KEEP_AWAKE = "keepAwake"
    }
}
