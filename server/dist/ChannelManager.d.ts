import { ConnectedClient, MediaSourceInfo, DeviceType, SourceType, Transport } from './types';
export interface RecentlySeenDevice {
    id: string;
    label: string;
    type: DeviceType;
    lastSeenAt: number;
    online: boolean;
    config?: Record<string, unknown>;
}
export declare class ChannelManager {
    private rooms;
    private clients;
    private recentlySeenDevices;
    private readonly RECENT_SEEN_WINDOW;
    private transports;
    registerTransport(transport: Transport): void;
    unregisterTransport(connId: string): void;
    getTransport(connId: string): Transport | undefined;
    sendToConn(connId: string, message: object): void;
    addClient(connId: string, deviceId: string, deviceType: DeviceType, roomId: string, label: string): ConnectedClient;
    removeClientByConn(connId: string): ConnectedClient | null;
    getClient(deviceId: string): ConnectedClient | undefined;
    getClientByConnId(connId: string): ConnectedClient | undefined;
    getAllClients(): Map<string, ConnectedClient>;
    getClientsInRoom(roomId: string): ConnectedClient[];
    getClientsByType(roomId: string, type: DeviceType): ConnectedClient[];
    getBasesInRoom(roomId: string): ConnectedClient[];
    getPrimaryBase(roomId: string): ConnectedClient | undefined;
    isPrimaryBase(deviceId: string, roomId: string): boolean;
    isClientInRoom(deviceId: string, roomId: string): boolean;
    addSource(deviceId: string, sourceId: string, label: string, type: SourceType): MediaSourceInfo | null;
    removeSource(deviceId: string, sourceId: string): MediaSourceInfo | null;
    getActiveSources(roomId: string): MediaSourceInfo[];
    startDisconnectTimer(deviceId: string, callback: () => void, ms?: number): void;
    cancelDisconnectTimer(deviceId: string): void;
    getRecentlySeenDevices(): RecentlySeenDevice[];
    updateRecentlySeenLabel(deviceId: string, label: string): void;
    removeRecentlySeen(deviceId: string): void;
    getCapabilities(deviceId: string): import('./types').DeviceCapabilities | undefined;
    setCapabilities(deviceId: string, capabilities: import('./types').DeviceCapabilities): void;
    clearRecentlySeen(): void;
    updateHeartbeat(deviceId: string): void;
    broadcastToRoom(roomId: string, message: object, excludeDeviceId?: string): void;
    broadcastToType(type: DeviceType, message: object, excludeDeviceId?: string): void;
    sendTo(deviceId: string, message: object): void;
    broadcastAll(message: object, excludeDeviceId?: string): void;
}
//# sourceMappingURL=ChannelManager.d.ts.map