import type { Logger } from "./logger.js";
import type { GroupStateLayout } from "./group-state.js";
export interface GroupKnowledge {
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
export declare class ScopedGroupKnowledge {
    private readonly layout;
    private readonly logger;
    private readonly profiles;
    constructor(layout: GroupStateLayout, logger?: Logger);
    load(): Promise<void>;
    get(chatId: string): GroupKnowledge | undefined;
    set(profile: GroupKnowledge): Promise<void>;
    list(): GroupKnowledge[];
    flush(): Promise<void>;
}
