export interface SenderLimiterOptions {
    maxPerMinute: number;
    maxConcurrent: number;
    cooldownMs: number;
    now?: () => number;
}
export declare class SenderLimiter {
    private readonly options;
    private readonly senders;
    private readonly now;
    constructor(options: SenderLimiterOptions);
    private state;
    tryAcquire(senderId: string): boolean;
    acquire(senderId: string): () => void;
    shouldWarn(senderId: string): boolean;
    release(senderId: string): void;
    reset(senderId: string): void;
}
