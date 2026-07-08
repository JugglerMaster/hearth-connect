import type WebSocket from 'ws';

// ─── Device & Room types ────────────────────────────────────

export type DeviceType = 'camera' | 'base' | 'viewer';
export type SourceType = 'video+audio' | 'audio-only';
export type AudioFocusMode = 'manual' | 'last-active';

export interface DeviceConfig {
  // Camera
  camera?: 'front' | 'rear';
  resolution?: '480p' | '720p' | '1080p';
  frameRate?: 15 | 24 | 30;
  nightMode?: boolean;
  torch?: boolean;
  micSensitivity?: number;
  speakerVolume?: number;
  twoWayAudioEnabled?: boolean;
  streamEnabled?: boolean;
  keepAwake?: boolean;
  label?: string;

  // Base station
  visibleSources?: string[];
  audioFocusMode?: AudioFocusMode;
  gridLayout?: '1x1' | '2x2';
  idleTimeout?: number;

  // Viewer
  allowedSources?: string[];
  defaultSource?: string | null;
  audioAutoPlay?: boolean;
  talkbackEnabled?: boolean;
  pin?: string | null;
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

export interface ConnectedClient {
  ws: WebSocket;
  deviceId: string;
  deviceType: DeviceType;
  roomId: string;
  label: string;
  sources: MediaSourceInfo[];
  connectedAt: number;
  lastHeartbeat: number;
  disconnectTimer?: NodeJS.Timeout;
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
  | 'OFFER'
  | 'ANSWER'
  | 'ICE_CANDIDATE'
  | 'ICE_RESTART'
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
  | 'TALK_DISABLED';

export interface Message {
  type: MessageType;
  payload: Record<string, unknown>;
  id?: string;
}
