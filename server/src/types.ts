

// ─── Device & Room types ────────────────────────────────────

export type DeviceType = 'kiosk' | 'base';
export type SourceType = 'video+audio' | 'video-only' | 'audio-only' | 'none';
export type AudioFocusMode = 'manual' | 'last-active';
export type DisplayMode = 'self' | 'blank' | 'base';
export type AudioMode = 'self' | 'mute' | 'base';

export interface DeviceConfig {
  // Kiosk
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

  // Media device selection (browser deviceId or Pi V4L2/ALSA path)
  videoDevice?: string;
  audioDevice?: string;

  // Audio threshold alerting
  audioAlertEnabled?: boolean;
  audioAlertThresholdDb?: number;
  audioAlertHysteresisDb?: number;

  // Base station
  visibleSources?: string[];
  audioFocusMode?: AudioFocusMode;
  gridLayout?: '1x1' | '2x2';
  idleTimeout?: number;

  // Kiosk display/audio control (set by base station)
  displayMode?: DisplayMode;
  audioMode?: AudioMode;

  // When true the kiosk will not receive system broadcasts ("Broadcast Message").
  broadcastDisabled?: boolean;

  // Base station broadcast
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

// ─── Room types ──────────────────────────────────────────────

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

// ─── Runtime (in-memory) types ──────────────────────────────

// ─── Transport abstraction ──────────────────────────────────────
// A Transport carries signaling messages to one connected client. It is
// implemented over WebSocket (modern clients) or over Server-Sent Events
// (legacy iOS 12, whose WebSocket stack is unreliable — close code 1006).
export interface Transport {
  connId: string;
  send(msg: object): void;
  close(): void;
}

export interface ConnectedClient {
  connId: string;
  deviceId: string;
  deviceType: DeviceType;
  roomId: string;
  label: string;
  sources: MediaSourceInfo[];
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
}

// ─── WebSocket message types ─────────────────────────────────

export type MessageType =
  | 'JOIN_ROOM'
  | 'LEAVE_ROOM'
  | 'PAIR_DEVICE'
  | 'PUBLISH_SOURCE'
  | 'UNPUBLISH_SOURCE'
  | 'SUBSCRIBE_SOURCE'
  | 'UNSUBSCRIBE_SOURCE'
  | 'BROADCAST_SOURCE'
  | 'UNBROADCAST_SOURCE'
  | 'SUBSCRIBE_BROADCAST'
  | 'UNSUBSCRIBE_BROADCAST'
  | 'OFFER'
  | 'ANSWER'
  | 'ICE_CANDIDATE'
  | 'ICE_RESTART'
  | 'RENEGOTIATE'
  | 'SET_CONFIG'
  | 'GET_CONFIG'
  | 'HEARTBEAT'
  | 'REQUEST_TALK'
  | 'STOP_TALK'
  | 'WELCOME'
  | 'ERROR'
  | 'SOURCE_ADDED'
  | 'SOURCE_REMOVED'
  | 'SUBSCRIBER_JOINED'
  | 'SUBSCRIBER_LEFT'
  | 'CONFIG_UPDATED'
  | 'CONFIG_RESULT'
  | 'DEVICE_STATUS'
  | 'ROOM_STATE'
  | 'TALK_ENABLED'
  | 'TALK_DISABLED'
  | 'CAPABILITIES'
  | 'AUDIO_PEAK'
  | 'REMOVE_DEVICE'
  | 'DEVICE_REMOVED'
  | 'DOORBELL'
  | 'CALL_STATE'
  | 'SET_DISPLAY_CONFIG'
  | 'DISPLAY_CONFIG_APPLIED'
  | 'PRIMARY_BASE_CHANGED';

export interface Message {
  type: MessageType;
  payload: Record<string, unknown>;
  id?: string;
}
