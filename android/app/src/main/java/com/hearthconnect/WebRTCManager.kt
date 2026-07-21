package com.hearthconnect

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory

/**
 * Thin wrapper around google-webrtc (native libwebrtc). Initializes the global
 * PeerConnectionFactory once and exposes helpers to create peer connections.
 *
 * Stub for steps 1-4: factory + a createPeerConnection() that uses UNIFIED_PLAN
 * (required for interop with modern iOS Safari / Chrome peers). Actual camera
 * capture + SurfaceViewRenderer wiring lands in the next steps.
 */
class WebRTCManager(context: Context) {
    private val eglBase: EglBase = EglBase.create()
    private val factory: PeerConnectionFactory

    init {
        val initOptions = PeerConnectionFactory.InitializationOptions.builder(context)
            .setEnableInternalTracer(true)
            .createInitializationOptions()
        PeerConnectionFactory.initialize(initOptions)

        factory = PeerConnectionFactory.builder()
            .setOptions(PeerConnectionFactory.Options())
            .setVideoEncoderFactory(
                DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true)
            )
            .setVideoDecoderFactory(
                DefaultVideoDecoderFactory(eglBase.eglBaseContext)
            )
            .createPeerConnectionFactory()
    }

    /** Create a UNIFIED_PLAN peer connection. Caller supplies the observer. */
    fun createPeerConnection(observer: PeerConnection.Observer): PeerConnection? {
        val config = PeerConnection.RTCConfiguration(emptyList())
        config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        return factory.createPeerConnection(config, observer)
    }

    fun eglContext() = eglBase.eglBaseContext

    fun dispose() {
        factory.dispose()
        eglBase.release()
    }
}
