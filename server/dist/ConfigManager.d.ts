import { DeviceRecord, RoomRecord, PresetRecord, PairingToken, DeviceConfig, DeviceType } from './types';
export declare class ConfigManager {
    private data;
    private filePath;
    private dirty;
    private saveTimer;
    constructor(filePath: string);
    private load;
    private startAutoSave;
    flush(): void;
    private markDirty;
    dispose(): void;
    getRoom(roomId: string): RoomRecord | undefined;
    createRoom(id: string, label: string): RoomRecord;
    deleteRoom(roomId: string): void;
    addPreset(roomId: string, preset: PresetRecord): void;
    removePreset(roomId: string, presetId: string): void;
    addPairingToken(roomId: string, token: PairingToken): void;
    consumePairingToken(token: string): RoomRecord | null;
    getDevice(id: string): DeviceRecord | undefined;
    getDevicesByRoom(roomId: string): DeviceRecord[];
    getDevicesByType(roomId: string, type: DeviceType): DeviceRecord[];
    createDevice(id: string, type: DeviceType, label: string, roomId: string, pairingToken?: string, legacyIOS?: boolean): DeviceRecord;
    updateDevice(id: string, updates: Partial<DeviceRecord>): void;
    updateDeviceConfig(id: string, config: Partial<DeviceConfig>): DeviceConfig;
    getDeviceConfig(id: string): DeviceConfig | undefined;
    deleteDevice(id: string): void;
    private defaultConfig;
}
//# sourceMappingURL=ConfigManager.d.ts.map