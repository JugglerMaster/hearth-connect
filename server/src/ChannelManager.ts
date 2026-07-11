import {
  ConnectedClient,
  MediaSourceInfo,
  DeviceType,
  SourceType,
  Transport,
  DisplayMode,
  AudioMode,
} from './types';

export interface RecentlySeenDevice {
  id: string;
  label: string;
  type: DeviceType;
  lastSeenAt: number;
  online: boolean;
  config?: Record<string, unknown>;
}

export class ChannelManager {
  // roomId → Map<deviceId, ConnectedClient>
  private rooms = new Map<string, Map<string, ConnectedClient>>();
  // deviceId → ConnectedClient (global lookup)
  private clients = new Map<string, ConnectedClient>();
  // Recently seen devices (resets on server restart)
  private recentlySeenDevices = new Map<string, RecentlySeenDevice>();
  private readonly RECENT_SEEN_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

  // Active transports (WebSocket or SSE), keyed by connection id
  private transports = new Map<string, Transport>();

  registerTransport(transport: Transport): void {
    this.transports.set(transport.connId, transport);
  }

  unregisterTransport(connId: string): void {
    this.transports.delete(connId);
  }

  getTransport(connId: string): Transport | undefined {
    return this.transports.get(connId);
  }

  sendToConn(connId: string, message: object): void {
    const t = this.transports.get(connId);
    if (t) t.send(message);
  }

  // ─── Client Lifecycle ───────────────────────────────────

  addClient(
    connId: string,
    deviceId: string,
    deviceType: DeviceType,
    roomId: string,
    label: string
  ): ConnectedClient {
    const client: ConnectedClient = {
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
    this.rooms.get(roomId)!.set(deviceId, client);

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

  removeClientByConn(connId: string): ConnectedClient | null {
    // Find the client owning this connId
    let client: ConnectedClient | undefined;
    for (const c of this.clients.values()) {
      if (c.connId === connId) { client = c; break; }
    }
    if (!client) return null;

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

  getClient(deviceId: string): ConnectedClient | undefined {
    return this.clients.get(deviceId);
  }

  getClientByConnId(connId: string): ConnectedClient | undefined {
    for (const c of this.clients.values()) {
      if (c.connId === connId) return c;
    }
    return undefined;
  }

  getAllClients(): Map<string, ConnectedClient> {
    return this.clients;
  }

  // ─── Room Queries ───────────────────────────────────────

  getClientsInRoom(roomId: string): ConnectedClient[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.values());
  }

  getClientsByType(roomId: string, type: DeviceType): ConnectedClient[] {
    return this.getClientsInRoom(roomId).filter(c => c.deviceType === type);
  }

  getBasesInRoom(roomId: string): ConnectedClient[] {
    return this.getClientsByType(roomId, 'base');
  }

  getPrimaryBase(roomId: string): ConnectedClient | undefined {
    const bases = this.getBasesInRoom(roomId);
    if (bases.length === 0) return undefined;
    // Primary = first base to join (earliest connectedAt)
    return bases.reduce((earliest, b) => b.connectedAt < earliest.connectedAt ? b : earliest);
  }

  isPrimaryBase(deviceId: string, roomId: string): boolean {
    const primary = this.getPrimaryBase(roomId);
    return primary?.deviceId === deviceId;
  }

  isClientInRoom(deviceId: string, roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.has(deviceId);
  }

  // ─── Sources ────────────────────────────────────────────

  addSource(
    deviceId: string,
    sourceId: string,
    label: string,
    type: SourceType
  ): MediaSourceInfo | null {
    const client = this.clients.get(deviceId);
    if (!client) return null;

    // Update an existing source in place if the id already exists (e.g. media set changed)
    const existing = client.sources.find(s => s.id === sourceId);
    if (existing) {
      existing.type = type;
      existing.label = label;
      existing.status = 'live';
      return existing;
    }

    const source: MediaSourceInfo = {
      id: sourceId,
      publisherId: deviceId,
      label,
      type,
      status: 'live',
    };

    client.sources.push(source);
    return source;
  }

  removeSource(deviceId: string, sourceId: string): MediaSourceInfo | null {
    const client = this.clients.get(deviceId);
    if (!client) return null;

    const idx = client.sources.findIndex(s => s.id === sourceId);
    if (idx === -1) return null;

    const [removed] = client.sources.splice(idx, 1);
    return removed;
  }

  getActiveSources(roomId: string): MediaSourceInfo[] {
    return this.getClientsInRoom(roomId).flatMap(c => c.sources);
  }

  // ─── Grace Period (60s offline grace) ───────────────────

  startDisconnectTimer(
    deviceId: string,
    callback: () => void,
    ms = 60_000
  ): void {
    const client = this.clients.get(deviceId);
    if (!client) return;
    client.disconnectTimer = setTimeout(callback, ms);
  }

  cancelDisconnectTimer(deviceId: string): void {
    const client = this.clients.get(deviceId);
    if (client?.disconnectTimer) {
      clearTimeout(client.disconnectTimer);
      client.disconnectTimer = undefined;
    }
  }

  // ─── Recently Seen Devices ──────────────────────────────

  getRecentlySeenDevices(): RecentlySeenDevice[] {
    const now = Date.now();
    const result: RecentlySeenDevice[] = [];
    for (const device of this.recentlySeenDevices.values()) {
      if (now - device.lastSeenAt <= this.RECENT_SEEN_WINDOW) {
        result.push(device);
      }
    }
    return result;
  }

  updateRecentlySeenLabel(deviceId: string, label: string): void {
    const entry = this.recentlySeenDevices.get(deviceId);
    if (entry) {
      entry.label = label;
    }
  }

  removeRecentlySeen(deviceId: string): void {
    this.recentlySeenDevices.delete(deviceId);
  }

  getCapabilities(deviceId: string): import('./types').DeviceCapabilities | undefined {
    return this.clients.get(deviceId)?.capabilities;
  }

  setCapabilities(deviceId: string, capabilities: import('./types').DeviceCapabilities): void {
    const client = this.clients.get(deviceId);
    if (client) {
      client.capabilities = capabilities;
    }
  }

  clearRecentlySeen(): void {
    this.recentlySeenDevices.clear();
  }

  // ─── Heartbeat ──────────────────────────────────────────

  updateHeartbeat(deviceId: string): void {
    const client = this.clients.get(deviceId);
    if (client) {
      client.lastHeartbeat = Date.now();
    }
  }

  // ─── Broadcast helpers ──────────────────────────────────

  broadcastToRoom(
    roomId: string,
    message: object,
    excludeDeviceId?: string
  ): void {
    const clients = this.getClientsInRoom(roomId);
    for (const client of clients) {
      if (client.deviceId === excludeDeviceId) continue;
      this.sendToConn(client.connId, message);
    }
  }

  // Broadcast to all connected clients of a given device type (e.g. every base).
  broadcastToType(
    type: DeviceType,
    message: object,
    excludeDeviceId?: string
  ): void {
    for (const client of this.clients.values()) {
      if (client.deviceType !== type) continue;
      if (client.deviceId === excludeDeviceId) continue;
      this.sendToConn(client.connId, message);
    }
  }

  sendTo(deviceId: string, message: object): void {
    const client = this.clients.get(deviceId);
    if (client) this.sendToConn(client.connId, message);
  }

  broadcastAll(message: object, excludeDeviceId?: string): void {
    for (const client of this.clients.values()) {
      if (client.deviceId === excludeDeviceId) continue;
      this.sendToConn(client.connId, message);
    }
  }
}
