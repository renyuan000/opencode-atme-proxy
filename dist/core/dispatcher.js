import { QueueClosedError, QueueFullError } from "./types.js";
import { sleep, toErrorMessage } from "./util.js";
export class ConcurrentDispatcher {
    options;
    queue = [];
    activeKeys = new Map();
    running = 0;
    accepting = true;
    stats = {
        enqueued: 0,
        started: 0,
        completed: 0,
        failed: 0,
        rejected: 0,
        timedOut: 0,
        retried: 0,
    };
    constructor(options) {
        this.options = options;
        if (options.concurrency <= 0)
            throw new Error("concurrency must be > 0");
        if (options.maxQueue <= 0)
            throw new Error("maxQueue must be > 0");
    }
    enqueue(job) {
        if (!this.accepting)
            return Promise.reject(new QueueClosedError());
        if (this.queue.length >= this.options.maxQueue) {
            this.stats.rejected++;
            return Promise.reject(new QueueFullError(`queue is full (${this.options.maxQueue})`));
        }
        this.stats.enqueued++;
        return new Promise((resolve, reject) => {
            this.queue.push({ job, resolve, reject, enqueuedAt: Date.now() });
            this.pump();
        });
    }
    pump() {
        while (this.running < this.options.concurrency) {
            const index = this.findRunnableIndex();
            if (index < 0)
                return;
            const entry = this.queue.splice(index, 1)[0];
            if (!entry)
                return;
            this.start(entry);
        }
    }
    findRunnableIndex() {
        const defaultPerKey = this.options.perKeyConcurrency ?? 1;
        let best = -1;
        for (let index = 0; index < this.queue.length; index++) {
            const entry = this.queue[index];
            if (!entry)
                continue;
            const perKey = entry.job.keyConcurrency ?? defaultPerKey;
            if ((this.activeKeys.get(entry.job.key) ?? 0) >= perKey)
                continue;
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
            }
            else if (priority === bestPriority && entry.enqueuedAt < bestEntry.enqueuedAt) {
                best = index;
            }
        }
        return best;
    }
    start(entry) {
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
    async execute(entry) {
        const attempts = Math.max(0, entry.job.retries ?? this.options.defaultRetries ?? 0) + 1;
        const timeoutMs = entry.job.timeoutMs ?? this.options.defaultTimeoutMs;
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
            try {
                const result = await raceWithAbort(entry.job.run(controller.signal, attempt), controller.signal);
                clearTimeout(timer);
                this.stats.completed++;
                entry.resolve(result);
                return;
            }
            catch (error) {
                clearTimeout(timer);
                lastError = error;
                if (controller.signal.aborted)
                    this.stats.timedOut++;
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
    incrementKey(key, delta) {
        const next = (this.activeKeys.get(key) ?? 0) + delta;
        if (next <= 0)
            this.activeKeys.delete(key);
        else
            this.activeKeys.set(key, next);
    }
    async close(drainMs = 5000) {
        this.accepting = false;
        if (this.running === 0 && this.queue.length === 0)
            return;
        const deadline = Date.now() + drainMs;
        while (Date.now() < deadline) {
            if (this.running === 0 && this.queue.length === 0)
                return;
            await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
        }
        while (this.queue.length > 0) {
            const entry = this.queue.shift();
            if (!entry)
                continue;
            this.stats.rejected++;
            entry.reject(new QueueClosedError("dispatcher closed before job started"));
        }
        this.options.logger?.warn("dispatcher closed with jobs still running", {
            running: this.running,
            queued: this.queue.length,
        });
    }
    snapshot() {
        return {
            ...this.stats,
            queued: this.queue.length,
            running: this.running,
        };
    }
}
function effectivePriority(entry, now) {
    const base = entry.job.priority ?? 5;
    const waitedMs = Math.max(0, now - entry.enqueuedAt);
    return base - Math.floor(waitedMs / 30_000);
}
function timeoutError(timeoutMs) {
    const error = new Error(`job timed out after ${timeoutMs}ms`);
    error.name = "TimeoutError";
    return error;
}
function raceWithAbort(promise, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason ?? new Error("aborted"));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            reject(signal.reason ?? new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
}
//# sourceMappingURL=dispatcher.js.map