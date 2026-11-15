#!/usr/bin/env node
import "dotenv/config";
import { type LoadedConfig } from "./core/config.js";
import { type Logger } from "./core/logger.js";
export interface StartOptions {
    configPath?: string;
}
export declare function startDaemon(options?: StartOptions): Promise<{
    stop(): Promise<void>;
}>;
export type { LoadedConfig, Logger };
