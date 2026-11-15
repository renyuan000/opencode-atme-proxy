export declare class TokenBucket {
    private readonly ratePerSecond;
    private readonly burst;
    private readonly now;
    private tokens;
    private lastRefill;
    constructor(ratePerSecond: number, burst: number, now?: () => number);
    private refill;
    tryTake(cost?: number): boolean;
    take(cost?: number, signal?: AbortSignal): Promise<void>;
    snapshot(): {
        tokens: number;
        ratePerSecond: number;
        burst: number;
    };
}
export declare class Semaphore {
    private readonly permits;
    private available;
    private readonly waiters;
    constructor(permits: number);
    acquire(signal?: AbortSignal): Promise<() => void>;
    release(): void;
    get inUse(): number;
    get waiting(): number;
}
