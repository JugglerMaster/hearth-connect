import { ChannelManager } from './ChannelManager';
import { ConfigManager } from './ConfigManager';
import { Transport } from './types';
export declare class SignalingHandler {
    private channels;
    private config;
    constructor(channels: ChannelManager, config: ConfigManager);
    handle(transport: Transport, raw: string): void;
    handleDisconnect(transport: Transport): void;
    private route;
    private sendError;
    private send;
    private handleHeartbeat;
    private handleJoinRoom;
    private handleLeaveRoom;
    private handlePairDevice;
    private handlePublishSource;
    private handleUnpublishSource;
    private handleSubscribeSource;
    private handleUnsubscribeSource;
    private handleBroadcastSource;
    private handleUnbroadcastSource;
    private handleSubscribeBroadcast;
    private handleUnsubscribeBroadcast;
    private handleSetDisplayConfig;
    private handleCapabilities;
    private handleAudioPeak;
    private handleRemoveDevice;
    private handleDoorbell;
    private handleCallState;
    private handleRelay;
    private handleSetConfig;
    private handleGetConfig;
    private handleRequestTalk;
    private handleStopTalk;
}
//# sourceMappingURL=SignalingHandler.d.ts.map