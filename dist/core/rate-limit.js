import { sleep } from "./util.js";
export class TokenBucket {
    ratePerSecond;
    burst;
    now;
    tokens;
    lastRefill;
    constructor(ratePerSecond, burst, now = Date.now) {
        this.ratePerSecond = ratePerSecond;
        this.burst = burst;
        this.now = now;
        if (ratePerSecond <= 0)
            throw new Error("ratePerSecond must be > 0");
        if (burst <= 0)
            throw new Error("burst must be > 0");
        this.tokens = burst;
        this.lastRefill = now();
    }
    refill() {
        const current = this.now();
        const elapsed = Math.max(0, current - this.lastRefill) / 1000;
        if (elapsed <= 0)
            return;
        this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
        this.lastRefill = current;
    }
    tryTake(cost = 1) {
        if (cost <= 0)
            return true;
        this.refill();
        if (this.tokens >= cost) {
            this.tokens -= cost;
            return true;
        }
        return false;
    }
    async take(cost = 1, signal) {
        while (!this.tryTake(cost)) {
            if (signal?.aborted)
                throw abortError(signal);
            const deficit = cost - this.tokens;
            const waitMs = Math.max(10, Math.ceil((deficit / this.ratePerSecond) * 1000));
            await sleepWithAbort(waitMs, signal);
        }
    }
    snapshot() {
        this.refill();
        return { tokens: this.tokens, ratePerSecond: this.ratePerSecond, burst: this.burst };
    }
}
async function sleepWithAbort(ms, signal) {
    if (!signal) {
        await sleep(ms);
        return;
    }
    if (signal.aborted)
        throw abortError(signal);
    let timer;
    const abortPromise = new Promise((_, reject) => {
        const onAbort = () => {
            if (timer)
                clearTimeout(timer);
            reject(abortError(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
    const sleepPromise = new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
    });
    try {
        await Promise.race([sleepPromise, abortPromise]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function abortError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error)
        return reason;
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
}
export class Semaphore {
    permits;
    available;
    waiters = [];
    constructor(permits) {
        this.permits = permits;
        if (permits <= 0)
            throw new Error("permits must be > 0");
        this.available = permits;
    }
    async acquire(signal) {
        if (signal?.aborted)
            throw signal.reason ?? new Error("aborted");
        if (this.available > 0) {
            this.available--;
            return () => this.release();
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve: () => {
                    if (signal)
                        signal.removeEventListener("abort", onAbort);
                    resolve(() => this.release());
                },
                reject,
            };
            const onAbort = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0)
                    this.waiters.splice(index, 1);
                reject(signal?.reason ?? new Error("aborted"));
            };
            if (signal)
                signal.addEventListener("abort", onAbort, { once: true });
            this.waiters.push(waiter);
        });
    }
    release() {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter.resolve();
            return;
        }
        this.available = Math.min(this.permits, this.available + 1);
    }
    get inUse() {
        return this.permits - this.available;
    }
    get waiting() {
        return this.waiters.length;
    }
}
//# sourceMappingURL=rate-limit.js.map