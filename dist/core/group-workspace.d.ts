import type { Logger } from "./logger.js";
export interface GroupWorkspaceProject {
    primary?: string | null;
    core?: string[];
    reference?: string[];
    secondary?: string[];
}
export interface GroupWorkspaceInput {
    chatId: string;
    name: string;
    project?: GroupWorkspaceProject;
    stateGroupDir: string;
}
export declare class GroupWorkspaceManager {
    private readonly root;
    private readonly logger;
    constructor(root: string, logger?: Logger);
    ensure(input: GroupWorkspaceInput): Promise<string | undefined>;
}
