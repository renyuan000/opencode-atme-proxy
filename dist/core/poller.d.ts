import type { IncomingMessage } from "./types.js";
import type { PlatformAdapter } from "./ports.js";
import type { CursorStore } from "./cursor.js";
import type { Logger } from "./logger.js";
export interface PollingOptions {
    enabled: boolean;
    platform: PlatformAdapter;
    cursors: CursorStore;
    groups: Array<{
        chatId: string;
        name?: string;
        enabled: boolean;
    }>;
    intervalMs: number;
    overlapMs: number;
    lookbackMs: number;
    pageSize: number;
    maxPages: number;
    maxMessagesPerRun: number;
    onBatch(messages: IncomingMessage[]): Promise<void>;
    logger?: Logger;
}
export declare class PollingService {
    private readonly options;
    private timer?;
    private running;
    private readonly logger;
    private readonly enabledGroups;
    constructor(options: PollingOptions);
    start(): void;
    stop(): void;
    tick(): Promise<void>;
    private pollGroup;
}
