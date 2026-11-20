import type { Logger } from "./logger.js";
export interface GroupWorkspaceProject {
    primary?: string | null;
    core?: string[];
    reference?: string[];
    secondary?: string[];
}
export interface GroupWorkspaceCodeProject {
    name: string;
    path: string;
    description?: string;
}
export interface GroupWorkspaceLayout {
    root?: string;
    projects: GroupWorkspaceCodeProject[];
    autoDiscover?: boolean;
}
export interface GroupWorkspaceInput {
    chatId: string;
    name: string;
    project?: GroupWorkspaceProject;
    workspace?: GroupWorkspaceLayout;
    responsibility?: {
        summary?: string;
        owns?: string[];
        dependsOn?: string[];
        excludes?: string[];
        notes?: string;
    };
    stateGroupDir: string;
}
export declare class GroupWorkspaceManager {
    private readonly root;
    private readonly logger;
    private readonly dirs;
    constructor(root: string, logger?: Logger);
    ensure(input: GroupWorkspaceInput): Promise<string | undefined>;
    dirFor(chatId: string): string | undefined;
    private writeAlias;
}
