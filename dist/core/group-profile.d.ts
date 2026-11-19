import type { Logger } from "./logger.js";
import type { GroupStateLayout } from "./group-state.js";
export interface GroupProfile {
    chatId: string;
    name: string;
    product: string;
    summary: string;
    features: string[];
    tasks: string[];
    dependsOn: string[];
    excludes: string[];
    source: "inferred" | "owner";
    confidence: number;
    updatedAt: number;
}
export declare class ScopedGroupProfiles {
    private readonly layout;
    private readonly logger;
    private readonly profiles;
    constructor(layout: GroupStateLayout, logger?: Logger);
    load(): Promise<void>;
    get(chatId: string): GroupProfile | undefined;
    set(profile: GroupProfile): Promise<void>;
    list(): GroupProfile[];
    flush(): Promise<void>;
}
