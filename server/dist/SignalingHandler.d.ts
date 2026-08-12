import { ChannelManager } from './ChannelManager';
import { ConfigManager } from './ConfigManager';
import { ClipStore } from './ClipStore';
import { Transport } from './types';
export declare class SignalingHandler {
    private channels;
    private config;
    private clips?;
    constructor(channels: ChannelManager, config: ConfigManager, clips?: ClipStore | undefined);
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
    /**
     * Record-then-play announcement fan-out (plan 18).
     *
     * The base has already uploaded the WAV to /api/clip; this just tells the
     * targeted endpoints to fetch and play it. No peer connection, no ICE, so
     * none of the cold-handshake timing problems of handleBroadcastSource apply.
     */
    private handleBroadcastClip;
    private handleSubscribeBroadcast;
    private handleUnsubscribeBroadcast;
    private handleSetDisplayConfig;
    private handleCapabilities;
    private handleAudioPeak;
    private handleRemoveDevice;
    private handleDoorbell;
    private handleCallState;
    private handleSessionKicked;
    private handleRelay;
    private handleSetConfig;
    private handleGetConfig;
    private handleRequestTalk;
    private handleStopTalk;
}
//# sourceMappingURL=SignalingHandler.d.ts.map