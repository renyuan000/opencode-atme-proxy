import type { TaskRecord } from "./types.js";
export interface AnalysisContextPayload {
    sourceMessages: string[];
    recentContext: string[];
    pinned: string[];
    memory: string[];
    openTasks: string[];
    summary: string;
}
export interface AnalysisPromptInput {
    task: TaskRecord;
    repositoryIds: string[];
    directory: string;
    context: AnalysisContextPayload;
    workspaceProjects?: Array<{
        name: string;
        path: string;
        description?: string;
    }>;
    workspaceDocs?: string[];
    attachmentNames?: string[];
}
export declare function buildAnalysisPrompt(input: AnalysisPromptInput): string;
