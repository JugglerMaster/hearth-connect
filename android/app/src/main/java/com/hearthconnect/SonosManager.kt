package com.hearthconnect

import android.content.Context
import android.util.Log
import org.w3c.dom.Element
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.concurrent.thread

/**
 * Plan 19 — network speakers / Sonos on the Android hub.
 *
 * This is the explicit exception to the "server is a matchmaker only — no media
 * passes through it" rule (AGENTS.md). Rationale: recorded announcements
 * (PLAY_CLIP, plan 18) are a transient WAV file, not a live WebRTC stream, and
 * the hub (a) already holds the clip bytes, (b) is always-on, and (c) sits on
 * the same LAN as the speakers. So the hub discovers UPnP/Sonos renderers via
 * SSDP and pushes recorded announcements to them directly, re-hosting the WAV
 * over plain HTTP (Sonos rejects the self-signed cert and cannot play
 * WebRTC/Opus). Live WebRTC (FaceTalk / talkback) still never touches the hub.
 */
object SonosManager {
    private const val TAG = "HearthSonos"
    private const val SSDP_ADDR = "239.255.255.250"
    private const val SSDP_PORT = 1900
    private const val SONOS_URN = "urn:schemas-upnp-org:device:ZonePlayer:1"
    private const val AVTRANSPORT_NS = "urn:schemas-upnp-org:service:AVTransport:1"
    private const val RENDERING_CONTROL_NS = "urn:schemas-upnp-org:service:RenderingControl:1"

    data class SonosSpeaker(
        val id: String,            // sonos://<ip>:<port>
        val label: String,
        val ip: String,
        val controlUrl: String,    // absolute AVTransport control URL
        val rcControlUrl: String   // absolute RenderingControl control URL (volume)
    )

    @Volatile var speakers: List<SonosSpeaker> = emptyList()
        private set

    // Invoked (only when the discovered set changes) so the hub can publish
    // Sonos as first-class room devices without polling.
    var onUpdate: ((List<SonosSpeaker>) -> Unit)? = null

    private var lastIds: Set<String> = emptySet()
    private var running = false

    // A speaker stays "present" for this long after its last successful SSDP
    // response. Sonos devices occasionally miss a single 2.5s discovery window
    // (UDP drop, slow description fetch, late response). Without this grace
    // period a healthy speaker would flap to offline every ~30s; it only counts
    // as gone after PRESENT_GRACE_MS of silence (~3 missed windows).
    private const val PRESENT_GRACE_MS = 90_000L
    private val knownSpeakers = LinkedHashMap<String, SonosSpeaker>()
    private val lastSeenAt = HashMap<String, Long>()

