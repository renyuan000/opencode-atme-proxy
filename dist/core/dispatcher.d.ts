import type { Logger } from "./logger.js";
export interface DispatchJob<T> {
    id: string;
    key: string;
    priority?: number;
    keyConcurrency?: number;
    timeoutMs?: number;
    retries?: number;
    run(signal: AbortSignal, attempt: number): Promise<T>;
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
export declare class ConcurrentDispatcher {
    private readonly options;
    private readonly queue;
    private readonly activeKeys;
    private running;
    private accepting;
    private stats;
    constructor(options: DispatcherOptions);
    enqueue<T>(job: DispatchJob<T>): Promise<T>;
    private pump;
    private findRunnableIndex;
    private start;
    private execute;
    private incrementKey;
    close(drainMs?: number): Promise<void>;
    snapshot(): DispatcherStats;
}
