import type { TaskRecord } from "./types.js";
import type { SecurityReview } from "./security.js";
export interface AnalysisContextPayload {
    sourceMessages: string[];
    supplements?: string[];
    recentContext: string[];
    pinned: string[];
    memory: string[];
    openTasks: string[];
    summary: string;
    security?: SecurityReview;
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
    writableProjects?: string[];
    readonlyProjects?: string[];
    attachmentNames?: string[];
    attachmentTexts?: string[];
}
export declare function buildAnalysisPrompt(input: AnalysisPromptInput): string;
