import { sleep } from "./util.js";

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    if (ratePerSecond <= 0) throw new Error("ratePerSecond must be > 0");
    if (burst <= 0) throw new Error("burst must be > 0");
    this.tokens = burst;
    this.lastRefill = now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = current;
  }

  tryTake(cost = 1): boolean {
    if (cost <= 0) return true;
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  async take(cost = 1, signal?: AbortSignal): Promise<void> {
    while (!this.tryTake(cost)) {
      if (signal?.aborted) throw abortError(signal);
      const deficit = cost - this.tokens;
      const waitMs = Math.max(10, Math.ceil((deficit / this.ratePerSecond) * 1000));
      await sleepWithAbort(waitMs, signal);
    }
  }

  snapshot(): { tokens: number; ratePerSecond: number; burst: number } {
    this.refill();
    return { tokens: this.tokens, ratePerSecond: this.ratePerSecond, burst: this.burst };
  }
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) throw abortError(signal);
  let timer: NodeJS.Timeout | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const sleepPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([sleepPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export class Semaphore {
  private available: number;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

  constructor(private readonly permits: number) {
    if (permits <= 0) throw new Error("permits must be > 0");
    this.available = permits;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          if (signal) signal.removeEventListener("abort", onAbort);
          resolve(() => this.release());
        },
        reject,
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.available = Math.min(this.permits, this.available + 1);
  }

  get inUse(): number {
    return this.permits - this.available;
  }

  get waiting(): number {
    return this.waiters.length;
  }
}
