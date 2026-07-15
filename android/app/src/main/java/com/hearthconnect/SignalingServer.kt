package com.hearthconnect

import android.content.Context
import android.content.res.AssetManager
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.engine.embeddedServer
import io.ktor.server.cio.CIO
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.channels.consumeEach
import java.net.NetworkInterface
import java.util.Collections

/**
 * Minimal Ktor CIO signaling + static-file server, mirroring the Node.js server's
 * role: a WebSocket "hub" that broadcasts signaling messages between peers, plus
 * static serving of the web client bundled in assets/public.
 *
 * Stub for steps 1-4: relays JSON signaling frames to all other peers. Real
 * room/device logic from SignalingHandler.ts will be ported here next.
 */
class SignalingServer(private val context: Context) {
    private val assets: AssetManager = context.assets
    private var engine: io.ktor.server.engine.ApplicationEngine? = null

    fun start(port: Int = HubService.PORT) {
        engine = embeddedServer(CIO, port = port, host = "0.0.0.0") {
            install(WebSockets)
            routing {
                val sessions: MutableSet<DefaultWebSocketServerSession> =
                    Collections.newSetFromMap(Collections.synchronizedMap(mutableMapOf()))

                webSocket("/ws") {
                    sessions.add(this)
                    try {
                        incoming.consumeEach { frame ->
                            if (frame is Frame.Text) {
                                val text = frame.readText()
                                // Broadcast to every other connected peer (signaling relay).
                                for (session in sessions) {
                                    if (session != this) session.send(Frame.Text(text))
                                }
                            }
                        }
                    } finally {
                        sessions.remove(this)
                    }
                }

                get("/api/server-url") {
                    call.respondText("https://${lanIp()}:$port")
                }

                // Static client files from assets/public (mirrors server/public).
                get("{path...}") {
                    val raw = call.parameters["path"]?.trimStart('/') ?: ""
                    val target = if (raw.isEmpty()) "index.html" else raw.replace("..", "")
                    call.serveFromAssets(assets, "public/$target")
                }
            }
        }
        engine?.start(wait = false)
    }

    fun stop() {
        engine?.stop(1000, 2000)
        engine = null
    }

    private fun lanIp(): String {
        return try {
            NetworkInterface.getNetworkInterfaces().toList()
                .flatMap { it.inetAddresses.toList() }
                .firstOrNull { !it.isLoopbackAddress && it.address.size == 4 }
                ?.hostAddress ?: "localhost"
        } catch (_: Exception) {
            "localhost"
        }
    }
}

private suspend fun ApplicationCall.serveFromAssets(assets: AssetManager, assetPath: String) {
    try {
        assets.open(assetPath).use { stream ->
            val bytes = stream.readBytes()
            respondBytes(bytes, contentType = contentTypeFor(assetPath))
        }
    } catch (_: Exception) {
        respondBytes(ByteArray(0), contentType = ContentType.Text.Plain, status = HttpStatusCode.NotFound)
    }
}

private fun contentTypeFor(path: String): ContentType = when {
    path.endsWith(".html") -> ContentType.Text.Html
    path.endsWith(".js") -> ContentType.Text.JavaScript
    path.endsWith(".css") -> ContentType.Text.CSS
    path.endsWith(".svg") -> ContentType.Image.SVG
    path.endsWith(".json") -> ContentType.Application.Json
    path.endsWith(".png") -> ContentType.Image.PNG
    else -> ContentType.Application.OctetStream
}
