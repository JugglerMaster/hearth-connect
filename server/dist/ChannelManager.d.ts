import WebSocket from 'ws';
import { ConnectedClient, MediaSourceInfo, DeviceType, SourceType } from './types';
export declare class ChannelManager {
    private rooms;
    private clients;
    private wsMap;
    addClient(ws: WebSocket, deviceId: string, deviceType: DeviceType, roomId: string, label: string): ConnectedClient;
    removeClient(ws: WebSocket): ConnectedClient | null;
    getClient(deviceId: string): ConnectedClient | undefined;
    getClientByWs(ws: WebSocket): ConnectedClient | undefined;
    getClientsInRoom(roomId: string): ConnectedClient[];
    getClientsByType(roomId: string, type: DeviceType): ConnectedClient[];
    isClientInRoom(deviceId: string, roomId: string): boolean;
    addSource(deviceId: string, sourceId: string, label: string, type: SourceType): MediaSourceInfo | null;
    removeSource(deviceId: string, sourceId: string): MediaSourceInfo | null;
    getActiveSources(roomId: string): MediaSourceInfo[];
    startDisconnectTimer(deviceId: string, callback: () => void, ms?: number): void;
    cancelDisconnectTimer(deviceId: string): void;
    updateHeartbeat(deviceId: string): void;
    broadcastToRoom(roomId: string, message: object, excludeDeviceId?: string): void;
    sendTo(deviceId: string, message: object): void;
}
//# sourceMappingURL=ChannelManager.d.ts.map