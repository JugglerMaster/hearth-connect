import * as fs from 'fs';
import * as path from 'path';
import {
  DeviceRecord,
  RoomRecord,
  PresetRecord,
  PairingToken,
  DeviceConfig,
  DeviceType,
} from './types';

interface StoreSchema {
  version: number;
  rooms: Record<string, RoomRecord>;
  devices: Record<string, DeviceRecord>;
}

export class ConfigManager {
  private data: StoreSchema;
  private filePath: string;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
    this.startAutoSave();
  }

  // ─── Storage ────────────────────────────────────────────

  private load(): StoreSchema {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as StoreSchema;
    } catch {
      return { version: 1, rooms: {}, devices: {} };
    }
  }

  private startAutoSave(): void {
    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.flush();
      }
    }, 5_000);
  }

  flush(): void {
    if (!this.dirty) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  dispose(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.flush();
  }

  // ─── Rooms ──────────────────────────────────────────────

  getRoom(roomId: string): RoomRecord | undefined {
    return this.data.rooms[roomId];
  }

  createRoom(id: string, label: string): RoomRecord {
    const room: RoomRecord = {
      id,
      label,
      createdAt: Date.now(),
      presets: [],
      pairingTokens: [],
    };
    this.data.rooms[id] = room;
    this.markDirty();
    return room;
  }

  deleteRoom(roomId: string): void {
    delete this.data.rooms[roomId];
    this.markDirty();
  }

  addPreset(roomId: string, preset: PresetRecord): void {
    const room = this.data.rooms[roomId];
    if (room) {
      room.presets.push(preset);
      this.markDirty();
    }
  }

  removePreset(roomId: string, presetId: string): void {
    const room = this.data.rooms[roomId];
    if (room) {
      room.presets = room.presets.filter(p => p.id !== presetId);
      this.markDirty();
    }
  }

  // ─── Pairing Tokens ─────────────────────────────────────

  addPairingToken(roomId: string, token: PairingToken): void {
    const room = this.data.rooms[roomId];
    if (room) {
      room.pairingTokens.push(token);
      this.markDirty();
    }
  }

  consumePairingToken(token: string): RoomRecord | null {
    for (const room of Object.values(this.data.rooms)) {
      const found = room.pairingTokens.find(
        t => t.token === token && !t.used && t.expiresAt > Date.now()
      );
      if (found) {
        found.used = true;
        this.markDirty();
        return room;
      }
    }
    return null;
  }

  // ─── Devices ────────────────────────────────────────────

  getDevice(id: string): DeviceRecord | undefined {
    return this.data.devices[id];
  }

  getDevicesByRoom(roomId: string): DeviceRecord[] {
    return Object.values(this.data.devices).filter(d => d.roomId === roomId);
  }

  getDevicesByType(roomId: string, type: DeviceType): DeviceRecord[] {
    return this.getDevicesByRoom(roomId).filter(d => d.type === type);
  }

  createDevice(
    id: string,
    type: DeviceType,
    label: string,
    roomId: string,
    pairingToken?: string
  ): DeviceRecord {
    const existing = this.getDevice(id);
    if (existing) return existing;

    const device: DeviceRecord = {
      id,
      type,
      label,
      roomId,
      pairingToken,
      createdAt: Date.now(),
      lastSeenAt: null,
      config: this.defaultConfig(type),
    };
    this.data.devices[id] = device;
    this.markDirty();
    return device;
  }

  updateDevice(id: string, updates: Partial<DeviceRecord>): void {
    const device = this.data.devices[id];
    if (device) {
      Object.assign(device, updates);
      this.markDirty();
    }
  }

  updateDeviceConfig(id: string, config: Partial<DeviceConfig>): DeviceConfig {
    const device = this.data.devices[id];
    if (!device) throw new Error(`Device not found: ${id}`);
    device.config = { ...device.config, ...config };
    this.markDirty();
    return device.config;
  }

  getDeviceConfig(id: string): DeviceConfig | undefined {
    return this.data.devices[id]?.config;
  }

  deleteDevice(id: string): void {
    delete this.data.devices[id];
    this.markDirty();
  }

  // ─── Defaults ───────────────────────────────────────────

  private defaultConfig(type: DeviceType): DeviceConfig {
    const common = { label: '' };
    switch (type) {
      case 'kiosk':
        return {
          ...common,
          camera: 'rear',
          resolution: '720p',
          frameRate: 24,
          nightMode: false,
          torch: false,
          micSensitivity: 0.8,
          speakerVolume: 0.5,
          twoWayAudioEnabled: true,
          showFeed: false,
          keepAwake: true,
        };
      case 'base':
        return {
          ...common,
          visibleSources: [],
          audioFocusMode: 'manual',
          gridLayout: '1x1',
          idleTimeout: 0,
        };
    }
  }
}
