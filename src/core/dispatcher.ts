import { QueueClosedError, QueueFullError } from "./types.js";
import type { Logger } from "./logger.js";
import { sleep, toErrorMessage } from "./util.js";

export interface DispatchJob<T> {
  id: string;
  key: string;
  priority?: number;
  keyConcurrency?: number;
  timeoutMs?: number;
  retries?: number;
  run(signal: AbortSignal, attempt: number): Promise<T>;
}

interface QueueEntry<T> {
  job: DispatchJob<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  enqueuedAt: number;
}

export interface DispatcherOptions {
  concurrency: number;
  perKeyConcurrency?: number;
  maxQueue: number;
  defaultTimeoutMs: number;
  defaultRetries?: number;
  retryDelayMs?: number;
  logger?: Logger;
}

export interface DispatcherStats {
  enqueued: number;
  started: number;
  completed: number;
  failed: number;
  rejected: number;
  timedOut: number;
  retried: number;
  queued: number;
  running: number;
}

export class ConcurrentDispatcher {
  private readonly queue: QueueEntry<any>[] = [];
  private readonly activeKeys = new Map<string, number>();
  private running = 0;
  private accepting = true;
  private stats = {
    enqueued: 0,
    started: 0,
    completed: 0,
    failed: 0,
    rejected: 0,
    timedOut: 0,
    retried: 0,
  };

  constructor(private readonly options: DispatcherOptions) {
    if (options.concurrency <= 0) throw new Error("concurrency must be > 0");
    if (options.maxQueue <= 0) throw new Error("maxQueue must be > 0");
  }

  enqueue<T>(job: DispatchJob<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new QueueClosedError());
    if (this.queue.length >= this.options.maxQueue) {
      this.stats.rejected++;
      return Promise.reject(new QueueFullError(`queue is full (${this.options.maxQueue})`));
    }
    this.stats.enqueued++;
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ job, resolve, reject, enqueuedAt: Date.now() });
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.options.concurrency) {
      const index = this.findRunnableIndex();
      if (index < 0) return;
      const entry = this.queue.splice(index, 1)[0];
      if (!entry) return;
      this.start(entry);
    }
  }

  private findRunnableIndex(): number {
    const defaultPerKey = this.options.perKeyConcurrency ?? 1;
    let best = -1;
    for (let index = 0; index < this.queue.length; index++) {
      const entry = this.queue[index];
      if (!entry) continue;
      const perKey = entry.job.keyConcurrency ?? defaultPerKey;
      if ((this.activeKeys.get(entry.job.key) ?? 0) >= perKey) continue;
      if (best < 0) {
        best = index;
        continue;
      }
      const bestEntry = this.queue[best];
      if (!bestEntry) {
        best = index;
        continue;
      }
      const now = Date.now();
      const priority = effectivePriority(entry, now);
      const bestPriority = effectivePriority(bestEntry, now);
      if (priority < bestPriority) {
        best = index;
      } else if (priority === bestPriority && entry.enqueuedAt < bestEntry.enqueuedAt) {
        best = index;
      }
    }
    return best;
  }

  private start<T>(entry: QueueEntry<T>): void {
    this.running++;
    this.stats.started++;
    this.incrementKey(entry.job.key, 1);
    void this.execute(entry)
      .catch(() => {
        // execute() already settles the caller promise.
      })
      .finally(() => {
        this.running--;
        this.incrementKey(entry.job.key, -1);
        this.pump();
      });
  }

  private async execute<T>(entry: QueueEntry<T>): Promise<void> {
    const attempts = Math.max(0, entry.job.retries ?? this.options.defaultRetries ?? 0) + 1;
    const timeoutMs = entry.job.timeoutMs ?? this.options.defaultTimeoutMs;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
      try {
        const result = await raceWithAbort(entry.job.run(controller.signal, attempt), controller.signal);
        clearTimeout(timer);
        this.stats.completed++;
        entry.resolve(result);
        return;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (controller.signal.aborted) this.stats.timedOut++;
        const retryable = attempt < attempts && !controller.signal.aborted;
        if (retryable) {
          this.stats.retried++;
          this.options.logger?.warn("job failed, retrying", {
            jobId: entry.job.id,
            key: entry.job.key,
            attempt,
            error: toErrorMessage(error),
          });
          await sleep((this.options.retryDelayMs ?? 1000) * attempt);
          continue;
        }
        this.stats.failed++;
        entry.reject(error);
        return;
      }
    }
    this.stats.failed++;
    entry.reject(lastError ?? new Error("job failed"));
  }

  private incrementKey(key: string, delta: number): void {
    const next = (this.activeKeys.get(key) ?? 0) + delta;
    if (next <= 0) this.activeKeys.delete(key);
    else this.activeKeys.set(key, next);
  }

  async close(drainMs = 5000): Promise<void> {
    this.accepting = false;
    if (this.running === 0 && this.queue.length === 0) return;
    const deadline = Date.now() + drainMs;
    while (Date.now() < deadline) {
      if (this.running === 0 && this.queue.length === 0) return;
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) continue;
      this.stats.rejected++;
      entry.reject(new QueueClosedError("dispatcher closed before job started"));
    }
    this.options.logger?.warn("dispatcher closed with jobs still running", {
      running: this.running,
      queued: this.queue.length,
    });
  }

  snapshot(): DispatcherStats {
    return {
      ...this.stats,
      queued: this.queue.length,
      running: this.running,
    };
  }
}

function effectivePriority(entry: QueueEntry<unknown>, now: number): number {
  const base = entry.job.priority ?? 5;
  const waitedMs = Math.max(0, now - entry.enqueuedAt);
  return base - Math.floor(waitedMs / 30_000);
}

function timeoutError(timeoutMs: number): Error {
  const error = new Error(`job timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
