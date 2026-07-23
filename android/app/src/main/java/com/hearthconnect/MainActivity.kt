package com.hearthconnect

import android.Manifest
import android.annotation.SuppressLint
import android.net.http.SslError
import android.os.Build
import android.util.Log
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.hearthconnect.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    companion object {
        private const val TAG = "HearthMain"
        const val ACTION_WAKE_ON_EVENT = "com.hearthconnect.WAKE_ON_EVENT"
        const val EXTRA_WAKE_REASON = "wake_reason"
        init {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }

    private val handler = Handler(Looper.getMainLooper())

    private val requiredPermissions = arrayOf(
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO
    )

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val allGranted = grants.values.all { it }
        if (allGranted) {
            loadBaseStation()
        } else {
            binding.statusText.text = "Camera & mic permissions required.\nGrant them in Settings."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Allow this activity to show over the lock screen (no password set)
        // so HubService can bring us to front on audio/motion events.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }

        val intent = Intent(this, HubService::class.java)
        ContextCompat.startForegroundService(this, intent)

        setupWebView()

        if (hasAllPermissions()) {
            loadBaseStation()
        } else {
            permissionLauncher.launch(requiredPermissions)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        binding.webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(false)
            builtInZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
        }

        binding.webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                return false
            }

            override fun onReceivedSslError(view: WebView?, handler: android.webkit.SslErrorHandler?, error: SslError?) {
                val url = view?.url ?: "null"
                Log.w(TAG, "onReceivedSslError: url=$url error=${error?.primaryError}")
                handler?.proceed()
            }
        }

        binding.webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                runOnUiThread {
                    request?.grant(request.resources)
                }
            }
        }

        binding.webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
    }

    private fun loadBaseStation() {
        binding.statusText.visibility = View.GONE
        binding.webView.visibility = View.VISIBLE
        // Delay load to give the embedded server time to bind the port.
        handler.postDelayed({
            binding.webView.loadUrl("https://127.0.0.1:${HubService.PORT}/base-station.html")
        }, 2000)
    }

    private fun hasAllPermissions(): Boolean = requiredPermissions.all {
        ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent?.action == ACTION_WAKE_ON_EVENT) {
            Log.i(TAG, "Woken by event: ${intent.getStringExtra(EXTRA_WAKE_REASON) ?: "unknown"}")
        }
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
