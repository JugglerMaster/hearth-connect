"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClipStore = void 0;
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
class ClipStore {
    constructor(ttlMs = ClipStore.TTL_MS) {
        this.ttlMs = ttlMs;
        this.clips = new Map();
        this.sweepTimer = setInterval(() => this.sweep(), 60000);
        // Never hold the process open just for the sweep.
        this.sweepTimer.unref?.();
    }
    add(clip) {
        const stored = { ...clip, createdAt: Date.now() };
        this.clips.set(stored.id, stored);
        this.evictOverflow();
        return stored;
    }
    get(id) {
        const clip = this.clips.get(id);
        if (!clip)
            return undefined;
        // Expire lazily on read as well as on the timer, so a long GC pause or an
        // unref'd timer that never fires can't serve a stale clip.
        if (Date.now() - clip.createdAt > this.ttlMs) {
            this.clips.delete(id);
            return undefined;
        }
        return clip;
    }
    delete(id) {
        this.clips.delete(id);
    }
    get size() {
        return this.clips.size;
    }
    evictOverflow() {
        while (this.clips.size > ClipStore.MAX_CLIPS) {
            // Map preserves insertion order, so the first key is the oldest.
            const oldest = this.clips.keys().next();
            if (oldest.done)
                break;
            this.clips.delete(oldest.value);
        }
    }
    sweep() {
        const cutoff = Date.now() - this.ttlMs;
        for (const [id, clip] of this.clips) {
            if (clip.createdAt < cutoff)
                this.clips.delete(id);
        }
    }
    dispose() {
        clearInterval(this.sweepTimer);
        this.clips.clear();
    }
}
exports.ClipStore = ClipStore;
/** Max size of a single clip. ~60s of 16kHz mono 16-bit PCM. */
ClipStore.MAX_BYTES = 2 * 1024 * 1024;
/** How long a clip stays fetchable after upload. */
ClipStore.TTL_MS = 5 * 60 * 1000;
/** Hard cap on retained clips; oldest are evicted first. */
ClipStore.MAX_CLIPS = 20;
//# sourceMappingURL=ClipStore.js.map