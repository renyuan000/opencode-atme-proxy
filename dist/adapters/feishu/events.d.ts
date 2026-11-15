import type { FeishuConfig } from "../../core/config.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformAction, PlatformActionResult } from "../../core/types.js";
import type { FeishuAdapter } from "./adapter.js";
import type { AdapterHandlers } from "../../core/ports.js";
export interface FeishuEventSourceOptions {
    config: FeishuConfig;
    appSecret: string;
    adapter: FeishuAdapter;
    logger?: Logger;
}
export declare class FeishuEventSource {
    private readonly options;
    private readonly logger;
    private wsClient?;
    private handlers?;
    private started;
    constructor(options: FeishuEventSourceOptions);
    start(handlers: AdapterHandlers): Promise<void>;
    stop(): Promise<void>;
    handleAction(action: PlatformAction): Promise<PlatformActionResult>;
}
