export function detectReplyStyle(input, options) {
    const text = typeof input === "string" ? input : input.text;
    if (options.detailTriggers.some((trigger) => trigger && text.includes(trigger))) {
        return "detailed";
    }
    return options.defaultStyle;
}
export function styleLimit(style, options) {
    return style === "detailed" ? options.detailMaxChars : options.maxChars;
}
export function buildStyleInstruction(style, options) {
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
        "只给结论、关键数据、下一步；不展开背景，不重复问题。",
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