export function detectReplyStyle(input, options) {
    const text = typeof input === "string" ? input : input.text;
    if (options.detailTriggers.some((trigger) => trigger && text.includes(trigger))) {
        return "detailed";
    }
    return options.defaultStyle;
}
const ACK_END = /(可以|好的|好|行|收到|没问题|够了|够用|ok|okay|嗯|对|同意)[。！!，,\s]*$/i;
export function detectReplyDepth(input, options) {
    const text = (typeof input === "string" ? input : input.text).trim();
    if (!text)
        return "answer";
    if (options.detailTriggers.some((trigger) => trigger && text.includes(trigger))) {
        return "detail";
    }
    if (text.length <= 30 && ACK_END.test(text))
        return "ack";
    return "answer";
}
export function styleLimit(style, options) {
    return style === "detailed" ? options.detailMaxChars : options.maxChars;
}
export function buildStyleInstruction(style, options, depth = "answer") {
    if (depth === "ack") {
        return [
            "回答风格：回执。",
            "对方只是确认或同意：只回一句“收到”或“好”，不分析、不查资料、不追问。",
        ].join("\n");
    }
    if (style === "detailed") {
        return [
            "回答风格：详细。",
            `最多 ${options.detailMaxChars} 字。`,
            "给出背景、关键步骤、风险与建议；仍避免空话。",
        ].join("\n");
    }
    return [
        "回答风格：极简。",
        `最多 ${options.maxChars} 字。`,
        "只回答对方问到的内容；不补充未被问到的分析；不要为了完整而追问。",
        "如果信息不足，只问一个最关键的问题。",
    ].join("\n");
}
export function enforceReplyLength(text, style, options) {
    const limit = styleLimit(style, options);
    const trimmed = text.trim();
    return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}
export function trimReply(text, style, options) {
    return enforceReplyLength(text, style, options);
}
//# sourceMappingURL=reply-style.js.map