"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignalingHandler = void 0;
const ws_1 = __importDefault(require("ws"));
class SignalingHandler {
    constructor(channels, config) {
        this.channels = channels;
        this.config = config;
    }
    handle(ws, raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            this.sendError(ws, 'INVALID_JSON', 'Malformed message');
            return;
        }
        try {
            this.route(ws, msg);
        }
        catch (err) {
            console.error('Handler error:', err);
            this.sendError(ws, 'INTERNAL_ERROR', 'Unexpected server error');
        }
    }
    handleDisconnect(ws) {
        const client = this.channels.getClientByWs(ws);
        if (!client)
            return;
        const { deviceId, roomId, deviceType, sources } = client;
        console.log(`Device disconnected: ${deviceId} (${deviceType})`);
        // Start 60s grace period before removing sources
        this.channels.startDisconnectTimer(deviceId, () => {
            // Notify room that sources are removed
            for (const source of sources) {
                this.channels.broadcastToRoom(roomId, {
                    type: 'SOURCE_REMOVED',
                    payload: { sourceId: source.id },
                }, deviceId);
            }
            // Remove from in-memory state
            this.channels.removeClient(ws);
            // Mark device offline in config
            this.config.updateDevice(deviceId, { lastSeenAt: Date.now() });
            this.channels.broadcastToRoom(roomId, {
                type: 'DEVICE_STATUS',
                payload: { deviceId, status: 'offline' },
            });
        });
    }
    route(ws, msg) {
        switch (msg.type) {
            case 'HEARTBEAT':
                this.handleHeartbeat(ws);
                break;
            case 'JOIN_ROOM':
                this.handleJoinRoom(ws, msg.payload);
                break;
            case 'LEAVE_ROOM':
                this.handleLeaveRoom(ws);
                break;
            case 'PAIR_DEVICE':
                this.handlePairDevice(ws, msg.payload);
                break;
            case 'PUBLISH_SOURCE':
                this.handlePublishSource(ws, msg.payload);
                break;
            case 'UNPUBLISH_SOURCE':
                this.handleUnpublishSource(ws, msg.payload);
                break;
            case 'SUBSCRIBE_SOURCE':
                this.handleSubscribeSource(ws, msg.payload);
                break;
            case 'UNSUBSCRIBE_SOURCE':
                this.handleUnsubscribeSource(ws, msg.payload);
                break;
            case 'OFFER':
                this.handleRelay(ws, msg, 'OFFER');
                break;
            case 'ANSWER':
                this.handleRelay(ws, msg, 'ANSWER');
                break;
            case 'ICE_CANDIDATE':
                this.handleRelay(ws, msg, 'ICE_CANDIDATE');
                break;
            case 'ICE_RESTART':
                this.handleRelay(ws, msg, 'ICE_RESTART');
                break;
            case 'SET_CONFIG':
                this.handleSetConfig(ws, msg.payload);
                break;
            case 'GET_CONFIG':
                this.handleGetConfig(ws);
                break;
            case 'REQUEST_TALK':
                this.handleRequestTalk(ws, msg.payload);
                break;
            case 'STOP_TALK':
                this.handleStopTalk(ws, msg.payload);
                break;
            default:
                this.sendError(ws, 'UNKNOWN_TYPE', `Unknown message type: ${msg.type}`);
        }
    }
    sendError(ws, code, message) {
        this.send(ws, { type: 'ERROR', payload: { code, message } });
    }
    send(ws, msg) {
        if (ws.readyState === ws_1.default.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
    // ─── Handlers ───────────────────────────────────────────
    handleHeartbeat(ws) {
        const client = this.channels.getClientByWs(ws);
        if (client) {
            this.channels.updateHeartbeat(client.deviceId);
        }
        this.send(ws, { type: 'HEARTBEAT', payload: {} });
    }
    handleJoinRoom(ws, payload) {
        const roomId = payload.roomId;
        const deviceId = payload.deviceId;
        const deviceType = payload.deviceType;
        const label = payload.label || deviceId;
        // Validate
        if (!roomId || !deviceId || !deviceType) {
            this.sendError(ws, 'INVALID_PARAMS', 'roomId, deviceId, and deviceType required');
            return;
        }
        const validTypes = ['camera', 'base', 'viewer'];
        if (!validTypes.includes(deviceType)) {
            this.sendError(ws, 'INVALID_TYPE', `deviceType must be one of: ${validTypes.join(', ')}`);
            return;
        }
        // Ensure room exists
        if (!this.config.getRoom(roomId)) {
            this.config.createRoom(roomId, roomId);
        }
        // Ensure device exists in config
        let device = this.config.getDevice(deviceId);
        if (!device) {
            device = this.config.createDevice(deviceId, deviceType, label, roomId);
        }
        // Cancel any grace-period disconnect timer
        this.channels.cancelDisconnectTimer(deviceId);
        // Add to in-memory state (may already exist if reconnecting within grace period)
        const existingClient = this.channels.getClient(deviceId);
        if (existingClient) {
            // Update the WS reference for reconnecting client
            this.channels.removeClient(existingClient.ws);
        }
        const client = this.channels.addClient(ws, deviceId, deviceType, roomId, label);
        this.config.updateDevice(deviceId, { lastSeenAt: Date.now() });
        // Send current state to the joining client
        const activeSources = this.channels.getActiveSources(roomId);
        this.send(ws, {
            type: 'WELCOME',
            payload: {
                deviceId,
                roomId,
                config: device.config,
                sources: activeSources,
            },
        });
        // Notify others in room
        this.channels.broadcastToRoom(roomId, {
            type: 'DEVICE_STATUS',
            payload: { deviceId, status: 'online' },
        }, deviceId);
        console.log(`Device joined: ${deviceId} (${deviceType}) in room ${roomId}`);
    }
    handleLeaveRoom(ws) {
        const client = this.channels.getClientByWs(ws);
        if (!client)
            return;
        const { deviceId, roomId } = client;
        // Remove sources
        for (const source of client.sources) {
            this.channels.broadcastToRoom(roomId, {
                type: 'SOURCE_REMOVED',
                payload: { sourceId: source.id },
            }, deviceId);
        }
        this.channels.removeClient(ws);
        this.channels.broadcastToRoom(roomId, {
            type: 'DEVICE_STATUS',
            payload: { deviceId, status: 'offline' },
        });
    }
    handlePairDevice(ws, payload) {
        const token = payload.token;
        const deviceType = payload.deviceType;
        const label = payload.label || 'Unnamed Device';
        if (!token || !deviceType) {
            this.sendError(ws, 'INVALID_PARAMS', 'token and deviceType required');
            return;
        }
        const room = this.config.consumePairingToken(token);
        if (!room) {
            this.sendError(ws, 'INVALID_TOKEN', 'Token invalid or expired');
            return;
        }
        // Generate a device ID
        const deviceId = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const device = this.config.createDevice(deviceId, deviceType, label, room.id, token);
        this.send(ws, {
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
    handlePublishSource(ws, payload) {
        const client = this.channels.getClientByWs(ws);
        if (!client) {
            this.sendError(ws, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        if (client.deviceType !== 'camera' && client.deviceType !== 'base') {
            this.sendError(ws, 'NOT_ALLOWED', 'Only cameras and base stations can publish');
            return;
        }
        const sourceId = payload.sourceId;
        const label = payload.label || 'Camera';
        const type = payload.type || 'video+audio';
        if (!sourceId) {
            this.sendError(ws, 'INVALID_PARAMS', 'sourceId required');
            return;
        }
        const source = this.channels.addSource(client.deviceId, sourceId, label, type);
        if (!source) {
            this.sendError(ws, 'INTERNAL_ERROR', 'Failed to add source');
            return;
        }
        // Notify all other clients in the room
        this.channels.broadcastToRoom(client.roomId, {
            type: 'SOURCE_ADDED',
            payload: source,
        }, client.deviceId);
        console.log(`Source published: ${sourceId} by ${client.deviceId}`);
    }
    handleUnpublishSource(ws, payload) {
        const client = this.channels.getClientByWs(ws);
        if (!client)
            return;
        const sourceId = payload.sourceId;
        if (!sourceId)
            return;
        const removed = this.channels.removeSource(client.deviceId, sourceId);
        if (removed) {
            this.channels.broadcastToRoom(client.roomId, {
                type: 'SOURCE_REMOVED',
                payload: { sourceId },
            }, client.deviceId);
        }
    }
    handleSubscribeSource(ws, payload) {
        const client = this.channels.getClientByWs(ws);
        if (!client) {
            this.sendError(ws, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        const publisherId = payload.publisherId;
        if (!publisherId)
            return;
        const publisher = this.channels.getClient(publisherId);
        if (!publisher || publisher.roomId !== client.roomId) {
            this.sendError(ws, 'NOT_FOUND', 'Publisher not found in this room');
            return;
        }
        // Notify publisher that a new subscriber wants their stream
        this.channels.sendTo(publisherId, {
            type: 'SUBSCRIBER_JOINED',
            payload: { subscriberId: client.deviceId },
        });
        console.log(`Subscriber ${client.deviceId} subscribed to ${publisherId}`);
    }
    handleUnsubscribeSource(ws, payload) {
        const client = this.channels.getClientByWs(ws);
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
    handleRelay(ws, msg, originalType) {
        const client = this.channels.getClientByWs(ws);
        if (!client) {
            this.sendError(ws, 'NOT_IN_ROOM', 'Join a room first');
            return;
        }
        const targetId = msg.payload.to;
        if (!targetId) {
            this.sendError(ws, 'INVALID_PARAMS', 'Target device ID required');
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
    handleSetConfig(ws, payload) {
        const client = this.channels.getClientByWs(ws);
        if (!client)
            return;
        // Only base stations can push config
        if (client.deviceType !== 'base') {
            this.sendError(ws, 'NOT_ALLOWED', 'Only base stations can push configuration');
            return;
        }
        const targetDeviceId = payload.targetDeviceId;
        const config = payload.config;
        if (!targetDeviceId || !config) {
            this.sendError(ws, 'INVALID_PARAMS', 'targetDeviceId and config required');
            return;
        }
        const targetDevice = this.config.getDevice(targetDeviceId);
        if (!targetDevice) {
            this.sendError(ws, 'NOT_FOUND', 'Target device not found');
            return;
        }
        // Persist the config
        try {
            this.config.updateDeviceConfig(targetDeviceId, config);
        }
        catch (err) {
            this.sendError(ws, 'CONFIG_ERROR', 'Failed to save config');
            return;
        }
        // Push config to target if connected
        const targetClient = this.channels.getClient(targetDeviceId);
        if (targetClient) {
            this.channels.sendTo(targetDeviceId, {
                type: 'CONFIG_UPDATED',
                payload: { config: this.config.getDeviceConfig(targetDeviceId) },
            });
            this.send(ws, {
                type: 'CONFIG_RESULT',
                payload: { targetDeviceId, ok: true },
            });
        }
        else {
            // Device offline — config queued, will be applied on reconnect
            this.send(ws, {
                type: 'CONFIG_RESULT',
                payload: { targetDeviceId, ok: true, offline: true },
            });
        }
        console.log(`Config updated for ${targetDeviceId} by ${client.deviceId}`);
    }
    handleGetConfig(ws) {
        const client = this.channels.getClientByWs(ws);
        if (!client)
            return;
        const config = this.config.getDeviceConfig(client.deviceId);
        this.send(ws, {
            type: 'CONFIG_UPDATED',
            payload: { config },
        });
    }
    handleRequestTalk(ws, payload) {
        const client = this.channels.getClientByWs(ws);
        if (!client)
            return;
        const targetPublisherId = payload.targetPublisherId;
        if (!targetPublisherId)
            return;
        const targetConfig = this.config.getDeviceConfig(targetPublisherId);
        if (!targetConfig?.twoWayAudioEnabled) {
            this.sendError(ws, 'TALK_DISABLED', 'Two-way audio is disabled on the target device');
            return;
        }
        // Notify the target publisher to enable their talkback speaker
        this.channels.sendTo(targetPublisherId, {
            type: 'TALK_ENABLED',
            payload: { from: client.deviceId },
        });
    }
    handleStopTalk(ws, payload) {
        const client = this.channels.getClientByWs(ws);
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