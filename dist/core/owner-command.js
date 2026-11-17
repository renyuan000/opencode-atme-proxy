const COMMANDS = {
    改写: "rewrite",
    重写: "regenerate",
    发送: "send",
    取消: "cancel",
    帮助: "help",
    help: "help",
};
export function parseOwnerCommand(text) {
    const match = text.trim().match(/^[/／](改写|重写|发送|取消|帮助|help)\s*([\s\S]*)$/i);
    if (!match)
        return undefined;
    const token = match[1] ?? "";
    const command = COMMANDS[token.toLowerCase()] ?? COMMANDS[token];
    if (!command)
        return undefined;
    return { command, arg: (match[2] ?? "").trim() };
}
//# sourceMappingURL=owner-command.js.map