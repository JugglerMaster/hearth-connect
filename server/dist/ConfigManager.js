"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class ConfigManager {
    constructor(filePath) {
        this.dirty = false;
        this.saveTimer = null;
        this.filePath = filePath;
        this.data = this.load();
        this.startAutoSave();
    }
    // ─── Storage ────────────────────────────────────────────
    load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return { version: 1, rooms: {}, devices: {} };
        }
    }
    startAutoSave() {
        this.saveTimer = setInterval(() => {
            if (this.dirty) {
                this.flush();
            }
        }, 5000);
    }
    flush() {
        if (!this.dirty)
            return;
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.filePath);
        this.dirty = false;
    }
    markDirty() {
        this.dirty = true;
    }
    dispose() {
        if (this.saveTimer)
            clearInterval(this.saveTimer);
        this.flush();
    }
    // ─── Rooms ──────────────────────────────────────────────
    getRoom(roomId) {
        return this.data.rooms[roomId];
    }
    createRoom(id, label) {
        const room = {
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
    deleteRoom(roomId) {
        delete this.data.rooms[roomId];
        this.markDirty();
    }
    addPreset(roomId, preset) {
        const room = this.data.rooms[roomId];
        if (room) {
            room.presets.push(preset);
            this.markDirty();
        }
    }
    removePreset(roomId, presetId) {
        const room = this.data.rooms[roomId];
        if (room) {
            room.presets = room.presets.filter(p => p.id !== presetId);
            this.markDirty();
        }
    }
    // ─── Pairing Tokens ─────────────────────────────────────
    addPairingToken(roomId, token) {
        const room = this.data.rooms[roomId];
        if (room) {
            room.pairingTokens.push(token);
            this.markDirty();
        }
    }
    consumePairingToken(token) {
        for (const room of Object.values(this.data.rooms)) {
            const found = room.pairingTokens.find(t => t.token === token && !t.used && t.expiresAt > Date.now());
            if (found) {
                found.used = true;
                this.markDirty();
                return room;
            }
        }
        return null;
    }
    // ─── Devices ────────────────────────────────────────────
    getDevice(id) {
        return this.data.devices[id];
    }
    getDevicesByRoom(roomId) {
        return Object.values(this.data.devices).filter(d => d.roomId === roomId);
    }
    getDevicesByType(roomId, type) {
        return this.getDevicesByRoom(roomId).filter(d => d.type === type);
    }
    createDevice(id, type, label, roomId, pairingToken, legacyIOS = false) {
        const existing = this.getDevice(id);
        if (existing)
            return existing;
        const device = {
            id,
            type,
            label,
            roomId,
            pairingToken,
            createdAt: Date.now(),
            lastSeenAt: null,
            config: this.defaultConfig(type, legacyIOS),
        };
        this.data.devices[id] = device;
        this.markDirty();
        return device;
    }
    updateDevice(id, updates) {
        const device = this.data.devices[id];
        if (device) {
            Object.assign(device, updates);
            this.markDirty();
        }
    }
    updateDeviceConfig(id, config) {
        const device = this.data.devices[id];
        if (!device)
            throw new Error(`Device not found: ${id}`);
        device.config = { ...device.config, ...config };
        this.markDirty();
        return device.config;
    }
    getDeviceConfig(id) {
        return this.data.devices[id]?.config;
    }
    deleteDevice(id) {
        delete this.data.devices[id];
        this.markDirty();
    }
    // ─── Defaults ───────────────────────────────────────────
    defaultConfig(type, legacyIOS = false) {
        const common = { label: '' };
        switch (type) {
            case 'kiosk':
                return {
                    ...common,
                    camera: 'front',
                    resolution: legacyIOS ? '480p' : '720p',
                    frameRate: 30,
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
exports.ConfigManager = ConfigManager;
//# sourceMappingURL=ConfigManager.js.map