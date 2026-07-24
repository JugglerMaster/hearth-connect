package com.hearthconnect

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import java.net.NetworkInterface

/**
 * Publishes a _hearth-connect._tcp mDNS service so Pi agents on the same LAN
 * can discover the server automatically without a manual SERVER_URL.
 *
 * Mirrors the Node.js server's publishMdns() (bonjour library) — the TXT
 * record carries `serverUrl` which the Pi agent's mdns_discover.py reads.
 */
class MdnsPublisher(private val context: Context) {
    private var nsdManager: NsdManager? = null
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var registered = false

    fun register(port: Int) {
        if (registered) return
        val ip = lanIp() ?: run {
            Log.w(TAG, "mDNS: no LAN IP found — skipping registration")
            return
        }

        val serverUrl = "wss://$ip:$port"
        Log.i(TAG, "mDNS: registering _hearth-connect._tcp — $serverUrl")

        val serviceInfo = NsdServiceInfo().apply {
            serviceName = SERVICE_NAME
            serviceType = SERVICE_TYPE
            this.port = port
            // TXT records — API 21+ String overload
            setAttribute("serverUrl", serverUrl)
            setAttribute("roomId", "default")
            setAttribute("label", SERVICE_NAME)
        }

        registrationListener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                // Android may rename the service if the name collides.
                Log.i(TAG, "mDNS: registered as '${info.serviceName}'")
                registered = true
            }

            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS: registration failed (errorCode=$errorCode)")
            }

            override fun onServiceUnregistered(info: NsdServiceInfo) {
                Log.i(TAG, "mDNS: unregistered")
                registered = false
            }

            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.w(TAG, "mDNS: unregistration failed (errorCode=$errorCode)")
            }
        }

        try {
            nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
            nsdManager?.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener)
        } catch (e: Exception) {
            Log.w(TAG, "mDNS: register failed: ${e.message}")
        }
    }

    fun unregister() {
        if (!registered) return
        try {
            registrationListener?.let { nsdManager?.unregisterService(it) }
        } catch (e: Exception) {
            Log.w(TAG, "mDNS: unregister failed: ${e.message}")
        }
        registrationListener = null
        registered = false
    }

    private fun lanIp(): String? {
        return try {
            NetworkInterface.getNetworkInterfaces().toList()
                .flatMap { it.inetAddresses.toList() }
                .firstOrNull { !it.isLoopbackAddress && it.address.size == 4 }
                ?.hostAddress
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        private const val TAG = "HearthMdns"
        private const val SERVICE_NAME = "Hearth-Connect"
        private const val SERVICE_TYPE = "_hearth-connect._tcp."
    }
}
