import { ChannelManager } from './ChannelManager';
import { ConfigManager } from './ConfigManager';
import {
  Message,
  ConnectedClient,
  DeviceType,
  MediaSourceInfo,
  SourceType,
  DeviceCapabilities,
  Transport,
  DisplayMode,
  AudioMode,
} from './types';

export class SignalingHandler {
  constructor(
    private channels: ChannelManager,
    private config: ConfigManager
  ) {}

  handle(transport: Transport, raw: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(raw) as Message;
    } catch {
      this.sendError(transport, 'INVALID_JSON', 'Malformed message');
      return;
    }

    // Get device context for logging
    const client = this.channels.getClientByConnId(transport.connId);
    const ctx = client ? `${client.deviceId}@${client.roomId}` : 'unauthenticated';
    if (msg.type !== 'AUDIO_PEAK') {
      console.log(`[SIGNAL] ${msg.type} from ${ctx}`);
    }

    try {
      this.route(transport, msg);
    } catch (err) {
      console.error('Handler error:', err);
      this.sendError(transport, 'INTERNAL_ERROR', 'Unexpected server error');
    }
  }

  handleDisconnect(transport: Transport): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) {
      this.channels.unregisterTransport(transport.connId);
      return;
    }

    const { deviceId, deviceType, sources } = client;

    console.log(`Device disconnected: ${deviceId} (${deviceType})`);

    // Start 60s grace period before removing sources
    this.channels.startDisconnectTimer(deviceId, () => {
      // Notify all clients that sources are removed
      for (const source of sources) {
        this.channels.broadcastAll({
          type: 'SOURCE_REMOVED',
          payload: { sourceId: source.id },
        }, deviceId);
      }
      // Remove from in-memory state
      this.channels.removeClientByConn(transport.connId);
      // Mark device offline in config
      this.config.updateDevice(deviceId, { lastSeenAt: Date.now() });

      this.channels.broadcastAll({
        type: 'DEVICE_STATUS',
        payload: { deviceId, status: 'offline' },
      });
    });
  }

  private route(transport: Transport, msg: Message): void {
    switch (msg.type) {
      case 'HEARTBEAT':
        this.handleHeartbeat(transport);
        break;
      case 'JOIN_ROOM':
        this.handleJoinRoom(transport, msg.payload);
        break;
      case 'LEAVE_ROOM':
        this.handleLeaveRoom(transport);
        break;
      case 'PAIR_DEVICE':
        this.handlePairDevice(transport, msg.payload);
        break;
      case 'PUBLISH_SOURCE':
        this.handlePublishSource(transport, msg.payload);
        break;
      case 'UNPUBLISH_SOURCE':
        this.handleUnpublishSource(transport, msg.payload);
        break;
      case 'SUBSCRIBE_SOURCE':
        this.handleSubscribeSource(transport, msg.payload);
        break;
      case 'UNSUBSCRIBE_SOURCE':
        this.handleUnsubscribeSource(transport, msg.payload);
        break;
      case 'BROADCAST_SOURCE':
        this.handleBroadcastSource(transport, msg.payload);
        break;
      case 'UNBROADCAST_SOURCE':
        this.handleUnbroadcastSource(transport, msg.payload);
        break;
      case 'SUBSCRIBE_BROADCAST':
        this.handleSubscribeBroadcast(transport, msg.payload);
        break;
      case 'UNSUBSCRIBE_BROADCAST':
        this.handleUnsubscribeBroadcast(transport, msg.payload);
        break;
      case 'OFFER':
        this.handleRelay(transport, msg, 'OFFER');
        break;
      case 'ANSWER':
        this.handleRelay(transport, msg, 'ANSWER');
        break;
      case 'ICE_CANDIDATE':
        this.handleRelay(transport, msg, 'ICE_CANDIDATE');
        break;
      case 'ICE_RESTART':
        this.handleRelay(transport, msg, 'ICE_RESTART');
        break;
      case 'RENEGOTIATE':
        this.handleRelay(transport, msg, 'RENEGOTIATE');
        break;
      case 'SET_CONFIG':
        this.handleSetConfig(transport, msg.payload);
        break;
      case 'GET_CONFIG':
        this.handleGetConfig(transport, msg.payload);
        break;
      case 'SET_DISPLAY_CONFIG':
        this.handleSetDisplayConfig(transport, msg.payload);
        break;
      case 'REQUEST_TALK':
        this.handleRequestTalk(transport, msg.payload);
        break;
      case 'STOP_TALK':
        this.handleStopTalk(transport, msg.payload);
        break;
      case 'CAPABILITIES':
        this.handleCapabilities(transport, msg.payload);
        break;
      case 'AUDIO_PEAK':
        this.handleAudioPeak(transport, msg.payload);
        break;
      case 'REMOVE_DEVICE':
        this.handleRemoveDevice(transport, msg.payload);
        break;
      case 'DOORBELL':
        this.handleDoorbell(transport, msg.payload);
        break;
      case 'CALL_STATE':
        this.handleCallState(transport, msg.payload);
        break;
      default:
        this.sendError(transport, 'UNKNOWN_TYPE', `Unknown message type: ${msg.type}`);
    }
  }

  private sendError(transport: Transport, code: string, message: string): void {
    this.send(transport, { type: 'ERROR', payload: { code, message } });
  }

  private send(transport: Transport, msg: Message): void {
    transport.send(msg);
  }

  // ─── Handlers ───────────────────────────────────────────

  private handleHeartbeat(transport: Transport): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (client) {
      this.channels.updateHeartbeat(client.deviceId);
    }
    this.send(transport, { type: 'HEARTBEAT', payload: {} });
  }

  private handleJoinRoom(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const deviceId = payload.deviceId as string;
    const deviceType = payload.deviceType as DeviceType;
    const label = (payload.label as string) || deviceId;
    const legacyIOS = !!payload.legacyIOS;
    const roomId = 'default'; // Single-room mode

    // Validate
    if (!deviceId || !deviceType) {
      this.sendError(transport, 'INVALID_PARAMS', 'deviceId and deviceType required');
      return;
    }

    const validTypes: DeviceType[] = ['kiosk', 'base'];
    if (!validTypes.includes(deviceType)) {
      this.sendError(transport, 'INVALID_TYPE', `deviceType must be one of: ${validTypes.join(', ')}`);
      return;
    }

    // Ensure device exists in config
    let device = this.config.getDevice(deviceId);
    if (!device) {
      device = this.config.createDevice(deviceId, deviceType, label, roomId, undefined, legacyIOS);
    }

    // Use config label if set (overrides the join-time label)
    const effectiveLabel = (device.config?.label && device.config.label.trim()) ? device.config.label : label;

    // Cancel any grace-period disconnect timer
    this.channels.cancelDisconnectTimer(deviceId);

    // Add to in-memory state (may already exist if reconnecting within grace period)
    const existingClient = this.channels.getClient(deviceId);
    if (existingClient) {
      // Remove the previous connection for a reconnecting client
      this.channels.removeClientByConn(existingClient.connId);
    }

    const client = this.channels.addClient(transport.connId, deviceId, deviceType, roomId, effectiveLabel);
    this.config.updateDevice(deviceId, { lastSeenAt: Date.now() });

    // Send current state to the joining client
    const activeSources = this.channels.getActiveSources(roomId);
    // Enrich recentlySeenDevices with stored config so the base station's
    // config panel shows the actual device defaults instead of hardcoded values.
    const recentlySeenDevices = this.channels.getRecentlySeenDevices().map(d => ({
      ...d,
      config: this.config.getDeviceConfig(d.id),
    }));
    this.send(transport, {
      type: 'WELCOME',
      payload: {
        deviceId,
        roomId,
        config: device.config,
        sources: activeSources,
        recentlySeenDevices,
      },
    });

    // Notify all clients
    this.channels.broadcastAll({
      type: 'DEVICE_STATUS',
      payload: {
        deviceId,
        status: 'online',
        type: deviceType,
        label: effectiveLabel,
        lastSeenAt: Date.now(),
        config: device.config,
      },
    }, deviceId);

    // Send capabilities of already-connected devices to this new joiner (so a late-joining
    // base station immediately sees source pickers without waiting for a re-report)
    for (const [otherId, otherClient] of this.channels.getAllClients()) {
      if (otherId === deviceId) continue;
      if (otherClient.capabilities) {
        this.send(transport, {
          type: 'CAPABILITIES',
          payload: {
            deviceId: otherId,
            videoDevices: otherClient.capabilities.videoDevices,
            audioDevices: otherClient.capabilities.audioDevices,
          },
        });
      }
    }

    console.log(`Device joined: ${deviceId} (${deviceType}) as label="${effectiveLabel}"`);
  }

  private handleLeaveRoom(transport: Transport): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const { deviceId } = client;

    // Notify all clients that sources are removed
    for (const source of client.sources) {
      this.channels.broadcastAll({
        type: 'SOURCE_REMOVED',
        payload: { sourceId: source.id },
      }, deviceId);
    }

    this.channels.removeClientByConn(transport.connId);

    this.channels.broadcastAll({
      type: 'DEVICE_STATUS',
      payload: { deviceId, status: 'offline' },
    });
  }

  private handlePairDevice(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const token = payload.token as string;
    const deviceType = payload.deviceType as DeviceType;
    const label = (payload.label as string) || 'Unnamed Device';

    if (!token || !deviceType) {
      this.sendError(transport, 'INVALID_PARAMS', 'token and deviceType required');
      return;
    }

    const room = this.config.consumePairingToken(token);
    if (!room) {
      this.sendError(transport, 'INVALID_TOKEN', 'Token invalid or expired');
      return;
    }

    // Generate a device ID
    const deviceId = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const device = this.config.createDevice(deviceId, deviceType, label, room.id, token);

    this.send(transport, {
      type: 'WELCOME',
      payload: {
        deviceId: device.id,
        roomId: room.id,
        config: device.config,
        sources: [],
      },
    });

    console.log(`Device paired: ${deviceId} (${deviceType}) in room ${room.id}`);
  }

  private handlePublishSource(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) {
      this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
      return;
    }

    if (client.deviceType !== 'kiosk' && client.deviceType !== 'base') {
      this.sendError(transport, 'NOT_ALLOWED', 'Only cameras and base stations can publish');
      return;
    }

    const sourceId = payload.sourceId as string;
    const label = (payload.label as string) || 'Camera';
    const rawType = (payload.type as string) || 'video+audio';
    const validTypes: SourceType[] = ['video+audio', 'video-only', 'audio-only', 'none'];
    const type: SourceType = validTypes.includes(rawType as SourceType)
      ? (rawType as SourceType)
      : 'video+audio';

    if (!sourceId) {
      this.sendError(transport, 'INVALID_PARAMS', 'sourceId required');
      return;
    }

    const source = this.channels.addSource(client.deviceId, sourceId, label, type);
    if (!source) {
      this.sendError(transport, 'INTERNAL_ERROR', 'Failed to add source');
      return;
    }

    // Notify all clients (cross-room source visibility)
    this.channels.broadcastAll({
      type: 'SOURCE_ADDED',
      payload: source,
    }, client.deviceId);

    console.log(`Source published: ${sourceId} by ${client.deviceId}`);
  }

  private handleUnpublishSource(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const sourceId = payload.sourceId as string;
    if (!sourceId) return;

    const removed = this.channels.removeSource(client.deviceId, sourceId);
    if (removed) {
      this.channels.broadcastAll({
        type: 'SOURCE_REMOVED',
        payload: { sourceId },
      }, client.deviceId);
    }
  }

  private handleSubscribeSource(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) {
      this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
      return;
    }

    const publisherId = payload.publisherId as string;
    if (!publisherId) return;

    const publisher = this.channels.getClient(publisherId);
    if (!publisher) {
      this.sendError(transport, 'NOT_FOUND', 'Publisher not found');
      return;
    }
    console.log(`Cross-room subscribe: ${client.deviceId}@${client.roomId} → ${publisherId}@${publisher.roomId}`);

    // Notify publisher that a new subscriber wants their stream
    this.channels.sendTo(publisherId, {
      type: 'SUBSCRIBER_JOINED',
      payload: { subscriberId: client.deviceId },
    });

    console.log(`Subscriber ${client.deviceId} subscribed to ${publisherId}`);
  }

  private handleUnsubscribeSource(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const publisherId = payload.publisherId as string;
    if (!publisherId) return;

    this.channels.sendTo(publisherId, {
      type: 'SUBSCRIBER_LEFT',
      payload: { subscriberId: client.deviceId },
    });
  }

  // ─── Broadcast Source Handlers ──────────────────────────────

  private handleBroadcastSource(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) {
      this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
      return;
    }

    // Base stations AND kiosks (monitors) may broadcast — a monitor can push a
    // voice message to every other device, and a second base station can be
    // heard by the first.
    if (client.deviceType !== 'base' && client.deviceType !== 'kiosk') {
      this.sendError(transport, 'NOT_ALLOWED', 'Only base stations and kiosks can broadcast');
      return;
    }

    const sourceId = payload.sourceId as string;
    const label = (payload.label as string) || 'Base Station Broadcast';
    const rawType = (payload.type as string) || 'video+audio';
    const validTypes: SourceType[] = ['video+audio', 'video-only', 'audio-only', 'none'];
    const type: SourceType = validTypes.includes(rawType as SourceType) ? rawType as SourceType : 'video+audio';
    // The base sends 'all' (its default dropdown value) to mean "every kiosk".
    // Treat 'all'/'' as no target — otherwise the fan-out below filters delivery
    // to a device literally named 'all', which matches nobody, so the broadcast
    // silently reaches no one.
    const rawTarget = (payload.targetDeviceId as string) || undefined;
    const targetDeviceId = rawTarget && rawTarget !== 'all' ? rawTarget : undefined;

    if (!sourceId) {
      this.sendError(transport, 'INVALID_PARAMS', 'sourceId required');
      return;
    }

    const source = this.channels.addSource(client.deviceId, sourceId, label, type);
    if (!source) {
      this.sendError(transport, 'INTERNAL_ERROR', 'Failed to add broadcast source');
      return;
    }

    // Carry the broadcast target (if any) on the source so it can be enforced
    // at fan-out time and so late-joiners / reconnects respect it too.
    source.isBroadcast = true;
    source.targetDeviceId = targetDeviceId || undefined;

    // Notify the targeted kiosk only, or every client when broadcasting to all.
    const targets: ConnectedClient[] = targetDeviceId
      ? this.channels.getClientsInRoom(client.roomId).filter(c => c.deviceId === targetDeviceId)
      : this.channels.getClientsInRoom(client.roomId).filter(c => c.deviceId !== client.deviceId);
    for (const target of targets) {
      this.channels.sendTo(target.deviceId, {
        type: 'SOURCE_ADDED',
        payload: source,
      });
    }

    // Update base config to track broadcast
    this.config.updateDeviceConfig(client.deviceId, {
      broadcastSourceId: sourceId,
      isBroadcasting: true,
    });

    console.log(`Broadcast source published: ${sourceId} by ${client.deviceId}` + (targetDeviceId ? ` → ${targetDeviceId}` : ' → all'));
  }

  private handleUnbroadcastSource(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const sourceId = payload.sourceId as string;
    if (!sourceId) return;

    const removed = this.channels.removeSource(client.deviceId, sourceId);
    if (removed) {
      this.channels.broadcastAll({
        type: 'SOURCE_REMOVED',
        payload: { sourceId },
      });

      this.config.updateDeviceConfig(client.deviceId, {
        broadcastSourceId: undefined,
        isBroadcasting: false,
      });
    }
  }

  private handleSubscribeBroadcast(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) {
      this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
      return;
    }

    if (client.deviceType !== 'kiosk' && client.deviceType !== 'base') {
      this.sendError(transport, 'NOT_ALLOWED', 'Only kiosks and base stations can subscribe to broadcasts');
      return;
    }

    const publisherId = payload.publisherId as string;
    if (!publisherId) return;

    const publisher = this.channels.getClient(publisherId);
    if (!publisher) {
      this.sendError(transport, 'NOT_FOUND', 'Publisher not found');
      return;
    }

    // Authoritative guard: a kiosk with system broadcasts disabled must not
    // receive "Broadcast Message" announcements, even if its client ignores
    // the source. Re-check the stored device config (which the base sets).
    // Base stations are never subject to this opt-out (they must hear each
    // other's broadcasts).
    const subscriber = this.config.getDevice(client.deviceId);
    if (client.deviceType === 'kiosk' && subscriber && subscriber.config && subscriber.config.broadcastDisabled === true) {
      console.log(`Kiosk ${client.deviceId} has broadcasts disabled — denying subscribe`);
      return;
    }

    // Notify publisher that a new subscriber wants their broadcast stream
    this.channels.sendTo(publisherId, {
      type: 'SUBSCRIBER_JOINED',
      payload: { subscriberId: client.deviceId, isBroadcast: true },
    });

    console.log(`Kiosk ${client.deviceId} subscribed to broadcast from ${publisherId}`);
  }

  private handleUnsubscribeBroadcast(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const publisherId = payload.publisherId as string;
    if (!publisherId) return;

    this.channels.sendTo(publisherId, {
      type: 'SUBSCRIBER_LEFT',
      payload: { subscriberId: client.deviceId, isBroadcast: true },
    });
  }

  // ─── Display Config Handler ─────────────────────────────────

  private handleSetDisplayConfig(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    if (client.deviceType !== 'base') {
      this.sendError(transport, 'NOT_ALLOWED', 'Only base stations can set display config');
      return;
    }

    const targetDeviceId = payload.targetDeviceId as string;
    const displayMode = payload.displayMode as DisplayMode;
    const audioMode = payload.audioMode as AudioMode;

    if (!targetDeviceId || !displayMode || !audioMode) {
      this.sendError(transport, 'INVALID_PARAMS', 'targetDeviceId, displayMode, audioMode required');
      return;
    }

    const targetDevice = this.config.getDevice(targetDeviceId);
    if (!targetDevice) {
      this.sendError(transport, 'NOT_FOUND', 'Target device not found');
      return;
    }

    if (targetDevice.type !== 'kiosk') {
      this.sendError(transport, 'INVALID_TARGET', 'Display config can only be set on kiosks');
      return;
    }

    // Persist config
    this.config.updateDeviceConfig(targetDeviceId, { displayMode, audioMode });

    const fullConfig = this.config.getDeviceConfig(targetDeviceId);

    // Push to target kiosk if connected
    const targetClient = this.channels.getClient(targetDeviceId);
    if (targetClient) {
      this.channels.sendTo(targetDeviceId, {
        type: 'SET_DISPLAY_CONFIG',
        payload: { displayMode, audioMode },
      });
    }

    // Acknowledge to requesting base with the FULL persisted config (not just
    // the two changed fields) so the base's cache stays complete and consistent
    // with the SET_CONFIG reply.
    this.send(transport, {
      type: 'CONFIG_RESULT',
      payload: { targetDeviceId, ok: true, config: fullConfig || { displayMode, audioMode } },
    });

    console.log(`Display config set for ${targetDeviceId}: display=${displayMode}, audio=${audioMode}`);
  }

  private handleCapabilities(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const videoDevices = (payload.videoDevices as DeviceCapabilities['videoDevices']) || [];
    const audioDevices = (payload.audioDevices as DeviceCapabilities['audioDevices']) || [];
    const capabilities: DeviceCapabilities = { videoDevices, audioDevices };

    this.channels.setCapabilities(client.deviceId, capabilities);

    // Relay to all other clients (base stations render source pickers from this)
    this.channels.broadcastAll({
      type: 'CAPABILITIES',
      payload: { deviceId: client.deviceId, videoDevices, audioDevices },
    }, client.deviceId);

    console.log(`Capabilities reported: ${client.deviceId} (${videoDevices.length}v ${audioDevices.length}a)`);
  }

  private handleAudioPeak(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    // Relay the peak notification to all other clients (no storage needed)
    this.channels.broadcastAll({
      type: 'AUDIO_PEAK',
      payload: {
        deviceId: client.deviceId,
        levelDb: payload.levelDb,
        peak: payload.peak,
        ts: payload.ts ?? Date.now(),
      },
    }, client.deviceId);
  }

  private handleRemoveDevice(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    // Only base stations can remove devices
    if (client.deviceType !== 'base') {
      this.sendError(transport, 'NOT_ALLOWED', 'Only base stations can remove devices');
      return;
    }

    const targetDeviceId = payload.targetDeviceId as string;
    if (!targetDeviceId) {
      this.sendError(transport, 'INVALID_PARAMS', 'targetDeviceId required');
      return;
    }

    // If the target is currently connected, close its transport cleanly
    const target = this.channels.getClient(targetDeviceId);
    if (target) {
      const t = this.channels.getTransport(target.connId);
      if (t) {
        try {
          t.close();
        } catch {
          // ignore close errors
        }
      }
    }

    // Remove from in-memory recently-seen list and persisted config
    this.channels.removeRecentlySeen(targetDeviceId);
    this.config.deleteDevice(targetDeviceId);

    // Notify all clients so every base station drops the row
    this.channels.broadcastAll({
      type: 'DEVICE_REMOVED',
      payload: { deviceId: targetDeviceId },
    });

    console.log(`Device removed: ${targetDeviceId} by ${client.deviceId}`);
  }

  // ─── Doorbell / Call signaling ──────────────────────────
  // A kiosk rings the doorbell; the server relays it to every base station.
  // Bases render an "incoming call" prompt and can answer (which subscribes to
  // the kiosk) or dismiss it. CALL_STATE is sent base→kiosk to let the kiosk
  // reflect the call status (e.g. show "call connected") on its display.

  private handleDoorbell(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const label = (payload.label as string) || client.label || client.deviceId;
    // Relay to all base stations (not back to the ringer).
    this.channels.broadcastToType('base', {
      type: 'DOORBELL',
      payload: { from: client.deviceId, label, ts: Date.now() },
    }, client.deviceId);

    console.log(`Doorbell rung by ${client.deviceId} (${label})`);
  }

  private handleCallState(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const targetId = payload.targetDeviceId as string;
    if (!targetId) return;

    // Forward call state to the target device (typically a kiosk).
    this.channels.sendTo(targetId, {
      type: 'CALL_STATE',
      payload: { from: client.deviceId, state: payload.state, ts: Date.now() },
    });
  }

  private handleRelay(
    transport: Transport,
    msg: Message,
    originalType: string
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) {
      this.sendError(transport, 'NOT_IN_ROOM', 'Join a room first');
      return;
    }

    const targetId = msg.payload.to as string;
    if (!targetId) {
      this.sendError(transport, 'INVALID_PARAMS', 'Target device ID required');
      return;
    }

    // Relay the message to the target, keeping the original type
    this.channels.sendTo(targetId, {
      type: originalType,
      payload: {
        ...msg.payload,
        from: client.deviceId,
      },
      id: msg.id,
    });
  }

  private handleSetConfig(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    // Only base stations can push config
    if (client.deviceType !== 'base') {
      this.sendError(transport, 'NOT_ALLOWED', 'Only base stations can push configuration');
      return;
    }

    const targetDeviceId = payload.targetDeviceId as string;
    const config = payload.config as Record<string, unknown>;

    if (!targetDeviceId || !config) {
      this.sendError(transport, 'INVALID_PARAMS', 'targetDeviceId and config required');
      return;
    }

    const targetDevice = this.config.getDevice(targetDeviceId);
    if (!targetDevice) {
      this.sendError(transport, 'NOT_FOUND', 'Target device not found');
      return;
    }

    // Persist the config
    try {
      this.config.updateDeviceConfig(targetDeviceId, config);
    } catch (err) {
      this.sendError(transport, 'CONFIG_ERROR', 'Failed to save config');
      return;
    }

    const fullConfig = this.config.getDeviceConfig(targetDeviceId);

    // If label changed, update recentlySeenDevices and DeviceRecord
    if (config.label && typeof config.label === 'string') {
      const targetClientInner = this.channels.getClient(targetDeviceId);
      if (targetClientInner) {
        targetClientInner.label = config.label;
      }
      this.channels.updateRecentlySeenLabel(targetDeviceId, config.label);
      this.config.updateDevice(targetDeviceId, { label: config.label });
    }

    // Broadcast updated device status to all clients (includes full config
    // so every base station's local cache stays in sync).
    this.channels.broadcastAll({
      type: 'DEVICE_STATUS',
      payload: {
        deviceId: targetDeviceId,
        status: 'online',
        type: targetDevice.type,
        label: fullConfig?.label || targetDevice.label,
        config: fullConfig || targetDevice.config,
        lastSeenAt: Date.now(),
      },
    });

    // Push config to target if connected
    const targetClient = this.channels.getClient(targetDeviceId);
    if (targetClient) {
      this.channels.sendTo(targetDeviceId, {
        type: 'CONFIG_UPDATED',
        payload: { config: fullConfig || targetDevice.config },
      });
      this.send(transport, {
        type: 'CONFIG_RESULT',
        payload: { targetDeviceId, ok: true, config: fullConfig || targetDevice.config },
      });
    } else {
      // Device offline — config queued, will be applied on reconnect
      this.send(transport, {
        type: 'CONFIG_RESULT',
        payload: { targetDeviceId, ok: true, offline: true, config: fullConfig || targetDevice.config },
      });
    }

    console.log(`Config updated for ${targetDeviceId} by ${client.deviceId}`);
  }

  private handleGetConfig(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    // A target may be supplied (e.g. a base station asking for a kiosk's
    // current config). Without a target, return the requester's own config.
    const targetDeviceId =
      (payload?.targetDeviceId as string) || client.deviceId;
    const config = this.config.getDeviceConfig(targetDeviceId);
    this.send(transport, {
      type: 'CONFIG_RESULT',
      payload: { targetDeviceId, config: config || {} },
    });
  }

  private handleRequestTalk(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const targetPublisherId = payload.targetPublisherId as string;
    if (!targetPublisherId) return;

    const targetConfig = this.config.getDeviceConfig(targetPublisherId);
    if (!targetConfig?.twoWayAudioEnabled) {
      this.sendError(transport, 'TALK_DISABLED', 'Two-way audio is disabled on the target device');
      return;
    }

    // Notify the target publisher to enable their talkback speaker
    this.channels.sendTo(targetPublisherId, {
      type: 'TALK_ENABLED',
      payload: { from: client.deviceId },
    });
  }

  private handleStopTalk(
    transport: Transport,
    payload: Record<string, unknown>
  ): void {
    const client = this.channels.getClientByConnId(transport.connId);
    if (!client) return;

    const targetPublisherId = payload.targetPublisherId as string;
    if (!targetPublisherId) return;

    this.channels.sendTo(targetPublisherId, {
      type: 'TALK_DISABLED',
      payload: { from: client.deviceId },
    });
  }
}
