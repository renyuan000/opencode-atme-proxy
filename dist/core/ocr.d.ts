export type OcrProvider = "auto" | "tesseract" | "rapidocr";
export interface OcrOptions {
    provider?: OcrProvider;
    timeoutMs?: number;
    maxChars?: number;
    language?: string;
    rapidocrPython?: string;
    rapidocrScript?: string;
}
export interface OcrResult {
    text: string;
    provider: "tesseract" | "rapidocr";
    confidence?: number;
}
export declare function recognizeImage(data: Buffer, mime: string, options?: OcrOptions): Promise<OcrResult | undefined>;
export declare function ocrImage(data: Buffer, mime: string, options?: OcrOptions): Promise<string | undefined>;
