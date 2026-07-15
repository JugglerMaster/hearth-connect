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
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Always-on foreground service: hosts the Ktor signaling server and the native
 * WebRTC manager. Held alive with a partial wake lock + wifi lock so the server
 * keeps running while the display is asleep (wall-mount use case).
 */
class HubService : Service() {
    private lateinit var server: SignalingServer
    private lateinit var webrtc: WebRTCManager
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        acquireLocks()

        webrtc = WebRTCManager(this)
        server = SignalingServer(this)
        server.start(PORT)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Restart if killed by the system.
        return START_STICKY
    }

    private fun acquireLocks() {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "HearthConnect::Hub").apply {
            setReferenceCounted(false)
            acquire() // held indefinitely; refresh/rate-limit as needed for production
        }
        val wm = getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("MissingPermission")
        wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "HearthConnect::Wifi").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

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

    override fun onDestroy() {
        server.stop()
        webrtc.dispose()
        wakeLock?.release()
        wifiLock?.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val NOTIF_ID = 1
        const val PORT = 8090
    }
}
