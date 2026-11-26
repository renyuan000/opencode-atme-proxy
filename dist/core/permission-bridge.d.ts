import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
export interface PermissionBridgeOptions {
    bridge: OpenCodeBridge;
    sendToOwner(text: string): Promise<boolean>;
    logger: Logger;
}
export declare class PermissionBridge {
    private readonly options;
    private pending;
    private abort?;
    private started;
    constructor(options: PermissionBridgeOptions);
    start(): Promise<void>;
    private consume;
    pendingCount(): number;
    onlyPendingId(): string | undefined;
    reply(arg: string, reply: "once" | "always" | "reject"): Promise<string>;
    stop(): void;
}
