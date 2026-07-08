import WebSocket from 'ws';
import { ChannelManager } from './ChannelManager';
import { ConfigManager } from './ConfigManager';
export declare class SignalingHandler {
    private channels;
    private config;
    constructor(channels: ChannelManager, config: ConfigManager);
    handle(ws: WebSocket, raw: string): void;
    handleDisconnect(ws: WebSocket): void;
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
    private handleRelay;
    private handleSetConfig;
    private handleGetConfig;
    private handleRequestTalk;
    private handleStopTalk;
}
//# sourceMappingURL=SignalingHandler.d.ts.map