import type { Logger } from "./logger.js";
export interface DedupOptions {
    file: string;
    ttlMs: number;
    maxEntries: number;
    logger?: Logger;
    now?: () => number;
}
export declare class DedupStore {
    private readonly options;
    private entries;
    private dirty;
    private flushing;
    private readonly now;
    private readonly logger;
    constructor(options: DedupOptions);
    load(): Promise<void>;
    private quarantine;
    has(key: string): boolean;
    add(key: string): void;
    delete(key: string): void;
    prune(): void;
    size(): number;
    flush(): Promise<void>;
    private writeSnapshot;
    close(): Promise<void>;
}
