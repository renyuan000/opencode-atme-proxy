export interface SenderLimiterOptions {
  maxPerMinute: number;
  maxConcurrent: number;
  cooldownMs: number;
  now?: () => number;
}

interface SenderState {
  windowStart: number;
  count: number;
  lastAcceptedAt: number;
  active: number;
  warned: boolean;
}

export class SenderLimiter {
  private readonly senders = new Map<string, SenderState>();
  private readonly now: () => number;

  constructor(private readonly options: SenderLimiterOptions) {
    if (options.maxPerMinute <= 0) throw new Error("maxPerMinute must be > 0");
    if (options.maxConcurrent <= 0) throw new Error("maxConcurrent must be > 0");
    this.now = options.now ?? Date.now;
  }

  private state(senderId: string): SenderState {
    const now = this.now();
    const existing = this.senders.get(senderId);
    if (!existing) {
      const created: SenderState = {
        windowStart: now,
        count: 0,
        lastAcceptedAt: Number.NEGATIVE_INFINITY,
        active: 0,
        warned: false,
      };
      this.senders.set(senderId, created);
      return created;
    }
    if (now - existing.windowStart >= 60_000) {
      existing.windowStart = now;
      existing.count = 0;
    }
    return existing;
  }

  tryAcquire(senderId: string): boolean {
    const state = this.state(senderId);
    const now = this.now();
    if (state.active >= this.options.maxConcurrent) return false;
    if (state.count >= this.options.maxPerMinute) return false;
    if (this.options.cooldownMs > 0 && now - state.lastAcceptedAt < this.options.cooldownMs) {
      return false;
    }
    state.count += 1;
    state.active += 1;
    state.lastAcceptedAt = now;
    return true;
  }

  acquire(senderId: string): () => void {
    if (!this.tryAcquire(senderId)) {
      throw new Error(`sender ${senderId} is rate limited`);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const state = this.senders.get(senderId);
      if (state && state.active > 0) state.active -= 1;
    };
  }

  shouldWarn(senderId: string): boolean {
    const state = this.state(senderId);
    if (state.warned) return false;
    state.warned = true;
    return true;
  }

  release(senderId: string): void {
    const state = this.senders.get(senderId);
    if (state && state.active > 0) state.active -= 1;
  }

  reset(senderId: string): void {
    this.senders.delete(senderId);
  }
}
