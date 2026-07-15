package com.hearthconnect

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.hearthconnect.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // On a wall-mounted hub the activity may be recreated; the service is the source of truth.
        binding.statusText.text = "Starting Hearth-Connect hub…"

        // Launch the always-on foreground hub (signaling server + WebRTC manager).
        val intent = Intent(this, HubService::class.java)
        ContextCompat.startForegroundService(this, intent)

        binding.statusText.text = "Hub running — signaling server on :8090"
    }

    // Do NOT stop the service when the activity is destroyed; the hub must outlive the UI
    // (screen off / kiosk). The user stops it explicitly or by uninstalling.
}
