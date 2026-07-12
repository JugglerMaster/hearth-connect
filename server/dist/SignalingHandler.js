"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalingHandler = void 0;
class SignalingHandler {
    constructor(channels, config) {
        this.channels = channels;
        this.config = config;
    }
    handle(transport, raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            this.sendError(transport, 'INVALID_JSON', 'Malformed message');
            return;
        }
        // Get device context for logging
        const client = this.channels.getClientByConnId(transport.connId);
        const ctx = client ? `${client.deviceId}@${client.roomId}` : 'unauthenticated';
        if (msg.type !== 'AUDIO_PEAK') {
            console.log(`[SIGNAL] ${msg.type} from ${ctx}`);
        }
        try {
            this.route(transport, msg);
        }
        catch (err) {
            console.error('Handler error:', err);
            this.sendError(transport, 'INTERNAL_ERROR', 'Unexpected server error');
        }
    }
    handleDisconnect(transport) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client) {
            this.channels.unregisterTransport(transport.connId);
            return;
        }
        const { deviceId, deviceType, sources } = client;
        console.log(`Device disconnected: ${deviceId} (${deviceType})`);
        // Start 60s grace period before removing sources
        this.channels.startDisconnectTimer(deviceId, () => {
            // Notify all clients that sources are removed
            for (const source of sources) {
                this.channels.broadcastAll({
                    type: 'SOURCE_REMOVED',
                    payload: { sourceId: source.id },
                }, deviceId);
            }
            // Remove from in-memory state
            this.channels.removeClientByConn(transport.connId);
            // Mark device offline in config
            this.config.updateDevice(deviceId, { lastSeenAt: Date.now() });
            this.channels.broadcastAll({
                type: 'DEVICE_STATUS',
                payload: { deviceId, status: 'offline' },
            });
        });
    }
    route(transport, msg) {
        switch (msg.type) {
            case 'HEARTBEAT':
                this.handleHeartbeat(transport);
                break;
            case 'JOIN_ROOM':
                this.handleJoinRoom(transport, msg.payload);
                break;
            case 'LEAVE_ROOM':
                this.handleLeaveRoom(transport);
                break;
            case 'PAIR_DEVICE':
                this.handlePairDevice(transport, msg.payload);
                break;
            case 'PUBLISH_SOURCE':
                this.handlePublishSource(transport, msg.payload);
                break;
            case 'UNPUBLISH_SOURCE':
                this.handleUnpublishSource(transport, msg.payload);
                break;
            case 'SUBSCRIBE_SOURCE':
                this.handleSubscribeSource(transport, msg.payload);
                break;
            case 'UNSUBSCRIBE_SOURCE':
                this.handleUnsubscribeSource(transport, msg.payload);
                break;
            case 'BROADCAST_SOURCE':
                this.handleBroadcastSource(transport, msg.payload);
                break;
            case 'UNBROADCAST_SOURCE':
                this.handleUnbroadcastSource(transport, msg.payload);
                break;
            case 'SUBSCRIBE_BROADCAST':
                this.handleSubscribeBroadcast(transport, msg.payload);
                break;
            case 'UNSUBSCRIBE_BROADCAST':
                this.handleUnsubscribeBroadcast(transport, msg.payload);
                break;
            case 'OFFER':
                this.handleRelay(transport, msg, 'OFFER');
                break;
            case 'ANSWER':
                this.handleRelay(transport, msg, 'ANSWER');
                break;
            case 'ICE_CANDIDATE':
                this.handleRelay(transport, msg, 'ICE_CANDIDATE');
                break;
            case 'ICE_RESTART':
                this.handleRelay(transport, msg, 'ICE_RESTART');
                break;
            case 'RENEGOTIATE':
                this.handleRelay(transport, msg, 'RENEGOTIATE');
                break;
            case 'SET_CONFIG':
                this.handleSetConfig(transport, msg.payload);
                break;
            case 'GET_CONFIG':
                this.handleGetConfig(transport, msg.payload);
                break;
            case 'SET_DISPLAY_CONFIG':
                this.handleSetDisplayConfig(transport, msg.payload);
                break;
            case 'REQUEST_TALK':
                this.handleRequestTalk(transport, msg.payload);
                break;
            case 'STOP_TALK':
                this.handleStopTalk(transport, msg.payload);
                break;
            case 'CAPABILITIES':
                this.handleCapabilities(transport, msg.payload);
                break;
            case 'AUDIO_PEAK':
                this.handleAudioPeak(transport, msg.payload);
                break;
            case 'REMOVE_DEVICE':
                this.handleRemoveDevice(transport, msg.payload);
                break;
            case 'DOORBELL':
                this.handleDoorbell(transport, msg.payload);
                break;
            case 'CALL_STATE':
                this.handleCallState(transport, msg.payload);
                break;
            default:
                this.sendError(transport, 'UNKNOWN_TYPE', `Unknown message type: ${msg.type}`);
        }
    }
    sendError(transport, code, message) {
        this.send(transport, { type: 'ERROR', payload: { code, message } });
    }
    send(transport, msg) {
        transport.send(msg);
    }
    // ─── Handlers ───────────────────────────────────────────
    handleHeartbeat(transport) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (client) {
            this.channels.updateHeartbeat(client.deviceId);
        }
        this.send(transport, { type: 'HEARTBEAT', payload: {} });
    }
    handleJoinRoom(transport, payload) {
        const deviceId = payload.deviceId;
        const deviceType = payload.deviceType;
        const label = payload.label || deviceId;
        const legacyIOS = !!payload.legacyIOS;
        const roomId = 'default'; // Single-room mode
        // Validate
        if (!deviceId || !deviceType) {
            this.sendError(transport, 'INVALID_PARAMS', 'deviceId and deviceType required');
            return;
        }
        const validTypes = ['kiosk', 'base'];
        if (!validTypes.includes(deviceType)) {
            this.sendError(transport, 'INVALID_TYPE', `deviceType must be one of: ${validTypes.join(', ')}`);
            return;
        }
        // Ensure device exists in config
        let device = this.config.getDevice(deviceId);
        if (!device) {
            device = this.config.createDevice(deviceId, deviceType, label, roomId, undefined, legacyIOS);
        }
        // Use config label if set (overrides the join-time label)
        const effectiveLabel = (device.config?.label && device.config.label.trim()) ? device.config.label : label;
        // Cancel any grace-period disconnect timer
        this.channels.cancelDisconnectTimer(deviceId);
        // Add to in-memory state (may already exist if reconnecting within grace period)
        const existingClient = this.channels.getClient(deviceId);
        if (existingClient) {
            // Remove the previous connection for a reconnecting client
            this.channels.removeClientByConn(existingClient.connId);
        }
        const client = this.channels.addClient(transport.connId, deviceId, deviceType, roomId, effectiveLabel);
        this.config.updateDevice(deviceId, { lastSeenAt: Date.now() });
        // Send current state to the joining client
        const activeSources = this.channels.getActiveSources(roomId);
        // Enrich recentlySeenDevices with stored config so the base station's
        // config panel shows the actual device defaults instead of hardcoded values.
        const recentlySeenDevices = this.channels.getRecentlySeenDevices().map(d => ({
            ...d,
            config: this.config.getDeviceConfig(d.id),
        }));
        this.send(transport, {
            type: 'WELCOME',
            payload: {
                deviceId,
                roomId,
                config: device.config,
                sources: activeSources,
                recentlySeenDevices,
            },
        });
        // Notify all clients
        this.channels.broadcastAll({
            type: 'DEVICE_STATUS',
            payload: {
                deviceId,
                status: 'online',
                type: deviceType,
                label: effectiveLabel,
                lastSeenAt: Date.now(),
                config: device.config,
            },
        }, deviceId);
        // Send capabilities of already-connected devices to this new joiner (so a late-joining
        // base station immediately sees source pickers without waiting for a re-report)
        for (const [otherId, otherClient] of this.channels.getAllClients()) {
            if (otherId === deviceId)
                continue;
            if (otherClient.capabilities) {
                this.send(transport, {
                    type: 'CAPABILITIES',
                    payload: {
                        deviceId: otherId,
                        videoDevices: otherClient.capabilities.videoDevices,
                        audioDevices: otherClient.capabilities.audioDevices,
                    },
                });
            }
        }
        console.log(`Device joined: ${deviceId} (${deviceType}) as label="${effectiveLabel}"`);
    }
    handleLeaveRoom(transport) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const { deviceId } = client;
        // Notify all clients that sources are removed
        for (const source of client.sources) {
            this.channels.broadcastAll({
                type: 'SOURCE_REMOVED',
                payload: { sourceId: source.id },
            }, deviceId);
        }
        this.channels.removeClientByConn(transport.connId);
        this.channels.broadcastAll({
            type: 'DEVICE_STATUS',
            payload: { deviceId, status: 'offline' },
        });
    }
    handlePairDevice(transport, payload) {
        const token = payload.token;
        const deviceType = payload.deviceType;
        const label = payload.label || 'Unnamed Device';
        if (!token || !deviceType) {
            this.sendError(transport, 'INVALID_PARAMS', 'token and deviceType required');
            return;
        }
        const room = this.config.consumePairingToken(token);
        if (!room) {
            this.sendError(transport, 'INVALID_TOKEN', 'Token invalid or expired');
            return;
        }
        // Generate a device ID
        const deviceId = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const device = this.config.createDevice(deviceId, deviceType, label, room.id, token);
        this.send(transport, {
            type: 'WELCOME',
            payload: {
                deviceId: device.id,
                roomId: room.id,
                config: device.config,
                sources: [],
            },
        });
        console.log(`Device paired: ${deviceId} (${deviceType}) in room ${room.id}`);
    }
    handlePublishSource(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client) {
            this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        if (client.deviceType !== 'kiosk' && client.deviceType !== 'base') {
            this.sendError(transport, 'NOT_ALLOWED', 'Only cameras and base stations can publish');
            return;
        }
        const sourceId = payload.sourceId;
        const label = payload.label || 'Camera';
        const rawType = payload.type || 'video+audio';
        const validTypes = ['video+audio', 'video-only', 'audio-only', 'none'];
        const type = validTypes.includes(rawType)
            ? rawType
            : 'video+audio';
        if (!sourceId) {
            this.sendError(transport, 'INVALID_PARAMS', 'sourceId required');
            return;
        }
        const source = this.channels.addSource(client.deviceId, sourceId, label, type);
        if (!source) {
            this.sendError(transport, 'INTERNAL_ERROR', 'Failed to add source');
            return;
        }
        // Notify all clients (cross-room source visibility)
        this.channels.broadcastAll({
            type: 'SOURCE_ADDED',
            payload: source,
        }, client.deviceId);
        console.log(`Source published: ${sourceId} by ${client.deviceId}`);
    }
    handleUnpublishSource(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const sourceId = payload.sourceId;
        if (!sourceId)
            return;
        const removed = this.channels.removeSource(client.deviceId, sourceId);
        if (removed) {
            this.channels.broadcastAll({
                type: 'SOURCE_REMOVED',
                payload: { sourceId },
            }, client.deviceId);
        }
    }
    handleSubscribeSource(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client) {
            this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        const publisherId = payload.publisherId;
        if (!publisherId)
            return;
        const publisher = this.channels.getClient(publisherId);
        if (!publisher) {
            this.sendError(transport, 'NOT_FOUND', 'Publisher not found');
            return;
        }
        console.log(`Cross-room subscribe: ${client.deviceId}@${client.roomId} → ${publisherId}@${publisher.roomId}`);
        // Notify publisher that a new subscriber wants their stream
        this.channels.sendTo(publisherId, {
            type: 'SUBSCRIBER_JOINED',
            payload: { subscriberId: client.deviceId },
        });
        console.log(`Subscriber ${client.deviceId} subscribed to ${publisherId}`);
    }
    handleUnsubscribeSource(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const publisherId = payload.publisherId;
        if (!publisherId)
            return;
        this.channels.sendTo(publisherId, {
            type: 'SUBSCRIBER_LEFT',
            payload: { subscriberId: client.deviceId },
        });
    }
    // ─── Broadcast Source Handlers ──────────────────────────────
    handleBroadcastSource(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client) {
            this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        if (client.deviceType !== 'base') {
            this.sendError(transport, 'NOT_ALLOWED', 'Only base stations can broadcast');
            return;
        }
        const sourceId = payload.sourceId;
        const label = payload.label || 'Base Station Broadcast';
        const rawType = payload.type || 'video+audio';
        const validTypes = ['video+audio', 'video-only', 'audio-only', 'none'];
        const type = validTypes.includes(rawType) ? rawType : 'video+audio';
        if (!sourceId) {
            this.sendError(transport, 'INVALID_PARAMS', 'sourceId required');
            return;
        }
        const source = this.channels.addSource(client.deviceId, sourceId, label, type);
        if (!source) {
            this.sendError(transport, 'INTERNAL_ERROR', 'Failed to add broadcast source');
            return;
        }
        // Mark as broadcast source
        source.isBroadcast = true;
        // Notify all clients (kiosks and other bases)
        this.channels.broadcastAll({
            type: 'SOURCE_ADDED',
            payload: source,
        });
        // Update base config to track broadcast
        this.config.updateDeviceConfig(client.deviceId, {
            broadcastSourceId: sourceId,
            isBroadcasting: true,
        });
        console.log(`Broadcast source published: ${sourceId} by ${client.deviceId}`);
    }
    handleUnbroadcastSource(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const sourceId = payload.sourceId;
        if (!sourceId)
            return;
        const removed = this.channels.removeSource(client.deviceId, sourceId);
        if (removed) {
            this.channels.broadcastAll({
                type: 'SOURCE_REMOVED',
                payload: { sourceId },
            });
            this.config.updateDeviceConfig(client.deviceId, {
                broadcastSourceId: undefined,
                isBroadcasting: false,
            });
        }
    }
    handleSubscribeBroadcast(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client) {
            this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        if (client.deviceType !== 'kiosk') {
            this.sendError(transport, 'NOT_ALLOWED', 'Only kiosks can subscribe to broadcasts');
            return;
        }
        const publisherId = payload.publisherId;
        if (!publisherId)
            return;
        const publisher = this.channels.getClient(publisherId);
        if (!publisher) {
            this.sendError(transport, 'NOT_FOUND', 'Publisher not found');
            return;
        }
        // Authoritative guard: a kiosk with system broadcasts disabled must not
        // receive "Broadcast Message" announcements, even if its client ignores
        // the source. Re-check the stored device config (which the base sets).
        const subscriber = this.config.getDevice(client.deviceId);
        if (subscriber && subscriber.config && subscriber.config.broadcastDisabled === true) {
            console.log(`Kiosk ${client.deviceId} has broadcasts disabled — denying subscribe`);
            return;
        }
        // Notify publisher that a new subscriber wants their broadcast stream
        this.channels.sendTo(publisherId, {
            type: 'SUBSCRIBER_JOINED',
            payload: { subscriberId: client.deviceId, isBroadcast: true },
        });
        console.log(`Kiosk ${client.deviceId} subscribed to broadcast from ${publisherId}`);
    }
    handleUnsubscribeBroadcast(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const publisherId = payload.publisherId;
        if (!publisherId)
            return;
        this.channels.sendTo(publisherId, {
            type: 'SUBSCRIBER_LEFT',
            payload: { subscriberId: client.deviceId, isBroadcast: true },
        });
    }
    // ─── Display Config Handler ─────────────────────────────────
    handleSetDisplayConfig(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        if (client.deviceType !== 'base') {
            this.sendError(transport, 'NOT_ALLOWED', 'Only base stations can set display config');
            return;
        }
        const targetDeviceId = payload.targetDeviceId;
        const displayMode = payload.displayMode;
        const audioMode = payload.audioMode;
        if (!targetDeviceId || !displayMode || !audioMode) {
            this.sendError(transport, 'INVALID_PARAMS', 'targetDeviceId, displayMode, audioMode required');
            return;
        }
        const targetDevice = this.config.getDevice(targetDeviceId);
        if (!targetDevice) {
            this.sendError(transport, 'NOT_FOUND', 'Target device not found');
            return;
        }
        if (targetDevice.type !== 'kiosk') {
            this.sendError(transport, 'INVALID_TARGET', 'Display config can only be set on kiosks');
            return;
        }
        // Persist config
        this.config.updateDeviceConfig(targetDeviceId, { displayMode, audioMode });
        // Push to target kiosk if connected
        const targetClient = this.channels.getClient(targetDeviceId);
        if (targetClient) {
            this.channels.sendTo(targetDeviceId, {
                type: 'SET_DISPLAY_CONFIG',
                payload: { displayMode, audioMode },
            });
        }
        // Acknowledge to requesting base
        this.send(transport, {
            type: 'CONFIG_RESULT',
            payload: { targetDeviceId, ok: true, config: { displayMode, audioMode } },
        });
        console.log(`Display config set for ${targetDeviceId}: display=${displayMode}, audio=${audioMode}`);
    }
    handleCapabilities(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const videoDevices = payload.videoDevices || [];
        const audioDevices = payload.audioDevices || [];
        const capabilities = { videoDevices, audioDevices };
        this.channels.setCapabilities(client.deviceId, capabilities);
        // Relay to all other clients (base stations render source pickers from this)
        this.channels.broadcastAll({
            type: 'CAPABILITIES',
            payload: { deviceId: client.deviceId, videoDevices, audioDevices },
        }, client.deviceId);
        console.log(`Capabilities reported: ${client.deviceId} (${videoDevices.length}v ${audioDevices.length}a)`);
    }
    handleAudioPeak(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        // Relay the peak notification to all other clients (no storage needed)
        this.channels.broadcastAll({
            type: 'AUDIO_PEAK',
            payload: {
                deviceId: client.deviceId,
                levelDb: payload.levelDb,
                peak: payload.peak,
                ts: payload.ts ?? Date.now(),
            },
        }, client.deviceId);
    }
    handleRemoveDevice(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        // Only base stations can remove devices
        if (client.deviceType !== 'base') {
            this.sendError(transport, 'NOT_ALLOWED', 'Only base stations can remove devices');
            return;
        }
        const targetDeviceId = payload.targetDeviceId;
        if (!targetDeviceId) {
            this.sendError(transport, 'INVALID_PARAMS', 'targetDeviceId required');
            return;
        }
        // If the target is currently connected, close its transport cleanly
        const target = this.channels.getClient(targetDeviceId);
        if (target) {
            const t = this.channels.getTransport(target.connId);
            if (t) {
                try {
                    t.close();
                }
                catch {
                    // ignore close errors
                }
            }
        }
        // Remove from in-memory recently-seen list and persisted config
        this.channels.removeRecentlySeen(targetDeviceId);
        this.config.deleteDevice(targetDeviceId);
        // Notify all clients so every base station drops the row
        this.channels.broadcastAll({
            type: 'DEVICE_REMOVED',
            payload: { deviceId: targetDeviceId },
        });
        console.log(`Device removed: ${targetDeviceId} by ${client.deviceId}`);
    }
    // ─── Doorbell / Call signaling ──────────────────────────
    // A kiosk rings the doorbell; the server relays it to every base station.
    // Bases render an "incoming call" prompt and can answer (which subscribes to
    // the kiosk) or dismiss it. CALL_STATE is sent base→kiosk to let the kiosk
    // reflect the call status (e.g. show "call connected") on its display.
    handleDoorbell(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const label = payload.label || client.label || client.deviceId;
        // Relay to all base stations (not back to the ringer).
        this.channels.broadcastToType('base', {
            type: 'DOORBELL',
            payload: { from: client.deviceId, label, ts: Date.now() },
        }, client.deviceId);
        console.log(`Doorbell rung by ${client.deviceId} (${label})`);
    }
    handleCallState(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const targetId = payload.targetDeviceId;
        if (!targetId)
            return;
        // Forward call state to the target device (typically a kiosk).
        this.channels.sendTo(targetId, {
            type: 'CALL_STATE',
            payload: { from: client.deviceId, state: payload.state, ts: Date.now() },
        });
    }
    handleRelay(transport, msg, originalType) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client) {
            this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        const targetId = msg.payload.to;
        if (!targetId) {
            this.sendError(transport, 'INVALID_PARAMS', 'Target device ID required');
            return;
        }
        // Relay the message to the target, keeping the original type
        this.channels.sendTo(targetId, {
            type: originalType,
            payload: {
                ...msg.payload,
                from: client.deviceId,
            },
            id: msg.id,
        });
    }
    handleSetConfig(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        // Only base stations can push config
        if (client.deviceType !== 'base') {
            this.sendError(transport, 'NOT_ALLOWED', 'Only base stations can push configuration');
            return;
        }
        const targetDeviceId = payload.targetDeviceId;
        const config = payload.config;
        if (!targetDeviceId || !config) {
            this.sendError(transport, 'INVALID_PARAMS', 'targetDeviceId and config required');
            return;
        }
        const targetDevice = this.config.getDevice(targetDeviceId);
        if (!targetDevice) {
            this.sendError(transport, 'NOT_FOUND', 'Target device not found');
            return;
        }
        // Persist the config
        try {
            this.config.updateDeviceConfig(targetDeviceId, config);
        }
        catch (err) {
            this.sendError(transport, 'CONFIG_ERROR', 'Failed to save config');
            return;
        }
        const fullConfig = this.config.getDeviceConfig(targetDeviceId);
        // If label changed, update recentlySeenDevices and DeviceRecord
        if (config.label && typeof config.label === 'string') {
            const targetClientInner = this.channels.getClient(targetDeviceId);
            if (targetClientInner) {
                targetClientInner.label = config.label;
            }
            this.channels.updateRecentlySeenLabel(targetDeviceId, config.label);
            this.config.updateDevice(targetDeviceId, { label: config.label });
        }
        // Broadcast updated device status to all clients (includes full config
        // so every base station's local cache stays in sync).
        this.channels.broadcastAll({
            type: 'DEVICE_STATUS',
            payload: {
                deviceId: targetDeviceId,
                status: 'online',
                type: targetDevice.type,
                label: fullConfig?.label || targetDevice.label,
                config: fullConfig || targetDevice.config,
                lastSeenAt: Date.now(),
            },
        });
        // Push config to target if connected
        const targetClient = this.channels.getClient(targetDeviceId);
        if (targetClient) {
            this.channels.sendTo(targetDeviceId, {
                type: 'CONFIG_UPDATED',
                payload: { config: fullConfig || targetDevice.config },
            });
            this.send(transport, {
                type: 'CONFIG_RESULT',
                payload: { targetDeviceId, ok: true, config: fullConfig || targetDevice.config },
            });
        }
        else {
            // Device offline — config queued, will be applied on reconnect
            this.send(transport, {
                type: 'CONFIG_RESULT',
                payload: { targetDeviceId, ok: true, offline: true, config: fullConfig || targetDevice.config },
            });
        }
        console.log(`Config updated for ${targetDeviceId} by ${client.deviceId}`);
    }
    handleGetConfig(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        // A target may be supplied (e.g. a base station asking for a kiosk's
        // current config). Without a target, return the requester's own config.
        const targetDeviceId = payload?.targetDeviceId || client.deviceId;
        const config = this.config.getDeviceConfig(targetDeviceId);
        this.send(transport, {
            type: 'CONFIG_RESULT',
            payload: { targetDeviceId, config: config || {} },
        });
    }
    handleRequestTalk(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const targetPublisherId = payload.targetPublisherId;
        if (!targetPublisherId)
            return;
        const targetConfig = this.config.getDeviceConfig(targetPublisherId);
        if (!targetConfig?.twoWayAudioEnabled) {
            this.sendError(transport, 'TALK_DISABLED', 'Two-way audio is disabled on the target device');
            return;
        }
        // Notify the target publisher to enable their talkback speaker
        this.channels.sendTo(targetPublisherId, {
            type: 'TALK_ENABLED',
            payload: { from: client.deviceId },
        });
    }
    handleStopTalk(transport, payload) {
        const client = this.channels.getClientByConnId(transport.connId);
        if (!client)
            return;
        const targetPublisherId = payload.targetPublisherId;
        if (!targetPublisherId)
            return;
        this.channels.sendTo(targetPublisherId, {
            type: 'TALK_DISABLED',
            payload: { from: client.deviceId },
        });
    }
}
exports.SignalingHandler = SignalingHandler;
//# sourceMappingURL=SignalingHandler.js.map