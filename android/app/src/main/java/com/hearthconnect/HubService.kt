package com.hearthconnect

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlin.math.sqrt

/**
 * Always-on foreground service: hosts the Ktor signaling server.
 * Held alive with a partial wake lock + wifi lock so the server keeps running
 * while the display is asleep.
 *
 * Also runs a native AudioMonitor when the screen is off: if the mic picks up
 * sound above a threshold, it wakes the display and brings MainActivity to front.
 */
class HubService : Service(), SignalingServer.ServerEventListener {
    private lateinit var server: SignalingServer
    private var mdnsPublisher: MdnsPublisher? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var audioMonitor: AudioMonitor? = null
    private val handler = Handler(Looper.getMainLooper())
    private var screenOn = true
    private var lastWakeTime = 0L

    // ─── Audio monitor config ──────────────────────────────
    private val audioThresholdDb = -40f      // dB RMS to trigger wake
    private val wakeCooldownMs = 10_000L     // minimum ms between wakes
    private val sampleRate = 8000            // Hz — low power, sufficient for level detection

    // ─── Screen state broadcast receiver ───────────────────
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    screenOn = false
                    startAudioMonitor()
                }
                Intent.ACTION_SCREEN_ON -> {
                    screenOn = true
                    stopAudioMonitor()
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        acquireLocks()

        server = SignalingServer(this, this)
        server.start(PORT)

        // Publish mDNS service so Pi agents on the LAN can discover the server.
        mdnsPublisher = MdnsPublisher(this).also { it.register(PORT) }

        // Listen for screen on/off to toggle native audio monitoring.
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }
        registerReceiver(screenReceiver, filter)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        stopAudioMonitor()
        try { unregisterReceiver(screenReceiver) } catch (_: Exception) {}
        mdnsPublisher?.unregister()
        server.stop()
        wakeLock?.release()
        wifiLock?.release()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ─── ServerEventListener ───────────────────────────────
    override fun onDoorbell(fromDeviceId: String, label: String) {
        Log.i(TAG, "Doorbell from $fromDeviceId ($label) — waking screen")
        wakeScreen("doorbell")
    }

    override fun onAudioPeak(fromDeviceId: String, levelDb: Double) {
        // Native AudioMonitor handles wake when screen is off.
        // This callback is for peaks reported by the WebView JS path (if active).
        if (!screenOn && levelDb > audioThresholdDb) {
            wakeScreen("audio")
        }
    }

    // ─── Audio monitor (native mic) ────────────────────────
    private fun startAudioMonitor() {
        if (audioMonitor != null) return
        try {
            audioMonitor = AudioMonitor(sampleRate, audioThresholdDb) { reason ->
                handler.post { wakeScreen(reason) }
            }
            audioMonitor?.start()
            Log.i(TAG, "AudioMonitor started (threshold=${audioThresholdDb}dB)")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start AudioMonitor: ${e.message}")
            audioMonitor = null
        }
    }

    private fun stopAudioMonitor() {
        audioMonitor?.stop()
        audioMonitor = null
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

    // ─── Inner class: AudioMonitor ─────────────────────────
    /**
     * Monitors mic input via AudioRecord in a background thread.
     * When RMS exceeds [thresholdDb], calls [onPeak] with the reason string.
     * Runs until [stop] is called.
     */
    private class AudioMonitor(
        private val sampleRate: Int,
        private val thresholdDb: Float,
        private val onPeak: (String) -> Unit
    ) {
        @Volatile private var running = false
        private var thread: Thread? = null

        fun start() {
            if (running) return
            running = true
            thread = Thread({
                monitorLoop()
            }, "AudioMonitor").also { it.start() }
        }

        fun stop() {
            running = false
            thread?.join(2000)
            thread = null
        }

        private fun monitorLoop() {
            val channelConfig = AudioFormat.CHANNEL_IN_MONO
            val audioFormat = AudioFormat.ENCODING_PCM_16BIT
            val bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
            if (bufferSize == AudioRecord.ERROR_BAD_VALUE || bufferSize == AudioRecord.ERROR) {
                Log.w(TAG, "AudioMonitor: invalid buffer size $bufferSize")
                return
            }

            val record = try {
                AudioRecord(
                    MediaRecorder.AudioSource.CAMCORDER,
                    sampleRate,
                    channelConfig,
                    audioFormat,
                    bufferSize * 2
                )
            } catch (e: SecurityException) {
                Log.w(TAG, "AudioMonitor: mic permission denied")
                return
            }

            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.w(TAG, "AudioMonitor: AudioRecord failed to initialize")
                record.release()
                return
            }

            try {
                record.startRecording()
                val buffer = ShortArray(bufferSize / 2)

                while (running) {
                    val read = record.read(buffer, 0, buffer.size)
                    if (read <= 0) continue

                    // Compute RMS of PCM 16-bit samples.
                    var sumSq = 0.0
                    for (i in 0 until read) {
                        val sample = buffer[i].toDouble()
                        sumSq += sample * sample
                    }
                    val rms = sqrt(sumSq / read)
                    // Convert to dBFS (0 dBFS = max amplitude 32767).
                    val db = if (rms > 0) (20 * Math.log10(rms / 32767.0)).toFloat() else -100f

                    if (db > thresholdDb) {
                        Log.d(TAG, "AudioMonitor: peak ${"%.1f".format(db)}dB > ${thresholdDb}dB")
                        onPeak("audio")
                        // Sleep a bit to avoid rapid-fire peaks during sustained sound.
                        Thread.sleep(3000)
                    }
                }
            } catch (e: InterruptedException) {
                // Normal shutdown.
            } catch (e: Exception) {
                Log.w(TAG, "AudioMonitor error: ${e.message}")
            } finally {
                try {
                    record.stop()
                } catch (_: Exception) {}
                record.release()
            }
        }
    }

    companion object {
        private const val TAG = "HearthHub"
        const val NOTIF_ID = 1
        const val PORT = 8090
    }
}
