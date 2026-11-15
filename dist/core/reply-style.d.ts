export type ReplyStyle = "concise" | "detailed";
export interface ReplyStyleOptions {
    defaultStyle: ReplyStyle;
    maxChars: number;
    detailMaxChars: number;
    detailTriggers: string[];
}
export declare function detectReplyStyle(input: string | {
    text: string;
}, options: ReplyStyleOptions): ReplyStyle;
export declare function styleLimit(style: ReplyStyle, options: ReplyStyleOptions): number;
export declare function buildStyleInstruction(style: ReplyStyle, options: ReplyStyleOptions): string;
export declare function enforceReplyLength(text: string, style: ReplyStyle, options: ReplyStyleOptions): string;
export declare function trimReply(text: string, style: ReplyStyle, options: ReplyStyleOptions): string;
