import { ClipInfo } from './types';
/**
 * In-memory store for recorded broadcast announcements (plan 18).
 *
 * Clips are deliberately NOT persisted: an announcement is a transient
 * "play this once, now" artifact. Keeping them in memory avoids disk churn on
 * a Pi's SD card and means a restart cannot resurrect a stale announcement.
 *
 * Bounded on three axes so a stuck base station cannot exhaust memory:
 * per-clip size, total clip count, and age.
 */
export declare class ClipStore {
    private ttlMs;
    private clips;
    private sweepTimer;
    /** Max size of a single clip. ~60s of 16kHz mono 16-bit PCM. */
    static readonly MAX_BYTES: number;
    /** How long a clip stays fetchable after upload. */
    static readonly TTL_MS: number;
    /** Hard cap on retained clips; oldest are evicted first. */
    static readonly MAX_CLIPS = 20;
    constructor(ttlMs?: number);
    add(clip: Omit<ClipInfo, 'createdAt'>): ClipInfo;
    get(id: string): ClipInfo | undefined;
    delete(id: string): void;
    get size(): number;
    private evictOverflow;
    private sweep;
    dispose(): void;
}
//# sourceMappingURL=ClipStore.d.ts.map