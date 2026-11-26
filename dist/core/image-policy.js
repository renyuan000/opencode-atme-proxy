const VISUAL_QUESTION = /(颜色|配色|布局|排版|箭头|曲线|图表|坐标|界面|按钮|弹窗|图标|红框|标注|画面|照片|样式|长什么样|视觉|图中|图里|图上|这张图)/;
function usefulChars(text) {
    return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}
export function decideImageAttachment(text, ocrText) {
    const ocrChars = (ocrText ?? "").trim().length;
    const ocrUsefulChars = usefulChars(ocrText ?? "");
    if (ocrChars < 24 || ocrUsefulChars < 12) {
        return { attach: true, reason: "ocr_missing_or_weak", ocrChars, ocrUsefulChars };
    }
    if (VISUAL_QUESTION.test(text)) {
        return { attach: true, reason: "visual_question", ocrChars, ocrUsefulChars };
    }
    return { attach: false, reason: "ocr_sufficient", ocrChars, ocrUsefulChars };
}
export function stripEmbeddedOcr(text) {
    return text.replace(/\n\n\[图片 OCR[^\n]*\][\s\S]*$/u, "").trim();
}
//# sourceMappingURL=image-policy.js.map