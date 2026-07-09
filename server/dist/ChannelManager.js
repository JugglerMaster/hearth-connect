"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelManager = void 0;
const ws_1 = __importDefault(require("ws"));
class ChannelManager {
    constructor() {
        // roomId → Map<deviceId, ConnectedClient>
        this.rooms = new Map();
        // deviceId → ConnectedClient (global lookup)
        this.clients = new Map();
        // ws → deviceId (reverse lookup for disconnect handling)
        this.wsMap = new Map();
        // Recently seen devices (resets on server restart)
        this.recentlySeenDevices = new Map();
        this.RECENT_SEEN_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
    }
    // ─── Client Lifecycle ───────────────────────────────────
    addClient(ws, deviceId, deviceType, roomId, label) {
        const client = {
            ws,
            deviceId,
            deviceType,
            roomId,
            label,
            sources: [],
            connectedAt: Date.now(),
            lastHeartbeat: Date.now(),
        };
        this.clients.set(deviceId, client);
        this.wsMap.set(ws, deviceId);
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, new Map());
        }
        this.rooms.get(roomId).set(deviceId, client);
        // Track in recently seen
        this.recentlySeenDevices.set(deviceId, {
            id: deviceId,
            label,
            type: deviceType,
            lastSeenAt: Date.now(),
            online: true,
        });
        // Prune stale entries: if same device type joins with a new ID,
        // remove old offline entries of that type to avoid duplicates
        for (const [id, entry] of this.recentlySeenDevices.entries()) {
            if (id !== deviceId && entry.type === deviceType && !entry.online) {
                this.recentlySeenDevices.delete(id);
                console.log(`Pruned stale device ${id} (${entry.label}) — replaced by ${deviceId}`);
            }
        }
        return client;
    }
    removeClient(ws) {
        const deviceId = this.wsMap.get(ws);
        if (!deviceId)
            return null;
        const client = this.clients.get(deviceId);
        if (!client)
            return null;
        const room = this.rooms.get(client.roomId);
        if (room) {
            room.delete(deviceId);
            if (room.size === 0) {
                this.rooms.delete(client.roomId);
            }
        }
        if (client.disconnectTimer) {
            clearTimeout(client.disconnectTimer);
        }
        this.clients.delete(deviceId);
        this.wsMap.delete(ws);
        // Mark as offline in recently seen
        const seen = this.recentlySeenDevices.get(deviceId);
        if (seen) {
            seen.online = false;
            seen.lastSeenAt = Date.now();
        }
        return client;
    }
    getClient(deviceId) {
        return this.clients.get(deviceId);
    }
    getClientByWs(ws) {
        const deviceId = this.wsMap.get(ws);
        if (!deviceId)
            return undefined;
        return this.clients.get(deviceId);
    }
    // ─── Room Queries ───────────────────────────────────────
    getClientsInRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return [];
        return Array.from(room.values());
    }
    getClientsByType(roomId, type) {
        return this.getClientsInRoom(roomId).filter(c => c.deviceType === type);
    }
    isClientInRoom(deviceId, roomId) {
        const room = this.rooms.get(roomId);
        if (!room)
            return false;
        return room.has(deviceId);
    }
    // ─── Sources ────────────────────────────────────────────
    addSource(deviceId, sourceId, label, type) {
        const client = this.clients.get(deviceId);
        if (!client)
            return null;
        const source = {
            id: sourceId,
            publisherId: deviceId,
            label,
            type,
            status: 'live',
        };
        client.sources.push(source);
        return source;
    }
    removeSource(deviceId, sourceId) {
        const client = this.clients.get(deviceId);
        if (!client)
            return null;
        const idx = client.sources.findIndex(s => s.id === sourceId);
        if (idx === -1)
            return null;
        const [removed] = client.sources.splice(idx, 1);
        return removed;
    }
    getActiveSources(roomId) {
        return this.getClientsInRoom(roomId).flatMap(c => c.sources);
    }
    // ─── Grace Period (60s offline grace) ───────────────────
    startDisconnectTimer(deviceId, callback, ms = 60000) {
        const client = this.clients.get(deviceId);
        if (!client)
            return;
        client.disconnectTimer = setTimeout(callback, ms);
    }
    cancelDisconnectTimer(deviceId) {
        const client = this.clients.get(deviceId);
        if (client?.disconnectTimer) {
            clearTimeout(client.disconnectTimer);
            client.disconnectTimer = undefined;
        }
    }
    // ─── Recently Seen Devices ──────────────────────────────
    getRecentlySeenDevices() {
        const now = Date.now();
        const result = [];
        for (const device of this.recentlySeenDevices.values()) {
            if (now - device.lastSeenAt <= this.RECENT_SEEN_WINDOW) {
                result.push(device);
            }
        }
        return result;
    }
    updateRecentlySeenLabel(deviceId, label) {
        const entry = this.recentlySeenDevices.get(deviceId);
        if (entry) {
            entry.label = label;
        }
    }
    clearRecentlySeen() {
        this.recentlySeenDevices.clear();
    }
    // ─── Heartbeat ──────────────────────────────────────────
    updateHeartbeat(deviceId) {
        const client = this.clients.get(deviceId);
        if (client) {
            client.lastHeartbeat = Date.now();
        }
    }
    // ─── Broadcast helpers ──────────────────────────────────
    broadcastToRoom(roomId, message, excludeDeviceId) {
        const clients = this.getClientsInRoom(roomId);
        const data = JSON.stringify(message);
        for (const client of clients) {
            if (client.deviceId === excludeDeviceId)
                continue;
            if (client.ws.readyState === ws_1.default.OPEN) {
                client.ws.send(data);
            }
        }
    }
    sendTo(deviceId, message) {
        const client = this.clients.get(deviceId);
        if (client && client.ws.readyState === ws_1.default.OPEN) {
            client.ws.send(JSON.stringify(message));
        }
    }
    broadcastAll(message, excludeDeviceId) {
        const data = JSON.stringify(message);
        for (const client of this.clients.values()) {
            if (client.deviceId === excludeDeviceId)
                continue;
            if (client.ws.readyState === ws_1.default.OPEN) {
                client.ws.send(data);
            }
        }
    }
}
exports.ChannelManager = ChannelManager;
//# sourceMappingURL=ChannelManager.js.map