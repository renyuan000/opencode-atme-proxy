import type { Logger } from "./logger.js";
export type OwnerBindMethod = "config" | "claim" | "dm";
export interface OwnerBinding {
    platform: string;
    openId: string;
    displayName?: string;
    boundAt: number;
    method: OwnerBindMethod;
}
export declare class OwnerStore {
    private readonly file;
    private owners;
    private dirty;
    private readonly logger;
    constructor(file: string, logger?: Logger);
    load(): Promise<void>;
    get(platform: string): OwnerBinding | undefined;
    set(binding: OwnerBinding): void;
    clear(platform: string): boolean;
    flush(): Promise<void>;
}
