import type { AnalysisVerification, TaskAnalysis } from "./types.js";
export declare function collectIdentifiers(text: string): string[];
export declare function deterministicVerification(analysis: TaskAnalysis, corpus: string): AnalysisVerification;
export declare function parseVerification(raw: string): Partial<AnalysisVerification>;
export declare function mergeVerification(base: AnalysisVerification, extra: Partial<AnalysisVerification>): AnalysisVerification;
