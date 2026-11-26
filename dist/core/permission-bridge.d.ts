import type { Logger } from "./logger.js";
import type { OpenCodeBridge } from "./opencode.js";
import type { PermissionView } from "./types.js";
export interface PermissionBridgeOptions {
    bridge: OpenCodeBridge;
    sendToOwner(text: string): Promise<boolean>;
    sendPermissionCard?(view: PermissionView): Promise<boolean>;
    logger: Logger;
}
export declare function parsePermissionReply(text: string): "allow" | "deny" | undefined;
export declare class PermissionBridge {
    private readonly options;
    private pending;
    private abort?;
    private started;
    constructor(options: PermissionBridgeOptions);
    start(): Promise<void>;
    private syncPending;
    private reconnect;
    private consume;
    pendingCount(): number;
    private handleRequest;
    requestView(requestId: string): PermissionView | undefined;
    reply(arg: string, reply: "once" | "always" | "reject"): Promise<string>;
    stop(): void;
}
