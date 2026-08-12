export type DeviceType = 'kiosk' | 'base' | 'room';
export type SourceType = 'video+audio' | 'video-only' | 'audio-only' | 'none';
export type AudioFocusMode = 'manual' | 'last-active';
export type DisplayMode = 'self' | 'blank' | 'base';
export type AudioMode = 'self' | 'mute' | 'base';
export interface DeviceConfig {
    camera?: 'front' | 'rear';
    resolution?: '480p' | '720p' | '1080p';
    frameRate?: 15 | 24 | 30;
    nightMode?: boolean;
    torch?: boolean;
    micSensitivity?: number;
    speakerVolume?: number;
    twoWayAudioEnabled?: boolean;
    showFeed?: boolean;
    keepAwake?: boolean;
    label?: string;
    videoDevice?: string;
    audioDevice?: string;
    audioAlertEnabled?: boolean;
    audioAlertThresholdDb?: number;
    audioAlertHysteresisDb?: number;
    visibleSources?: string[];
    audioFocusMode?: AudioFocusMode;
    gridLayout?: '1x1' | '2x2';
    idleTimeout?: number;
    displayMode?: DisplayMode;
    audioMode?: AudioMode;
    broadcastDisabled?: boolean;
    broadcastSourceId?: string;
    isBroadcasting?: boolean;
}
export interface MediaDeviceDescriptor {
    id: string;
    label: string;
    facingMode?: 'user' | 'environment' | null;
}
export interface DeviceCapabilities {
    videoDevices: MediaDeviceDescriptor[];
    audioDevices: MediaDeviceDescriptor[];
    audioOutputDevices?: MediaDeviceDescriptor[];
}
export interface DeviceRecord {
    id: string;
    type: DeviceType;
    label: string;
    roomId: string;
    pairingToken?: string;
    createdAt: number;
    lastSeenAt: number | null;
    config: DeviceConfig;
}
export interface DeviceState {
    connected: boolean;
    streams: MediaSourceInfo[];
    connectedAt: number | null;
}
export interface RoomRecord {
    id: string;
    label: string;
    createdAt: number;
    presets: PresetRecord[];
    pairingTokens: PairingToken[];
}
export interface PairingToken {
    token: string;
    expiresAt: number;
    used: boolean;
}
export interface PresetRecord {
    id: string;
    name: string;
    config: Partial<DeviceConfig>;
    applyToDeviceTypes: DeviceType[];
    schedule?: {
        startCron: string;
        endCron: string;
        timezone: string;
    };
}
export interface Transport {
    connId: string;
    ip?: string;
    send(msg: object): void;
    close(): void;
}
export interface ConnectedClient {
    connId: string;
    deviceId: string;
    deviceType: DeviceType;
    roomId: string;
    label: string;
    ip?: string;
    sources: MediaSourceInfo[];
    subscriptions: string[];
    connectedAt: number;
    lastHeartbeat: number;
    disconnectTimer?: NodeJS.Timeout;
    capabilities?: DeviceCapabilities;
}
export interface MediaSourceInfo {
    id: string;
    publisherId: string;
    label: string;
    type: SourceType;
    status: 'live' | 'idle';
    targetDeviceId?: string;
}
/**
 * A recorded "Broadcast Message" announcement (plan 18).
 *
 * The base station records the announcement locally and uploads it once; the
 * server hands every endpoint a URL instead of negotiating a peer connection.
 * Always 16kHz mono 16-bit PCM WAV — the only format iOS Safari, GStreamer and
 * Sonos can all play.
 */
export interface ClipInfo {
    id: string;
    /** Device id of the base station that recorded it. */
    from: string;
    /** Human label for the sender, shown/logged by endpoints. */
    label: string;
    /** When set, only this device plays the clip. Undefined means all. */
    targetDeviceId?: string;
    bytes: Buffer;
    durationMs: number;
    createdAt: number;
}
export type MessageType = 'JOIN_ROOM' | 'LEAVE_ROOM' | 'PAIR_DEVICE' | 'PUBLISH_SOURCE' | 'UNPUBLISH_SOURCE' | 'SUBSCRIBE_SOURCE' | 'UNSUBSCRIBE_SOURCE' | 'BROADCAST_SOURCE' | 'UNBROADCAST_SOURCE' | 'SUBSCRIBE_BROADCAST' | 'UNSUBSCRIBE_BROADCAST' | 'BROADCAST_CLIP' | 'OFFER' | 'ANSWER' | 'ICE_CANDIDATE' | 'ICE_RESTART' | 'RENEGOTIATE' | 'SET_CONFIG' | 'GET_CONFIG' | 'HEARTBEAT' | 'REQUEST_TALK' | 'STOP_TALK' | 'WELCOME' | 'ERROR' | 'SOURCE_ADDED' | 'SOURCE_REMOVED' | 'PLAY_CLIP' | 'SUBSCRIBER_JOINED' | 'SUBSCRIBER_LEFT' | 'CONFIG_UPDATED' | 'CONFIG_RESULT' | 'DEVICE_STATUS' | 'ROOM_STATE' | 'TALK_ENABLED' | 'TALK_DISABLED' | 'CAPABILITIES' | 'AUDIO_PEAK' | 'REMOVE_DEVICE' | 'DEVICE_REMOVED' | 'DOORBELL' | 'CALL_STATE' | 'SET_DISPLAY_CONFIG' | 'DISPLAY_CONFIG_APPLIED' | 'PRIMARY_BASE_CHANGED' | 'SESSION_KICKED';
export interface Message {
    type: MessageType;
    payload: Record<string, unknown>;
    id?: string;
}
//# sourceMappingURL=types.d.ts.map