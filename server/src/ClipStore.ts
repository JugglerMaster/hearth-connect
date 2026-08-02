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
export class ClipStore {
  private clips = new Map<string, ClipInfo>();
  private sweepTimer: NodeJS.Timeout;

  /** Max size of a single clip. ~60s of 16kHz mono 16-bit PCM. */
  static readonly MAX_BYTES = 2 * 1024 * 1024;
  /** How long a clip stays fetchable after upload. */
  static readonly TTL_MS = 5 * 60 * 1000;
  /** Hard cap on retained clips; oldest are evicted first. */
  static readonly MAX_CLIPS = 20;

  constructor(private ttlMs: number = ClipStore.TTL_MS) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    // Never hold the process open just for the sweep.
    this.sweepTimer.unref?.();
  }

  add(clip: Omit<ClipInfo, 'createdAt'>): ClipInfo {
    const stored: ClipInfo = { ...clip, createdAt: Date.now() };
    this.clips.set(stored.id, stored);
    this.evictOverflow();
    return stored;
  }

  get(id: string): ClipInfo | undefined {
    const clip = this.clips.get(id);
    if (!clip) return undefined;
    // Expire lazily on read as well as on the timer, so a long GC pause or an
    // unref'd timer that never fires can't serve a stale clip.
    if (Date.now() - clip.createdAt > this.ttlMs) {
      this.clips.delete(id);
      return undefined;
    }
    return clip;
  }

  delete(id: string): void {
    this.clips.delete(id);
  }

  get size(): number {
    return this.clips.size;
  }

  private evictOverflow(): void {
    while (this.clips.size > ClipStore.MAX_CLIPS) {
      // Map preserves insertion order, so the first key is the oldest.
      const oldest = this.clips.keys().next();
      if (oldest.done) break;
      this.clips.delete(oldest.value);
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, clip] of this.clips) {
      if (clip.createdAt < cutoff) this.clips.delete(id);
    }
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.clips.clear();
  }
}
