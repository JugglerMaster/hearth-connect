import WebSocket from 'ws';
import {
  ConnectedClient,
  MediaSourceInfo,
  DeviceType,
  SourceType,
} from './types';

export class ChannelManager {
  // roomId → Map<deviceId, ConnectedClient>
  private rooms = new Map<string, Map<string, ConnectedClient>>();
  // deviceId → ConnectedClient (global lookup)
  private clients = new Map<string, ConnectedClient>();
  // ws → deviceId (reverse lookup for disconnect handling)
  private wsMap = new Map<WebSocket, string>();

  // ─── Client Lifecycle ───────────────────────────────────

  addClient(
    ws: WebSocket,
    deviceId: string,
    deviceType: DeviceType,
    roomId: string,
    label: string
  ): ConnectedClient {
    const client: ConnectedClient = {
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
    this.rooms.get(roomId)!.set(deviceId, client);

    return client;
  }

  removeClient(ws: WebSocket): ConnectedClient | null {
    const deviceId = this.wsMap.get(ws);
    if (!deviceId) return null;

    const client = this.clients.get(deviceId);
    if (!client) return null;

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

    return client;
  }

  getClient(deviceId: string): ConnectedClient | undefined {
    return this.clients.get(deviceId);
  }

  getClientByWs(ws: WebSocket): ConnectedClient | undefined {
    const deviceId = this.wsMap.get(ws);
    if (!deviceId) return undefined;
    return this.clients.get(deviceId);
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
    const data = JSON.stringify(message);
    for (const client of clients) {
      if (client.deviceId === excludeDeviceId) continue;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  sendTo(deviceId: string, message: object): void {
    const client = this.clients.get(deviceId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }
}
