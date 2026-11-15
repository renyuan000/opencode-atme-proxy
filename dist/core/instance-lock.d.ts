import type { Logger } from "./logger.js";
export declare function acquireInstanceLock(path: string, logger?: Logger): Promise<void>;
export declare function releaseInstanceLock(path: string, logger?: Logger): Promise<void>;
