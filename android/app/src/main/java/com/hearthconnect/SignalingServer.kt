package com.hearthconnect

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.network.tls.certificates.buildKeyStore
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.applicationEngineEnvironment
import io.ktor.server.engine.embeddedServer
import io.ktor.server.engine.sslConnector
import io.ktor.server.netty.Netty
import io.ktor.server.request.receiveStream
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlin.concurrent.thread
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.consumeEach
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.NetworkInterface
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class SignalingServer(private val context: Context, private val listener: ServerEventListener? = null) {
    private val assets: AssetManager = context.assets
    private var engine: ApplicationEngine? = null

    // ─── In-memory state ─────────────────────────────────────
    private val sessions = ConcurrentHashMap<String, WebSocketSession>()   // connId → session
    private val clients = ConcurrentHashMap<String, ConnectedClient>()     // deviceId → client
    private val connToDevice = ConcurrentHashMap<String, String>()         // connId → deviceId
    private val connIp = ConcurrentHashMap<String, String>()              // connId → remote IP
    private val recentlySeen = ConcurrentHashMap<String, RecentlySeenEntry>()

    // ─── Grace period for subscriber/source teardown ───────
    // AGENTS.md: "Device offline: 60s grace period server-side before removing
    // source from room." A brief WebSocket drop (e.g. an iOS device locking the
    // screen, which suspends the socket) must NOT immediately tear down the
    // publisher's stream — otherwise the subscriber's received audio dies the
    // instant the screen locks. We defer SUBSCRIBER_LEFT / SOURCE_REMOVED and the
    // offline marking by GRACE_MS, and cancel the pending teardown if the same
    // device reconnects within the window (so a screen lock that unlocks <60s
    // later keeps its camera/stream). A genuine departure still frees the
    // resource after the grace, which is what lets the next watcher take over.
    private val GRACE_MS = 60_000L
    private val teardownScheduler = Executors.newSingleThreadScheduledExecutor()
    private val pendingTeardown = ConcurrentHashMap<String, java.util.concurrent.ScheduledFuture<*>>()
    private val deviceConfigs = ConcurrentHashMap<String, JSONObject>()    // deviceId → config
    private var connIdCounter = 0

    // ─── Recorded broadcast clips (plan 18) ────────────────
    // Announcements are transient: held in memory, never persisted. A restart
    // must not be able to resurrect a stale announcement, and this avoids
    // writing to the tablet's flash on every broadcast.
    private val clips = LinkedHashMap<String, Clip>()
    private var clipCounter = 0

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
                    webSocket("/") {
                        val connId = "conn-${++connIdCounter}"
                        val remoteIp = call.request.local.remoteAddress
                        sessions[connId] = this
                        connIp[connId] = remoteIp
                        Log.i(TAG, "WS conn #$connId opened from $remoteIp")

                        try {
                            incoming.consumeEach { frame ->
                                if (frame is Frame.Text) {
                                    val raw = frame.readText()
                                    try {
                                        val msg = JSONObject(raw)
                                        handleMessage(connId, msg)
                                    } catch (e: Exception) {
                                        Log.w(TAG, "WS conn #$connId failed to parse JSON: ${e.message}")
                                    }
                                }
                            }
                            Log.i(TAG, "WS conn #$connId incoming exhausted")
                        } catch (e: Exception) {
                            Log.e(TAG, "WS conn #$connId error: ${e.message}")
                        } finally {
                            handleDisconnect(connId)
                            sessions.remove(connId)
                            connIp.remove(connId)
                            Log.i(TAG, "WS conn #$connId closed")
                        }
                    }

                    get("/api/server-url") {
                        call.respondText("https://${lanIp()}:$port")
                    }

                    // ─── Broadcast clips (plan 18) ───────────────────
                    // The base uploads a recorded announcement once; endpoints
                    // fetch it by URL instead of negotiating a peer connection.
                    post("/api/clip") {
                        try {
                            // receiveStream() + readBounded() are blocking I/O and
                            // must not run on Ktor's Netty event-loop thread.
                            val bytes = withContext(Dispatchers.IO) {
                                call.receiveStream().readBounded(CLIP_MAX_BYTES)
                            }
                            if (bytes.isEmpty()) {
                                call.respondText(
                                    """{"error":"empty clip body"}""",
                                    ContentType.Application.Json,
                                    HttpStatusCode.BadRequest
                                )
                                return@post
                            }
                            val q = call.request.queryParameters
                            val clip = addClip(
                                from = q["from"] ?: "",
                                label = q["label"] ?: "Base Station",
                                bytes = bytes,
                                durationMs = q["durationMs"]?.toIntOrNull() ?: 0
                            )
                            Log.i(TAG, "Clip uploaded: ${clip.id} (${bytes.size} bytes, ${clip.durationMs}ms) from ${clip.from}")
                            call.respondText(
                                JSONObject().apply {
                                    put("clipId", clip.id)
                                    put("url", "/clip/${clip.id}.wav")
                                    put("durationMs", clip.durationMs)
                                }.toString(),
                                ContentType.Application.Json
                            )
                        } catch (e: Exception) {
                            Log.e(TAG, "api/clip FAILED", e)
                            call.respondText(
                                JSONObject().apply { put("error", e.message ?: e.toString()) }.toString(),
                                ContentType.Application.Json,
                                HttpStatusCode.InternalServerError
                            )
                        }
                    }

                    get("/clip/{file}") {
                        val id = (call.parameters["file"] ?: "").removeSuffix(".wav")
                        val clip = getClip(id)
                        if (clip == null) {
                            call.respondText("", ContentType.Text.Plain, HttpStatusCode.NotFound)
                        } else {
                            call.response.headers.append("Cache-Control", "no-store")
                            call.respondBytes(clip.bytes, ContentType("audio", "wav"))
                        }
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
        // Plan 19: discover Sonos / UPnP renderers on the LAN so recorded
        // announcements (PLAY_CLIP) can be pushed to them. Discovered speakers
        // are published to clients as first-class "sonos" room devices.
        SonosManager.onUpdate = { speakers -> syncSonosDevices(speakers) }
        SonosManager.startDiscovery()
        syncSonosDevices(SonosManager.speakers)
    }

    fun stop() {
        engine?.stop(1000, 2000)
        engine = null
    }

    // ─── Disconnect handling ─────────────────────────────────

    private fun handleDisconnect(connId: String) {
        val deviceId = connToDevice[connId] ?: run {
            connToDevice.remove(connId)
            return
        }
        val client = clients[deviceId]
        connToDevice.remove(connId)

        if (client == null || client.connId != connId) return

        Log.i(TAG, "Device disconnected (grace ${GRACE_MS}ms): $deviceId (${client.deviceType})")

        // Capture the state we need for teardown, then defer it. The client
        // object is left in `clients` (with its subscriptions/sources intact)
        // so a quick reconnect within the grace window can cancel this.
        val staleConnId = client.connId
        val subscriptions = client.subscriptions.toList()
        val sources = client.sources.toList()

        val future = teardownScheduler.schedule({
            try {
                // Only tear down if the device has not reconnected: a reconnect
                // updates client.connId, so a still-stale connId means it's the
                // same dropped connection.
                val c = clients[deviceId]
                if (c != null && c.connId == staleConnId) {
                    performTeardown(deviceId, subscriptions, sources)
                }
            } catch (e: Exception) {
                Log.w(TAG, "grace teardown error for $deviceId: ${e.message}")
            }
        }, GRACE_MS, TimeUnit.MILLISECONDS)
        pendingTeardown[deviceId] = future
    }

    private fun cancelGrace(deviceId: String) {
        pendingTeardown.remove(deviceId)?.cancel(false)
    }

    private fun performTeardown(deviceId: String, subscriptions: List<String>, sources: List<MediaSource>) {
        pendingTeardown.remove(deviceId)
        val client = clients[deviceId] ?: return

        Log.i(TAG, "Grace expired — removing $deviceId")

        // Notify publishers this subscriber left
        for (publisherId in subscriptions) {
            sendToDevice(publisherId, JSONObject().apply {
                put("type", "SUBSCRIBER_LEFT")
                put("payload", JSONObject().apply { put("subscriberId", deviceId) })
            })
        }
        client.subscriptions.clear()

        // Remove sources and notify
        for (source in sources) {
            broadcastAll(JSONObject().apply {
                put("type", "SOURCE_REMOVED")
                put("payload", JSONObject().apply { put("sourceId", source.id) })
            }, excludeDeviceId = deviceId)
        }
        client.sources.clear()

        clients.remove(deviceId)

        // Mark offline in recently seen
        recentlySeen[deviceId]?.let {
            it.online = false
            it.lastSeenAt = System.currentTimeMillis()
        }

        broadcastAll(JSONObject().apply {
            put("type", "DEVICE_STATUS")
            put("payload", JSONObject().apply {
                put("deviceId", deviceId)
                put("status", "offline")
            })
        })
    }

    // ─── Message routing ─────────────────────────────────────

    private fun handleMessage(connId: String, msg: JSONObject) {
        val type = msg.optString("type", "")
        val payload = msg.optJSONObject("payload") ?: JSONObject()

        val deviceId = connToDevice[connId] ?: "unauthenticated"
        Log.d(TAG, "MSG $type from $deviceId")

        when (type) {
            "JOIN_ROOM" -> handleJoinRoom(connId, payload)
            "LEAVE_ROOM" -> handleLeaveRoom(connId)
            "HEARTBEAT" -> handleHeartbeat(connId)
            "PUBLISH_SOURCE" -> handlePublishSource(connId, payload)
            "UNPUBLISH_SOURCE" -> handleUnpublishSource(connId, payload)
            "SUBSCRIBE_SOURCE" -> handleSubscribeSource(connId, payload)
            "UNSUBSCRIBE_SOURCE" -> handleUnsubscribeSource(connId, payload)
            "BROADCAST_SOURCE" -> handleBroadcastSource(connId, payload)
            "BROADCAST_CLIP" -> handleBroadcastClip(connId, payload)
            "UNBROADCAST_SOURCE" -> handleUnbroadcastSource(connId, payload)
            "SUBSCRIBE_BROADCAST" -> handleSubscribeBroadcast(connId, payload)
            "UNSUBSCRIBE_BROADCAST" -> handleUnsubscribeBroadcast(connId, payload)
            "OFFER" -> handleRelay(connId, msg)
            "ANSWER" -> handleRelay(connId, msg)
            "ICE_CANDIDATE" -> handleRelay(connId, msg)
            "ICE_RESTART" -> handleRelay(connId, msg)
            "RENEGOTIATE" -> handleRelay(connId, msg)
            "SET_CONFIG" -> handleSetConfig(connId, payload)
            "GET_CONFIG" -> handleGetConfig(connId, payload)
            "SET_DISPLAY_CONFIG" -> handleSetDisplayConfig(connId, payload)
            "REQUEST_TALK" -> handleRequestTalk(connId, payload)
            "STOP_TALK" -> handleStopTalk(connId, payload)
            "CAPABILITIES" -> handleCapabilities(connId, payload)
            "AUDIO_PEAK" -> handleAudioPeak(connId, payload)
            "REMOVE_DEVICE" -> handleRemoveDevice(connId, payload)
            "TEST_SPEAKER" -> handleTestSpeaker(connId, payload)
            "DOORBELL" -> handleDoorbell(connId, payload)
            "CALL_STATE" -> handleCallState(connId, payload)
            "PAIR_DEVICE" -> handlePairDevice(connId, payload)
            else -> sendError(connId, "UNKNOWN_TYPE", "Unknown message type: $type")
        }
    }

    // ─── Helpers ─────────────────────────────────────────────

    private fun sendToDevice(deviceId: String, msg: JSONObject) {
        val client = clients[deviceId] ?: return
        val session = sessions[client.connId] ?: return
        try {
            session.outgoing.trySend(Frame.Text(msg.toString()))
        } catch (e: Exception) {
            Log.w(TAG, "Send failed to $deviceId: ${e.message}")
        }
    }

    private fun sendToConn(connId: String, msg: JSONObject) {
        val session = sessions[connId] ?: return
        try {
            session.outgoing.trySend(Frame.Text(msg.toString()))
        } catch (e: Exception) {
            Log.w(TAG, "Send failed to conn $connId: ${e.message}")
        }
    }

    private fun sendError(connId: String, code: String, message: String) {
        sendToConn(connId, JSONObject().apply {
            put("type", "ERROR")
            put("payload", JSONObject().apply {
                put("code", code)
                put("message", message)
            })
        })
    }

    private fun broadcastAll(msg: JSONObject, excludeDeviceId: String? = null) {
        for ((id, client) in clients) {
            if (id == excludeDeviceId) continue
            sendToDevice(id, msg)
        }
    }

    private fun broadcastToType(deviceType: String, msg: JSONObject, excludeDeviceId: String? = null) {
        for ((id, client) in clients) {
            if (client.deviceType != deviceType) continue
            if (id == excludeDeviceId) continue
            sendToDevice(id, msg)
        }
    }

    // ─── Handlers ────────────────────────────────────────────

    private fun handleJoinRoom(connId: String, payload: JSONObject) {
        val deviceId = payload.optString("deviceId", "")
        val deviceType = payload.optString("deviceType", "")
        val label = payload.optString("label", deviceId).ifEmpty { deviceId }

        if (deviceId.isEmpty() || deviceType.isEmpty()) {
            sendError(connId, "INVALID_PARAMS", "deviceId and deviceType required")
            return
        }

        val roomId = "default"

        // Merge any config the client sends on join (kiosk reports its localStorage state).
        // Device-side preferences (displayMode, broadcastDisabled) are always overwritten
        // from the client because the kiosk knows what it's actually displaying — the
        // server may have stale defaults from device creation.
        val clientConfig = payload.optJSONObject("config")
        if (clientConfig != null && clientConfig.length() > 0) {
            val existing = deviceConfigs[deviceId]
            if (existing != null) {
                val deviceSideKeys = setOf("displayMode", "broadcastDisabled")
                val keys = clientConfig.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    if (key in deviceSideKeys || !existing.has(key)) {
                        existing.put(key, clientConfig.get(key))
                    }
                }
            } else {
                deviceConfigs[deviceId] = JSONObject(clientConfig.toString())
            }
        }

        // Cancel any pending grace-period teardown — a reconnect means the
        // device is back (e.g. an iOS screen lock that released the socket),
        // so we keep its subscriptions/sources and don't tear down the stream.
        cancelGrace(deviceId)

        // Cancel existing connection for reconnecting device
        val existingClient = clients[deviceId]
        if (existingClient != null && existingClient.connId != connId) {
            // Close old connection
            sessions.remove(existingClient.connId)
            connToDevice.remove(existingClient.connId)
        }

        // Create default config for new devices (mirrors Node.js createDevice)
        if (deviceConfigs[deviceId] == null) {
            deviceConfigs[deviceId] = defaultConfig(deviceType)
        }

        // Reuse the existing client object when reconnecting so its
        // subscriptions/sources survive a brief drop (grace period). A fresh
        // device (no existing client) gets a new object.
        val client = if (existingClient != null && existingClient.connId != connId) {
            // Reconnect within the grace window: preserve subscriptions/sources
            // by updating the existing client in place (only the mutable fields).
            existingClient.connId = connId
            existingClient.label = label
            existingClient.ip = connIp[connId]
            existingClient.connectedAt = System.currentTimeMillis()
            existingClient
        } else if (existingClient != null) {
            existingClient.connId = connId
            existingClient
        } else {
            ConnectedClient(
                connId = connId,
                deviceId = deviceId,
                deviceType = deviceType,
                roomId = roomId,
                label = label,
                ip = connIp[connId],
                connectedAt = System.currentTimeMillis()
            )
        }
        clients[deviceId] = client
        connToDevice[connId] = deviceId

        // Update recently seen
        recentlySeen[deviceId] = RecentlySeenEntry(
            id = deviceId,
            label = label,
            type = deviceType,
            lastSeenAt = System.currentTimeMillis(),
            online = true,
            ip = connIp[connId]
        )

        // Prune stale entries of same type
        val staleIds = recentlySeen.filter { it.key != deviceId && it.value.type == deviceType && !it.value.online }.keys
        staleIds.forEach { recentlySeen.remove(it) }

        // Send WELCOME
        val activeSources = getActiveSources(roomId)
        val recentDevices = getRecentlySeenDevices()
        sendToConn(connId, JSONObject().apply {
            put("type", "WELCOME")
            put("payload", JSONObject().apply {
                put("deviceId", deviceId)
                put("roomId", roomId)
                put("config", deviceConfigs[deviceId] ?: JSONObject())
                put("sources", activeSources)
                put("recentlySeenDevices", recentDevices)
            })
        })

        // Broadcast DEVICE_STATUS to all others
        broadcastAll(JSONObject().apply {
            put("type", "DEVICE_STATUS")
            put("payload", JSONObject().apply {
                put("deviceId", deviceId)
                put("status", "online")
                put("type", deviceType)
                put("label", label)
                put("lastSeenAt", System.currentTimeMillis())
                put("config", deviceConfigs[deviceId] ?: JSONObject())
                put("ip", connIp[connId] ?: "")
            })
        }, excludeDeviceId = deviceId)

        // Send capabilities of already-connected devices to new joiner
        for ((otherId, otherClient) in clients) {
            if (otherId == deviceId) continue
            if (otherClient.capabilities != null) {
                sendToConn(connId, JSONObject().apply {
                    put("type", "CAPABILITIES")
                    put("payload", JSONObject().apply {
                        put("deviceId", otherId)
                        put("videoDevices", otherClient.capabilities!!.videoDevices)
                        put("audioDevices", otherClient.capabilities!!.audioDevices)
                        put("audioOutputDevices", otherClient.capabilities!!.audioOutputDevices)
                    })
                })
            }
        }

        Log.i(TAG, "Device joined: $deviceId ($deviceType) as label=\"$label\"")
    }

    private fun handleLeaveRoom(connId: String) {
        val deviceId = connToDevice[connId] ?: return
        val client = clients[deviceId] ?: return

        for (source in client.sources) {
            broadcastAll(JSONObject().apply {
                put("type", "SOURCE_REMOVED")
                put("payload", JSONObject().apply { put("sourceId", source.id) })
            }, excludeDeviceId = deviceId)
        }

        clients.remove(deviceId)
        connToDevice.remove(connId)

        broadcastAll(JSONObject().apply {
            put("type", "DEVICE_STATUS")
            put("payload", JSONObject().apply {
                put("deviceId", deviceId)
                put("status", "offline")
            })
        })
    }

    private fun handleHeartbeat(connId: String) {
        val deviceId = connToDevice[connId] ?: return
        clients[deviceId]?.lastHeartbeat = System.currentTimeMillis()
        sendToConn(connId, JSONObject().apply {
            put("type", "HEARTBEAT")
            put("payload", JSONObject())
        })
    }

    private fun handlePublishSource(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return sendError(connId, "NOT_IN_ROOM", "Join a room first")
        val sourceId = payload.optString("sourceId", "")
        val label = payload.optString("label", "Camera")
        val type = payload.optString("type", "video+audio").let {
            if (it in VALID_SOURCE_TYPES) it else "video+audio"
        }

        if (sourceId.isEmpty()) return sendError(connId, "INVALID_PARAMS", "sourceId required")

        val source = addSource(client, sourceId, label, type) ?: return sendError(connId, "INTERNAL_ERROR", "Failed to add source")

        broadcastAll(JSONObject().apply {
            put("type", "SOURCE_ADDED")
            put("payload", sourceToJson(source))
        }, excludeDeviceId = client.deviceId)

        Log.i(TAG, "Source published: $sourceId by ${client.deviceId}")
    }

    private fun handleUnpublishSource(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val sourceId = payload.optString("sourceId", "")
        if (sourceId.isEmpty()) return

        if (removeSource(client, sourceId)) {
            broadcastAll(JSONObject().apply {
                put("type", "SOURCE_REMOVED")
                put("payload", JSONObject().apply { put("sourceId", sourceId) })
            }, excludeDeviceId = client.deviceId)
        }
    }

    private fun handleSubscribeSource(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return sendError(connId, "NOT_IN_ROOM", "Join a room first")
        val publisherId = payload.optString("publisherId", "")
        if (publisherId.isEmpty()) return

        val publisher = clients[publisherId] ?: return sendError(connId, "NOT_FOUND", "Publisher not found")

        sendToDevice(publisherId, JSONObject().apply {
            put("type", "SUBSCRIBER_JOINED")
            put("payload", JSONObject().apply { put("subscriberId", client.deviceId) })
        })

        if (publisherId !in client.subscriptions) {
            client.subscriptions.add(publisherId)
        }
        Log.i(TAG, "Subscriber ${client.deviceId} subscribed to $publisherId")
    }

    private fun handleUnsubscribeSource(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val publisherId = payload.optString("publisherId", "")
        if (publisherId.isEmpty()) return

        sendToDevice(publisherId, JSONObject().apply {
            put("type", "SUBSCRIBER_LEFT")
            put("payload", JSONObject().apply { put("subscriberId", client.deviceId) })
        })

        client.subscriptions.remove(publisherId)
    }

    private fun handleBroadcastSource(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return sendError(connId, "NOT_IN_ROOM", "Join a room first")
        if (client.deviceType !in BASE_TYPES) return sendError(connId, "NOT_ALLOWED", "Only base stations can broadcast")

        val sourceId = payload.optString("sourceId", "")
        val label = payload.optString("label", "Base Station Broadcast")
        val type = payload.optString("type", "audio-only").let {
            if (it in VALID_SOURCE_TYPES) it else "audio-only"
        }
        val rawTarget = payload.optString("targetDeviceId", "")
        val targetDeviceId = if (rawTarget.isNotEmpty() && rawTarget != "all") rawTarget else null

        if (sourceId.isEmpty()) return sendError(connId, "INVALID_PARAMS", "sourceId required")

        val source = addSource(client, sourceId, label, type) ?: return sendError(connId, "INTERNAL_ERROR", "Failed to add broadcast source")
        source.isBroadcast = true
        source.targetDeviceId = targetDeviceId

        // Send SOURCE_ADDED to targeted kiosks or all other clients
        val sourceJson = sourceToJson(source)
        if (targetDeviceId != null) {
            sendToDevice(targetDeviceId, JSONObject().apply {
                put("type", "SOURCE_ADDED")
                put("payload", sourceJson)
            })
        } else {
            broadcastAll(JSONObject().apply {
                put("type", "SOURCE_ADDED")
                put("payload", sourceJson)
            }, excludeDeviceId = client.deviceId)
        }

        Log.i(TAG, "Broadcast source published: $sourceId by ${client.deviceId}" +
            if (targetDeviceId != null) " → $targetDeviceId" else " → all")
    }

    // ─── Broadcast clips (plan 18) ─────────────────────────

    @Synchronized
    private fun addClip(from: String, label: String, bytes: ByteArray, durationMs: Int): Clip {
        val clip = Clip(
            id = "clip-${++clipCounter}-${System.currentTimeMillis()}",
            from = from,
            label = label,
            bytes = bytes,
            durationMs = durationMs,
            createdAt = System.currentTimeMillis()
        )
        clips[clip.id] = clip
        // Evict expired first, then trim to the cap. LinkedHashMap preserves
        // insertion order so the head is always the oldest.
        val cutoff = System.currentTimeMillis() - CLIP_TTL_MS
        clips.entries.removeAll { it.value.createdAt < cutoff }
        while (clips.size > CLIP_MAX_COUNT) {
            val oldest = clips.keys.firstOrNull() ?: break
            clips.remove(oldest)
        }
        return clip
    }

    @Synchronized
    private fun getClip(id: String): Clip? {
        val clip = clips[id] ?: return null
        if (System.currentTimeMillis() - clip.createdAt > CLIP_TTL_MS) {
            clips.remove(id)
            return null
        }
        return clip
    }

    /**
     * Record-then-play announcement fan-out (plan 18).
     *
     * The WAV is already uploaded; this only tells endpoints to fetch and play
     * it. No peer connection, so none of handleBroadcastSource's cold-handshake
     * timing issues apply.
     */
    private fun handleBroadcastClip(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return sendError(connId, "NOT_IN_ROOM", "Join a room first")
        if (client.deviceType !in BASE_TYPES) return sendError(connId, "NOT_ALLOWED", "Only base stations can broadcast")

        val clipId = payload.optString("clipId", "")
        if (clipId.isEmpty()) return sendError(connId, "INVALID_PARAMS", "clipId required")
        val clip = getClip(clipId) ?: return sendError(connId, "NOT_FOUND", "Clip expired or not found")

        // Same 'all' normalization as handleBroadcastSource — a device literally
        // named "all" must not be matched as a target.
        val rawTarget = payload.optString("targetDeviceId", "")
        val targetDeviceId = if (rawTarget.isNotEmpty() && rawTarget != "all") rawTarget else null

        val label = deviceConfigs[client.deviceId]?.optString("label")?.takeIf { it.isNotEmpty() }
            ?: "Base Station"

        val msg = JSONObject().apply {
            put("type", "PLAY_CLIP")
            put("payload", JSONObject().apply {
                put("clipId", clip.id)
                put("url", "/clip/${clip.id}.wav")
                put("durationMs", clip.durationMs)
                put("from", client.deviceId)
                put("label", label)
            })
        }

        var delivered = 0
        val isSonosTarget = targetDeviceId != null && targetDeviceId.startsWith("sonos://")
        val targets = if (isSonosTarget) {
            emptyList()
        } else if (targetDeviceId != null) {
            clients.values.filter { it.deviceId == targetDeviceId }
        } else {
            clients.values.filter { it.deviceId != client.deviceId }
        }
        for (target in targets) {
            // Authoritative opt-out check: never trust the endpoint to silence
            // itself (mirrors handleSubscribeBroadcast).
            val cfg = deviceConfigs[target.deviceId]
            if (cfg != null && cfg.optBoolean("broadcastDisabled", false)) continue
            sendToDevice(target.deviceId, msg)
            delivered++
        }

        // Plan 19: route the recorded clip to discovered Sonos/UPnP speakers.
        // This is the explicit exception to the "server is a matchmaker only"
        // rule — recorded audio only (re-hosted WAV + UPnP AVTransport), never
        // live WebRTC. A Sonos chosen in the "Send to" list is an explicit
        // target; "all" fans out to every Sonos that allows broadcasts.
        val sonosTargets: List<String> = when {
            isSonosTarget -> listOf(targetDeviceId!!)
            targetDeviceId == null -> recentlySeen.keys.filter { recentlySeen[it]?.type == "sonos" }
                .filter { deviceConfigs[it]?.optBoolean("allowBroadcasts", true) ?: true }
            else -> emptyList()
        }
        for (sid in sonosTargets) {
            val sp = SonosManager.speakerById(sid)
            if (sp != null) {
                val vol = deviceConfigs[sid]?.optDouble("volume", 0.5) ?: 0.5
                // Run on a background thread: playClipOnSpeaker blocks ~15s
                // (it holds the HTTP server open until the clip finishes), and
                // the WS dispatch thread must stay free for other messages.
                thread(isDaemon = true) { SonosManager.playClipOnSpeaker(context, sp, clip.bytes, vol, clip.durationMs) }
                delivered++
            } else {
                Log.w(TAG, "PLAY_CLIP sonos target $sid not among discovered Sonos")
            }
        }

        Log.i(TAG, "Clip broadcast $clipId by ${client.deviceId} → ${targetDeviceId ?: "all"} ($delivered endpoints)")
    }

    // ─── Plan 19: Sonos / UPnP network speakers ─────────────

    // Publish discovered Sonos as first-class room devices so the base station
    // can list, configure (volume / allow-broadcasts), and target them.
    private fun syncSonosDevices(speakers: List<SonosManager.SonosSpeaker>) {
        val discoveredIds = speakers.map { it.id }.toSet()
        val knownIds = recentlySeen.keys.filter { recentlySeen[it]?.type == "sonos" }.toSet()
        val changed = discoveredIds != knownIds

        for (sp in speakers) {
            if (deviceConfigs[sp.id] == null) {
                deviceConfigs[sp.id] = JSONObject().apply {
                    put("volume", 0.5)
                    put("allowBroadcasts", true)
                    put("label", sp.label)
                }
            } else {
                deviceConfigs[sp.id]?.put("label", sp.label)
            }
            recentlySeen[sp.id] = RecentlySeenEntry(
                id = sp.id, label = sp.label, type = "sonos",
                lastSeenAt = System.currentTimeMillis(), online = true, ip = sp.ip
            )
        }
        // Speakers no longer discovered are kept (config persists) but marked
        // offline so the UI can surface them as unavailable.
        for (id in knownIds) {
            if (id !in discoveredIds) recentlySeen[id]?.online = false
        }

        if (changed) {
            for (sp in speakers) {
                broadcastDeviceStatus(sp.id, "online", "sonos", sp.label, sp.ip)
            }
            for (id in knownIds) {
                if (id !in discoveredIds) {
                    val lbl = deviceConfigs[id]?.optString("label", id) ?: id
                    broadcastDeviceStatus(id, "offline", "sonos", lbl, null)
                }
            }
            Log.i(TAG, "Sonos device set synced: ${discoveredIds.joinToString()}")
        }
    }

    private fun broadcastDeviceStatus(deviceId: String, status: String, type: String, label: String, ip: String?) {
        broadcastAll(JSONObject().apply {
            put("type", "DEVICE_STATUS")
            put("payload", JSONObject().apply {
                put("deviceId", deviceId)
                put("status", status)
                put("type", type)
                put("label", label)
                put("lastSeenAt", System.currentTimeMillis())
                put("config", deviceConfigs[deviceId] ?: JSONObject())
                if (ip != null) put("ip", ip)
            })
        })
    }

    private fun handleTestSpeaker(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        if (client.deviceType !in BASE_TYPES) return sendError(connId, "NOT_ALLOWED", "Only base stations can test speakers")
        val id = payload.optString("deviceId", "")
        val sp = SonosManager.speakerById(id)
        if (sp == null) return sendError(connId, "NOT_FOUND", "Speaker not discovered")
        val vol = deviceConfigs[id]?.optDouble("volume", 0.5) ?: 0.5
        val wav = makeBeepWav(440.0, 1000)
        thread(isDaemon = true) { SonosManager.playClipOnSpeaker(context, sp, wav, vol, 1000) }
        Log.i(TAG, "Test tone sent to Sonos ${sp.label}")
    }

    private fun makeBeepWav(freq: Double, durationMs: Int): ByteArray {
        val sampleRate = 44100
        val n = (sampleRate * durationMs / 1000)
        val baos = java.io.ByteArrayOutputStream()
        val dataLen = n * 2
        fun u16(v: Int) { baos.write(v and 0xff); baos.write((v ushr 8) and 0xff) }
        fun u32(v: Int) { baos.write(v and 0xff); baos.write((v ushr 8) and 0xff); baos.write((v ushr 16) and 0xff); baos.write((v ushr 24) and 0xff) }
        fun str(s: String) { for (c in s) baos.write(c.code) }
        str("RIFF"); u32(36 + dataLen); str("WAVE")
        str("fmt "); u32(16); u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
        str("data"); u32(dataLen)
        for (i in 0 until n) {
            val t = i.toDouble() / sampleRate
            val env = when {
                i < n * 0.1 -> i.toDouble() / (n * 0.1)
                i > n * 0.9 -> (n - i).toDouble() / (n * 0.1)
                else -> 1.0
            }
            val s = (Math.sin(2 * Math.PI * freq * t) * 32767 * 0.6 * env).toInt().coerceIn(-32768, 32767)
            u16(s and 0xffff)
        }
        return baos.toByteArray()
    }

    private fun handleUnbroadcastSource(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val sourceId = payload.optString("sourceId", "")
        if (sourceId.isEmpty()) return

        if (removeSource(client, sourceId)) {
            broadcastAll(JSONObject().apply {
                put("type", "SOURCE_REMOVED")
                put("payload", JSONObject().apply { put("sourceId", sourceId) })
            })
        }
    }

    private fun handleSubscribeBroadcast(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return sendError(connId, "NOT_IN_ROOM", "Join a room first")
        // Any device may receive broadcasts (cameras/monitors included), unless it
        // has opted out via the broadcastDisabled toggle. This mirrors the
        // client-side check in pi-agent (SOURCE_ADDED -> broadcastDisabled).
        val devCfg = deviceConfigs[client.deviceId]
        if (devCfg != null && devCfg.optBoolean("broadcastDisabled", false)) {
            return sendError(connId, "NOT_ALLOWED", "Broadcasts are disabled for this device")
        }

        val publisherId = payload.optString("publisherId", "")
        if (publisherId.isEmpty()) return

        val publisher = clients[publisherId] ?: return sendError(connId, "NOT_FOUND", "Publisher not found")

        sendToDevice(publisherId, JSONObject().apply {
            put("type", "SUBSCRIBER_JOINED")
            put("payload", JSONObject().apply {
                put("subscriberId", client.deviceId)
                put("isBroadcast", true)
            })
        })

        Log.i(TAG, "${client.deviceType} ${client.deviceId} subscribed to broadcast from $publisherId")
    }

    private fun handleUnsubscribeBroadcast(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val publisherId = payload.optString("publisherId", "")
        if (publisherId.isEmpty()) return

        sendToDevice(publisherId, JSONObject().apply {
            put("type", "SUBSCRIBER_LEFT")
            put("payload", JSONObject().apply {
                put("subscriberId", client.deviceId)
                put("isBroadcast", true)
            })
        })
    }

    private fun handleRelay(connId: String, msg: JSONObject) {
        val client = getClient(connId) ?: return sendError(connId, "NOT_IN_ROOM", "Join a room first")
        val payload = msg.optJSONObject("payload") ?: return
        val targetId = payload.optString("to", "")
        if (targetId.isEmpty()) return sendError(connId, "INVALID_PARAMS", "Target device ID required")

        // Add 'from' to payload
        val newPayload = JSONObject(payload.toString())
        newPayload.put("from", client.deviceId)

        sendToDevice(targetId, JSONObject().apply {
            put("type", msg.optString("type"))
            put("payload", newPayload)
        })
    }

    private fun handleSetConfig(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        if (client.deviceType !in BASE_TYPES) return sendError(connId, "NOT_ALLOWED", "Only base stations can push configuration")

        val targetDeviceId = payload.optString("targetDeviceId", "")
        val config = payload.optJSONObject("config")
        if (targetDeviceId.isEmpty() || config == null) {
            return sendError(connId, "INVALID_PARAMS", "targetDeviceId and config required")
        }

        // Persist the config (merge with existing)
        val existing = deviceConfigs[targetDeviceId]
        if (existing != null) {
            val keys = config.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                existing.put(key, config.get(key))
            }
        } else {
            deviceConfigs[targetDeviceId] = JSONObject(config.toString())
        }

        val fullConfig = deviceConfigs[targetDeviceId]!!

        // If keepAwake changed, sync to SharedPreferences so HubService picks it up
        if (config.has("keepAwake")) {
            val keepAwake = config.optBoolean("keepAwake", true)
            context.getSharedPreferences("hearth_hub", Context.MODE_PRIVATE)
                .edit().putBoolean("keepAwake", keepAwake).apply()
            Log.i(TAG, "keepAwake synced to SharedPreferences: $keepAwake")
        }

        // If label changed, update in-memory state
        val newLabel = config.optString("label", "")
        if (newLabel.isNotEmpty()) {
            clients[targetDeviceId]?.label = newLabel
            recentlySeen[targetDeviceId]?.label = newLabel
        }

        val target = clients[targetDeviceId]
        if (target != null) {
            sendToDevice(targetDeviceId, JSONObject().apply {
                put("type", "CONFIG_UPDATED")
                put("payload", JSONObject().apply { put("config", fullConfig) })
            })
        }

        sendToConn(connId, JSONObject().apply {
            put("type", "CONFIG_RESULT")
            put("payload", JSONObject().apply {
                put("targetDeviceId", targetDeviceId)
                put("ok", true)
                put("config", fullConfig)
            })
        })

        broadcastAll(JSONObject().apply {
            put("type", "DEVICE_STATUS")
            put("payload", JSONObject().apply {
                put("deviceId", targetDeviceId)
                put("status", "online")
                put("type", target?.deviceType ?: recentlySeen[targetDeviceId]?.type ?: "kiosk")
                put("label", if (newLabel.isNotEmpty()) newLabel else (target?.label ?: targetDeviceId))
                put("lastSeenAt", System.currentTimeMillis())
                put("config", fullConfig)
                if (target?.ip != null) put("ip", target.ip)
            })
        })

        Log.i(TAG, "Config updated for $targetDeviceId by ${client.deviceId}")
    }

    private fun handleGetConfig(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val targetDeviceId = payload.optString("targetDeviceId", "").ifEmpty { client.deviceId }

        val config = deviceConfigs[targetDeviceId] ?: JSONObject()
        sendToConn(connId, JSONObject().apply {
            put("type", "CONFIG_RESULT")
            put("payload", JSONObject().apply {
                put("targetDeviceId", targetDeviceId)
                put("config", config)
            })
        })
    }

    private fun handleSetDisplayConfig(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        if (client.deviceType !in BASE_TYPES) return sendError(connId, "NOT_ALLOWED", "Only base stations can set display config")

        val targetDeviceId = payload.optString("targetDeviceId", "")
        val displayMode = payload.optString("displayMode", "")
        if (targetDeviceId.isEmpty() || displayMode.isEmpty()) {
            return sendError(connId, "INVALID_PARAMS", "targetDeviceId and displayMode required")
        }

        val target = clients[targetDeviceId]

        // Persist display mode
        val existing = deviceConfigs[targetDeviceId]
        if (existing != null) {
            existing.put("displayMode", displayMode)
        } else {
            deviceConfigs[targetDeviceId] = JSONObject().apply {
                put("displayMode", displayMode)
            }
        }
        val fullConfig = deviceConfigs[targetDeviceId]!!

        if (target != null) {
            sendToDevice(targetDeviceId, JSONObject().apply {
                put("type", "SET_DISPLAY_CONFIG")
                put("payload", JSONObject().apply {
                    put("displayMode", displayMode)
                })
            })
        }

        sendToConn(connId, JSONObject().apply {
            put("type", "CONFIG_RESULT")
            put("payload", JSONObject().apply {
                put("targetDeviceId", targetDeviceId)
                put("ok", true)
                put("config", fullConfig)
            })
        })

        Log.i(TAG, "Display config set for $targetDeviceId: display=$displayMode")
    }

    private fun handleRequestTalk(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val targetPublisherId = payload.optString("targetPublisherId", "")
        if (targetPublisherId.isEmpty()) return

        sendToDevice(targetPublisherId, JSONObject().apply {
            put("type", "TALK_ENABLED")
            put("payload", JSONObject().apply { put("from", client.deviceId) })
        })
    }

    private fun handleStopTalk(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val targetPublisherId = payload.optString("targetPublisherId", "")
        if (targetPublisherId.isEmpty()) return

        sendToDevice(targetPublisherId, JSONObject().apply {
            put("type", "TALK_DISABLED")
            put("payload", JSONObject().apply { put("from", client.deviceId) })
        })
    }

    private fun handleCapabilities(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return

        val videoDevices = payload.optJSONArray("videoDevices") ?: JSONArray()
        val audioDevices = payload.optJSONArray("audioDevices") ?: JSONArray()
        val audioOutputDevices = payload.optJSONArray("audioOutputDevices") ?: JSONArray()
        client.capabilities = DeviceCapabilities(
            videoDevices = videoDevices,
            audioDevices = audioDevices,
            audioOutputDevices = audioOutputDevices
        )

        // Note: Sonos/UPnP speakers are NOT injected here. They are published as
        // first-class "sonos" room devices (see syncSonosDevices) so they appear
        // in their own speaker panel and as broadcast targets — not as a kiosk's
        // local audio output.

        broadcastAll(JSONObject().apply {
            put("type", "CAPABILITIES")
            put("payload", JSONObject().apply {
                put("deviceId", client.deviceId)
                put("videoDevices", videoDevices)
                put("audioDevices", audioDevices)
                put("audioOutputDevices", audioOutputDevices)
            })
        }, excludeDeviceId = client.deviceId)

        Log.i(TAG, "Capabilities reported: ${client.deviceId} (${videoDevices.length()}v ${audioDevices.length()}a ${audioOutputDevices.length()}out)")
    }

    private fun handleAudioPeak(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val levelDb = payload.opt("levelDb")
        // Relay the audio-level reading to every other device (the base station
        // renders the dB readout / alert highlight from it). Forwarding to the
        // native hub layer was removed in v0.9, so this only broadcasts.
        broadcastAll(JSONObject().apply {
            put("type", "AUDIO_PEAK")
            put("payload", JSONObject().apply {
                put("deviceId", client.deviceId)
                put("levelDb", levelDb)
                put("peak", payload.opt("peak"))
                put("ts", payload.opt("ts") ?: System.currentTimeMillis())
            })
        }, excludeDeviceId = client.deviceId)
    }

    private fun handleRemoveDevice(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        if (client.deviceType !in BASE_TYPES) return sendError(connId, "NOT_ALLOWED", "Only base stations can remove devices")

        val targetDeviceId = payload.optString("targetDeviceId", "")
        if (targetDeviceId.isEmpty()) return sendError(connId, "INVALID_PARAMS", "targetDeviceId required")

        // Close target connection
        val target = clients[targetDeviceId]
        if (target != null) {
            sessions.remove(target.connId)
            connToDevice.remove(target.connId)
        }

        recentlySeen.remove(targetDeviceId)
        clients.remove(targetDeviceId)

        broadcastAll(JSONObject().apply {
            put("type", "DEVICE_REMOVED")
            put("payload", JSONObject().apply { put("deviceId", targetDeviceId) })
        })

        Log.i(TAG, "Device removed: $targetDeviceId by ${client.deviceId}")
    }

    private fun handleDoorbell(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val label = payload.optString("label", "").ifEmpty { client.label }

        broadcastToType("base", JSONObject().apply {
            put("type", "DOORBELL")
            put("payload", JSONObject().apply {
                put("from", client.deviceId)
                put("label", label)
                put("ts", System.currentTimeMillis())
            })
        }, excludeDeviceId = client.deviceId)

        Log.i(TAG, "Doorbell rung by ${client.deviceId} ($label)")
        listener?.onDoorbell(client.deviceId, label)
    }

    private fun handleCallState(connId: String, payload: JSONObject) {
        val client = getClient(connId) ?: return
        val targetId = payload.optString("targetDeviceId", "")
        if (targetId.isEmpty()) return

        sendToDevice(targetId, JSONObject().apply {
            put("type", "CALL_STATE")
            put("payload", JSONObject().apply {
                put("from", client.deviceId)
                put("state", payload.opt("state"))
                put("ts", System.currentTimeMillis())
            })
        })
    }

    private fun handlePairDevice(connId: String, payload: JSONObject) {
        val token = payload.optString("token", "")
        val deviceType = payload.optString("deviceType", "")
        val label = payload.optString("label", "Unnamed Device")

        if (token.isEmpty() || deviceType.isEmpty()) {
            return sendError(connId, "INVALID_PARAMS", "token and deviceType required")
        }

        // Simple token validation: accept any non-empty token for now
        val deviceId = "dev-${System.currentTimeMillis()}-${(Math.random() * 100000).toInt()}"

        sendToConn(connId, JSONObject().apply {
            put("type", "WELCOME")
            put("payload", JSONObject().apply {
                put("deviceId", deviceId)
                put("roomId", "default")
                put("config", JSONObject())
                put("sources", JSONArray())
            })
        })

        Log.i(TAG, "Device paired: $deviceId ($deviceType)")
    }

    // ─── Source management ───────────────────────────────────

    private data class MediaSource(
        val id: String,
        val publisherId: String,
        var label: String,
        var type: String,
        var status: String = "live",
        var isBroadcast: Boolean = false,
        var targetDeviceId: String? = null
    )

    private fun addSource(client: ConnectedClient, sourceId: String, label: String, type: String): MediaSource? {
        val existing = client.sources.find { it.id == sourceId }
        if (existing != null) {
            existing.type = type
            existing.label = label
            existing.status = "live"
            return existing
        }
        val source = MediaSource(
            id = sourceId,
            publisherId = client.deviceId,
            label = label,
            type = type
        )
        client.sources.add(source)
        return source
    }

    private fun removeSource(client: ConnectedClient, sourceId: String): Boolean {
        val idx = client.sources.indexOfFirst { it.id == sourceId }
        if (idx == -1) return false
        client.sources.removeAt(idx)
        return true
    }

    private fun getActiveSources(roomId: String): JSONArray {
        val arr = JSONArray()
        for (client in clients.values) {
            if (client.roomId == roomId) {
                for (source in client.sources) {
                    arr.put(sourceToJson(source))
                }
            }
        }
        return arr
    }

    private fun sourceToJson(source: MediaSource): JSONObject {
        return JSONObject().apply {
            put("id", source.id)
            put("publisherId", source.publisherId)
            put("label", source.label)
            put("type", source.type)
            put("status", source.status)
            if (source.isBroadcast) put("isBroadcast", true)
            if (source.targetDeviceId != null) put("targetDeviceId", source.targetDeviceId)
        }
    }

    private fun getActiveSources(roomId: String, deviceId: String): JSONArray {
        // Used for per-client source filtering - not needed yet
        return getActiveSources(roomId)
    }

    // ─── Recently seen ───────────────────────────────────────

    private data class RecentlySeenEntry(
        val id: String,
        var label: String,
        val type: String,
        var lastSeenAt: Long,
        var online: Boolean,
        var ip: String? = null
    )

    private fun getRecentlySeenDevices(): JSONArray {
        val arr = JSONArray()
        val now = System.currentTimeMillis()
        for (entry in recentlySeen.values) {
            if (now - entry.lastSeenAt <= RECENT_SEEN_WINDOW) {
                arr.put(JSONObject().apply {
                    put("id", entry.id)
                    put("label", entry.label)
                    put("type", entry.type)
                    put("lastSeenAt", entry.lastSeenAt)
                    put("online", entry.online)
                    put("config", deviceConfigs[entry.id] ?: JSONObject())
                    if (entry.ip != null) put("ip", entry.ip)
                })
            }
        }
        return arr
    }

    // ─── Client lookup ───────────────────────────────────────

    private fun getClient(connId: String): ConnectedClient? {
        val deviceId = connToDevice[connId] ?: return null
        val client = clients[deviceId] ?: return null
        if (client.connId != connId) return null
        return client
    }

    // ─── Keystore ────────────────────────────────────────────

    private fun loadOrCreateKeyStore(keyStoreFile: File): KeyStore {
        if (keyStoreFile.exists()) {
            val ks = KeyStore.getInstance("PKCS12")
            keyStoreFile.inputStream().use { ks.load(it, KEYSTORE_PASSWORD.toCharArray()) }
            Log.i(TAG, "Loaded existing keystore from filesDir")
            return ks
        }
        try {
            assets.open("keystore/$KEYSTORE_FILE").use { stream ->
                val ks = KeyStore.getInstance("PKCS12")
                ks.load(stream, KEYSTORE_PASSWORD.toCharArray())
                keyStoreFile.parentFile?.mkdirs()
                keyStoreFile.outputStream().use { out ->
                    ks.store(out, KEYSTORE_PASSWORD.toCharArray())
                }
                Log.i(TAG, "Loaded pre-built keystore from assets")
                return ks
            }
        } catch (e: Exception) {
            Log.w(TAG, "No pre-built keystore in assets, generating: ${e.message}")
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

    // ─── Data classes ────────────────────────────────────────

    private data class ConnectedClient(
        var connId: String,
        val deviceId: String,
        val deviceType: String,
        val roomId: String,
        var label: String,
        var ip: String? = null,
        val sources: MutableList<MediaSource> = mutableListOf(),
        val subscriptions: MutableList<String> = mutableListOf(),
        var connectedAt: Long,
        var lastHeartbeat: Long = System.currentTimeMillis(),
        var capabilities: DeviceCapabilities? = null
    )

    private data class DeviceCapabilities(
        val videoDevices: JSONArray,
        val audioDevices: JSONArray,
        val audioOutputDevices: JSONArray = JSONArray()
    )

    /**
     * A recorded announcement awaiting playback (plan 18). Deliberately a
     * plain class, not a data class — a data class holding a ByteArray gets
     * identity-based equals/hashCode, which is a trap nobody needs here.
     */
    private class Clip(
        val id: String,
        val from: String,
        val label: String,
        val bytes: ByteArray,
        val durationMs: Int,
        val createdAt: Long
    )

    companion object {
        private const val TAG = "HearthSignaling"
        private const val KEYSTORE_ALIAS = "hearthconnect"
        private const val KEYSTORE_PASSWORD = "changeme"
        private const val KEYSTORE_FILE = "hearthconnect.p12"
        private const val RECENT_SEEN_WINDOW = 24 * 60 * 60 * 1000L // 24 hours
        private val VALID_SOURCE_TYPES = setOf("video+audio", "video-only", "audio-only", "none")
        private val BASE_TYPES = setOf("base", "room")

        // Broadcast clip bounds (plan 18). MAX_BYTES is ~60s of 16kHz mono
        // 16-bit PCM, which is the cap the base station records to.
        const val CLIP_MAX_BYTES = 2 * 1024 * 1024
        private const val CLIP_TTL_MS = 5 * 60 * 1000L
        private const val CLIP_MAX_COUNT = 20

        private fun defaultConfig(type: String): JSONObject {
            return when (type) {
                "kiosk", "room" -> JSONObject().apply {
                    put("camera", "front")
                    put("resolution", "720p")
                    put("frameRate", 30)
                    put("nightMode", false)
                    put("torch", false)
                    put("micSensitivity", 0.8)
                    put("speakerVolume", 0.5)
                    put("twoWayAudioEnabled", true)
                    put("showFeed", false)
                    put("keepAwake", true)
                    put("displayMode", "blank")
                    put("audioMode", "mute")
                    put("broadcastDisabled", false)
                }
                "base" -> JSONObject().apply {
                    put("visibleSources", JSONArray())
                    put("audioFocusMode", "manual")
                    put("gridLayout", "1x1")
                    put("idleTimeout", 0)
                }
                else -> JSONObject()
            }
        }
    }

    /** Callback interface for SignalingServer → HubService event forwarding. */
    interface ServerEventListener {
        fun onDoorbell(fromDeviceId: String, label: String)
    }
}

 private suspend fun ApplicationCall.serveFromAssets(assets: AssetManager, assetPath: String) {
     try {
         assets.open(assetPath).use { stream ->
             val bytes = stream.readBytes()
             // Disable caching so iOS Safari always picks up new client builds
             // (otherwise it serves a stale base-station.js and "fixes" never
             // reach the device). Dev-only hub; the production path is the Node server.
             response.headers.append("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
             response.headers.append("Pragma", "no-cache")
             response.headers.append("Expires", "0")
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

/**
 * Read an upload bounded to [max] bytes. Unlike `InputStream.readBytes()`,
 * which on a malformed/oversized request would buffer the whole body into
 * memory, this stops at [max] and discards the rest. The clip upload cap is
 * generous (2 MB ≈ 60s) but we must never let a runaway request OOM the hub.
 */
private fun java.io.InputStream.readBounded(max: Int): ByteArray {
    val buf = java.io.ByteArrayOutputStream(minOf(max, 8192).coerceAtLeast(1024))
    val chunk = ByteArray(8192)
    var total = 0
    while (total < max) {
        val n = read(chunk, 0, minOf(chunk.size, max - total))
        if (n < 0) break
        buf.write(chunk, 0, n)
        total += n
    }
    // Drain anything beyond the cap so the connection can close cleanly.
    if (total >= max) {
        val sink = ByteArray(8192)
        while (read(sink) >= 0) { /* discard */ }
    }
    return buf.toByteArray()
}
