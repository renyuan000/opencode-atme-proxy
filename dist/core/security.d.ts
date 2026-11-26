export interface SecurityReview {
    risk: "low" | "medium" | "high";
    reasons: string[];
}
export declare function inspectUntrusted(text: string): SecurityReview;
export declare function securityPromptBlock(review: SecurityReview): string[];