    fun startDiscovery(intervalMs: Long = 30_000) {
        if (running) return
        running = true
        thread(isDaemon = true, name = "sonos-discovery") {
            while (running) {
                try {
                    discoverOnce()
                } catch (e: Exception) {
                    Log.w(TAG, "discovery error: ${e.message}")
                }
                try {
                    Thread.sleep(intervalMs)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }
        Log.i(TAG, "Sonos discovery started")
    }

    fun stop() {
        running = false
        Log.i(TAG, "Sonos discovery stopped")
    }

    fun speakerById(id: String): SonosSpeaker? = speakers.firstOrNull { it.id == id }

    private fun discoverOnce() {
        val found = LinkedHashMap<String, SonosSpeaker>()
        try {
            val sock = DatagramSocket()
            sock.soTimeout = 2000
            val msg = ("M-SEARCH * HTTP/1.1\r\n" +
                    "HOST: $SSDP_ADDR:$SSDP_PORT\r\n" +
                    "MAN: \"ssdp:discover\"\r\n" +
                    "MX: 2\r\n" +
                    "ST: ssdp:all\r\n\r\n").toByteArray(Charsets.UTF_8)
            sock.send(DatagramPacket(msg, msg.size, InetAddress.getByName(SSDP_ADDR), SSDP_PORT))
            val end = System.currentTimeMillis() + 2500
            val buf = ByteArray(4096)
            while (System.currentTimeMillis() < end) {
                try {
                    val p = DatagramPacket(buf, buf.size)
                    sock.receive(p)
                    val text = String(p.data, 0, p.length, Charsets.UTF_8)
                    val headers = parseSsdp(text)
                    val usn = headers["USN"] ?: ""
                    val location = headers["LOCATION"] ?: ""
                    if (SONOS_URN !in usn) continue
                    if (location.isEmpty()) continue
                    val key = usn.substringBefore("::").ifEmpty { location }
                    if (!found.containsKey(key)) {
                        fetchDescription(location)?.let { found[key] = it }
                    }
                } catch (_: Exception) {
                    // socket timeout or parse issue — keep going until deadline
                }
            }
            sock.close()
        } catch (e: Exception) {
            Log.w(TAG, "SSDP send error: ${e.message}")
        }
        // Merge this round's findings into the retained set. Speakers that were
        // not rediscovered this round stay "present" until PRESENT_GRACE_MS
        // elapses without any SSDP response, so a single missed window (UDP
        // loss, late response) does not mark a healthy speaker offline.
        val now = System.currentTimeMillis()
        for ((key, sp) in found) {
            knownSpeakers[key] = sp
            lastSeenAt[key] = now
        }
        knownSpeakers.keys.removeAll { key ->
            (now - (lastSeenAt[key] ?: 0)) > PRESENT_GRACE_MS
        }
        speakers = knownSpeakers.values.toList()
        if (speakers.isNotEmpty()) {
            Log.i(TAG, "discovered ${speakers.size} Sonos: ${speakers.joinToString { it.label }}")
        }
        val ids = speakers.map { it.id }.toSet()
        if (ids != lastIds) {
            lastIds = ids
            onUpdate?.invoke(speakers)
        }
    }

    private fun parseSsdp(text: String): Map<String, String> {
        val headers = LinkedHashMap<String, String>()
        for (line in text.split("\r\n", "\n")) {
            val idx = line.indexOf(':')
            if (idx > 0) {
                val k = line.substring(0, idx).trim().uppercase()
                if (k !in headers) headers[k] = line.substring(idx + 1).trim()
            }
        }
        return headers
    }

    private fun fetchDescription(location: String): SonosSpeaker? {
        return try {
            val db = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            val doc = db.parse(location)
            val root = doc.documentElement
            // Prefer the user-configured room name (set in the Sonos app) over
            // the device's friendlyName, which on some firmware is just the
            // model/UDN string. Fall back to friendlyName if roomName is absent.
            val friendly = firstText(root, "roomName") ?: firstText(root, "friendlyName")
            var controlUrl: String? = null
            var rcControlUrl: String? = null
            val services = doc.getElementsByTagName("service")
            for (i in 0 until services.length) {
                val svc = services.item(i) as Element
                val type = firstText(svc, "serviceType")
                val ctrl = firstText(svc, "controlURL")
                if (ctrl == null) continue
                val abs = if (ctrl.startsWith("http")) ctrl else resolveUrl(location, ctrl)
                when (type) {
                    AVTRANSPORT_NS -> controlUrl = abs
                    RENDERING_CONTROL_NS -> rcControlUrl = abs
                }
            }
            if (friendly == null) return null
            val netloc = location.substringAfter("://").substringBefore("/")
                SonosSpeaker(
                id = "sonos://$netloc",
                label = cleanLabel(friendly),
                ip = netloc.substringBefore(":"),
                controlUrl = controlUrl ?: "http://$netloc/MediaRenderer/AVTransport/Control",
                rcControlUrl = rcControlUrl ?: "http://$netloc/MediaRenderer/RenderingControl/Control"
            )
        } catch (e: Exception) {
            Log.w(TAG, "device description fetch failed for $location: ${e.message}")
            null
        }
    }

    private fun firstText(el: Element, tag: String): String? {
        val nodes = el.getElementsByTagName(tag)
        if (nodes.length == 0) return null
        val child = nodes.item(0).firstChild ?: return null
        return child.textContent?.trim()?.ifEmpty { null }
    }

    private fun resolveUrl(base: String, rel: String): String {
        if (rel.startsWith("/")) {
            val u = URL(base)
            return "${u.protocol}://${u.authority}$rel"
        }
        return "$base/$rel"
    }

    /** Re-host the clip over plain HTTP on the LAN and push it to the speaker
     *  via UPnP AVTransport (Sonos rejects the self-signed cert and cannot play
     *  WebRTC/Opus). Fire-and-forget: playback isn't awaited. */
    fun playClipOnSpeaker(
        context: Context,
        speaker: SonosSpeaker,
        clipBytes: ByteArray,
        volume: Double,
        durationMs: Int
    ) {
        val tmp = java.io.File(
            context.cacheDir,
            "hearth-sonos-${System.currentTimeMillis()}-${(0..9999).random()}.wav"
        )
        try {
            tmp.writeBytes(clipBytes)
        } catch (e: Exception) {
            Log.e(TAG, "failed to write clip temp file: ${e.message}")
            return
        }
        val server = try {
            ServerSocket(0, 0, InetAddress.getByName("0.0.0.0"))
        } catch (e: Exception) {
            Log.e(TAG, "could not start clip HTTP server: ${e.message}")
            tmp.delete()
            return
        }
        val clipUrl = "http://${lanIp()}:${server.localPort}/clip.wav"
        thread(isDaemon = true) {
            val deadline = System.currentTimeMillis() + maxOf(8000L, durationMs + 15000L)
            try {
                while (System.currentTimeMillis() < deadline) {
                    val sock = server.accept()
                    try {
                        val `in` = BufferedReader(InputStreamReader(sock.getInputStream()))
                        `in`.readLine() // request line
                        while (`in`.readLine().isNotEmpty()) { } // consume headers
                        val body = tmp.readBytes()
                        val out = sock.getOutputStream()
                        out.write(
                            ("HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\n" +
                                    "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n").toByteArray()
                        )
                        out.write(body)
                        out.flush()
                    } catch (_: Exception) {
                    } finally {
                        try { sock.close() } catch (_: Exception) { }
                    }
                }
            } catch (_: Exception) {
            } finally {
                try { server.close() } catch (_: Exception) { }
            }
        }
        try {
            // Set volume BEFORE binding the AVTransport URI — some Sonos
            // firmware rejects RenderingControl SetVolume (UPnP 402) when an
            // AVTransport URI is already set on the queue.
            upnpPost(speaker.rcControlUrl, setVolumeXml(volume), "SetVolume", RENDERING_CONTROL_NS)
            upnpPost(speaker.controlUrl, setAvTransportUriXml(clipUrl), "SetAVTransportURI", AVTRANSPORT_NS)
            upnpPost(speaker.controlUrl, playXml(), "Play", AVTRANSPORT_NS)
            Log.i(TAG, "PLAY_CLIP sent to Sonos ${speaker.label} ($clipUrl)")
            Thread.sleep(maxOf(8000L, durationMs + 15000L))
        } catch (e: Exception) {
            Log.e(TAG, "UPnP push to ${speaker.label} failed: ${e.message}")
        } finally {
            try { server.close() } catch (_: Exception) { }
            tmp.delete()
        }
    }

    // Some Sonos firmware reports a friendlyName like
    // "192.168.1.7 - Sonos One - RINCON_XXXX" (IP prefix + UDN suffix). Trim
    // those so the UI shows just the human name ("Sonos One").
    private fun cleanLabel(raw: String): String {
        var n = raw.trim()
        n = n.replace(Regex("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?\\s*-\\s*"), "")
        n = n.replace(Regex("\\s*-\\s*RINCON_[0-9A-Fa-f]+\\s*$"), "")
        return n.ifBlank { raw }
    }

    private fun lanIp(): String {
        return try {
            val s = DatagramSocket()
            s.connect(InetAddress.getByName("8.8.8.8"), 80)
            val ip = s.localAddress.hostAddress ?: "127.0.0.1"
            s.close()
            ip
        } catch (_: Exception) {
            "127.0.0.1"
        }
    }

    private fun escapeXml(s: String) =
        s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    private fun setAvTransportUriXml(uri: String) =
        """<?xml version="1.0"?>""" +
                """<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" """ +
                """s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">""" +
                """<s:Body><u:SetAVTransportURI xmlns:u="$AVTRANSPORT_NS">""" +
                """<InstanceID>0</InstanceID>""" +
                """<CurrentURI>${escapeXml(uri)}</CurrentURI>""" +
                """<CurrentURIMetaData></CurrentURIMetaData>""" +
                """</u:SetAVTransportURI></s:Body></s:Envelope>"""

    private fun playXml() =
        """<?xml version="1.0"?>""" +
                """<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" """ +
                """s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">""" +
                """<s:Body><u:Play xmlns:u="$AVTRANSPORT_NS">""" +
                """<InstanceID>0</InstanceID><Speed>1</Speed></u:Play></s:Body></s:Envelope>"""

    private fun setVolumeXml(vol: Double): String {
        val pct = (vol.coerceIn(0.0, 1.0) * 100).toInt()
        return """<?xml version="1.0"?>""" +
                """<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" """ +
                """s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">""" +
                """<s:Body><u:SetVolume xmlns:u="$RENDERING_CONTROL_NS">""" +
                """<InstanceID>0</InstanceID><Channel>Master</Channel>""" +
                """<DesiredVolume>$pct</DesiredVolume></u:SetVolume></s:Body></s:Envelope>"""
    }

    private fun upnpPost(controlUrl: String, soap: String, action: String, ns: String) {
        try {
            val u = URL(controlUrl)
            val body = soap.toByteArray(Charsets.UTF_8)
            val sock = Socket(u.host, u.port)
            val out = sock.getOutputStream()
            val req = buildString {
                append("POST ${if (u.path.isEmpty()) "/" else u.path} HTTP/1.1\r\n")
                append("Host: ${u.host}:${u.port}\r\n")
                append("Content-Type: text/xml; charset=\"utf-8\"\r\n")
                append("SOAPAction: \"$ns#$action\"\r\n")
                append("Content-Length: ${body.size}\r\n")
                append("Connection: close\r\n")
                append("\r\n")
            }
            out.write(req.toByteArray(Charsets.UTF_8))
            out.write(body)
            out.flush()
            val inp = sock.getInputStream()
            val buf = ByteArray(4096)
            val sb = StringBuilder()
            var read = 0
            while (inp.read(buf).also { read = it } != -1) {
                sb.append(String(buf, 0, read, Charsets.UTF_8))
            }
            sock.close()
            val statusLine = sb.toString().substringBefore("\r\n")
            val code = statusLine.substringAfter(" ").substringBefore(" ").toIntOrNull() ?: -1
            if (code >= 400) Log.w(TAG, "UPnP $action -> HTTP $code ${sb.take(400)}")
        } catch (e: Exception) {
            Log.e(TAG, "UPnP $action to $controlUrl failed: ${e.message}")
        }
    }
}
