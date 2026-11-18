import type { AppConfig, LoadedConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { Logger } from "./logger.js";
import type { OwnerStore } from "./owner-store.js";
import type { IncomingMessage } from "./types.js";
export interface OwnerAccessServiceOptions {
    config: AppConfig;
    loaded: LoadedConfig;
    owners: OwnerStore;
    audit: AuditLog;
    logger: Logger;
    sendToOwner(text: string): Promise<boolean>;
}
export declare class OwnerAccessService {
    private readonly options;
    private resolvedOwner?;
    private readonly claimAttempts;
    constructor(options: OwnerAccessServiceOptions);
    init(): void;
    reconcile(): void;
    openId(): string | undefined;
    name(): string;
    claim(message: IncomingMessage): Promise<boolean>;
    load(): Promise<void>;
    flush(): Promise<void>;
    private recordClaimAttempt;
    private tooManyClaimAttempts;
}
