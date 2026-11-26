export interface ImageDecision {
    attach: boolean;
    reason: "ocr_missing_or_weak" | "visual_question" | "ocr_sufficient";
    ocrChars: number;
    ocrUsefulChars: number;
}
export declare function decideImageAttachment(text: string, ocrText?: string): ImageDecision;
export declare function stripEmbeddedOcr(text: string): string;
