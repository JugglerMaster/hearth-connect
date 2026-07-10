"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelManager = void 0;
class ChannelManager {
    constructor() {
        // roomId → Map<deviceId, ConnectedClient>
        this.rooms = new Map();
        // deviceId → ConnectedClient (global lookup)
        this.clients = new Map();
        // Recently seen devices (resets on server restart)
        this.recentlySeenDevices = new Map();
        this.RECENT_SEEN_WINDOW = 24 * 60 * 60 * 1000; // 24 hours
        // Active transports (WebSocket or SSE), keyed by connection id
        this.transports = new Map();
    }
    registerTransport(transport) {
        this.transports.set(transport.connId, transport);
    }
    unregisterTransport(connId) {
        this.transports.delete(connId);
    }
    getTransport(connId) {
        return this.transports.get(connId);
    }
    sendToConn(connId, message) {
        const t = this.transports.get(connId);
        if (t)
            t.send(message);
    }
    // ─── Client Lifecycle ───────────────────────────────────
    addClient(connId, deviceId, deviceType, roomId, label) {
        const client = {
            connId,
            deviceId,
            deviceType,
            roomId,
            label,
            sources: [],
            connectedAt: Date.now(),
            lastHeartbeat: Date.now(),
        };
        this.clients.set(deviceId, client);
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
    removeClientByConn(connId) {
        // Find the client owning this connId
        let client;
        for (const c of this.clients.values()) {
            if (c.connId === connId) {
                client = c;
                break;
            }
        }
        if (!client)
            return null;
        const deviceId = client.deviceId;
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
        // Mark as offline in recently seen
        const seen = this.recentlySeenDevices.get(deviceId);
        if (seen) {
            seen.online = false;
            seen.lastSeenAt = Date.now();
        }
        this.unregisterTransport(connId);
        return client;
    }
    getClient(deviceId) {
        return this.clients.get(deviceId);
    }
    getClientByConnId(connId) {
        for (const c of this.clients.values()) {
            if (c.connId === connId)
                return c;
        }
        return undefined;
    }
    getAllClients() {
        return this.clients;
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
        // Update an existing source in place if the id already exists (e.g. media set changed)
        const existing = client.sources.find(s => s.id === sourceId);
        if (existing) {
            existing.type = type;
            existing.label = label;
            existing.status = 'live';
            return existing;
        }
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
    removeRecentlySeen(deviceId) {
        this.recentlySeenDevices.delete(deviceId);
    }
    getCapabilities(deviceId) {
        return this.clients.get(deviceId)?.capabilities;
    }
    setCapabilities(deviceId, capabilities) {
        const client = this.clients.get(deviceId);
        if (client) {
            client.capabilities = capabilities;
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
        for (const client of clients) {
            if (client.deviceId === excludeDeviceId)
                continue;
            this.sendToConn(client.connId, message);
        }
    }
    sendTo(deviceId, message) {
        const client = this.clients.get(deviceId);
        if (client)
            this.sendToConn(client.connId, message);
    }
    broadcastAll(message, excludeDeviceId) {
        for (const client of this.clients.values()) {
            if (client.deviceId === excludeDeviceId)
                continue;
            this.sendToConn(client.connId, message);
        }
    }
}
exports.ChannelManager = ChannelManager;
//# sourceMappingURL=ChannelManager.js.map