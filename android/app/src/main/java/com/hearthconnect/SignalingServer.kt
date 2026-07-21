package com.hearthconnect

import android.content.Context
import android.content.res.AssetManager
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.network.tls.certificates.buildKeyStore
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.netty.Netty
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.applicationEngineEnvironment
import io.ktor.server.engine.embeddedServer
import io.ktor.server.engine.sslConnector
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.readText
import kotlinx.coroutines.channels.consumeEach
import java.io.File
import java.net.NetworkInterface
import java.security.KeyStore
import java.util.Collections

class SignalingServer(private val context: Context) {
    private val assets: AssetManager = context.assets
    private var engine: ApplicationEngine? = null

    fun start(port: Int = HubService.PORT) {
        val keyStoreFile = File(context.filesDir, KEYSTORE_FILE)
        val keyStore = loadOrCreateKeyStore(keyStoreFile)

        val env = applicationEngineEnvironment {
            sslConnector(
                keyStore = keyStore,
                keyAlias = KEYSTORE_ALIAS,
                keyStorePassword = { KEYSTORE_PASSWORD.toCharArray() },
                privateKeyPassword = { KEYSTORE_PASSWORD.toCharArray() }
            ) {
                host = "0.0.0.0"
                this.port = port
            }
            module {
                install(WebSockets)
                routing {
                    val sessions: MutableSet<WebSocketSession> =
                        Collections.newSetFromMap(Collections.synchronizedMap(mutableMapOf()))

                    webSocket("/ws") {
                        sessions.add(this)
                        try {
                            incoming.consumeEach { frame ->
                                if (frame is Frame.Text) {
                                    val text = frame.readText()
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

                    get("/css/{file}") {
                        call.serveFromAssets(assets, "public/css/${call.parameters["file"]}")
                    }

                    get("/js/{file}") {
                        call.serveFromAssets(assets, "public/js/${call.parameters["file"]}")
                    }

                    get("/assets/{file}") {
                        call.serveFromAssets(assets, "public/assets/${call.parameters["file"]}")
                    }

                    get("/") {
                        call.serveFromAssets(assets, "public/index.html")
                    }

                    get("/{file}.html") {
                        val file = call.parameters["file"] ?: ""
                        call.serveFromAssets(assets, "public/$file.html")
                    }

                    get("/favicon.ico") {
                        call.serveFromAssets(assets, "public/favicon.ico")
                    }

                    get("/favicon.svg") {
                        call.serveFromAssets(assets, "public/favicon.svg")
                    }
                }
            }
        }

        engine = embeddedServer(Netty, env).also { it.start(wait = false) }
    }

    fun stop() {
        engine?.stop(1000, 2000)
        engine = null
    }

    private fun loadOrCreateKeyStore(keyStoreFile: File): KeyStore {
        if (keyStoreFile.exists()) {
            val ks = KeyStore.getInstance(KeyStore.getDefaultType())
            keyStoreFile.inputStream().use { ks.load(it, KEYSTORE_PASSWORD.toCharArray()) }
            return ks
        }
        val generated = buildKeyStore {
            certificate(KEYSTORE_ALIAS) {
                password = KEYSTORE_PASSWORD
                domains = listOf("127.0.0.1", "localhost", "hearth.local")
            }
        }
        keyStoreFile.parentFile?.mkdirs()
        keyStoreFile.outputStream().use { generated.store(it, KEYSTORE_PASSWORD.toCharArray()) }
        return generated
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

    companion object {
        private const val KEYSTORE_ALIAS = "hearthconnect"
        private const val KEYSTORE_PASSWORD = "changeme"
        private const val KEYSTORE_FILE = "hearthconnect.p12"
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
