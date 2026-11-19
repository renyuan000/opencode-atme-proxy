export type OwnerCommandName =
  | "rewrite"
  | "regenerate"
  | "send"
  | "cancel"
  | "list"
  | "replies"
  | "responsibility"
  | "help";

export interface OwnerCommand {
  command: OwnerCommandName;
  arg: string;
}

const COMMANDS: Record<string, OwnerCommandName> = {
  改写: "rewrite",
  重写: "regenerate",
  发送: "send",
  取消: "cancel",
  列表: "list",
  待办: "list",
  回复管理: "replies",
  回复列表: "replies",
  职责: "responsibility",
  帮助: "help",
  help: "help",
};

export function parseOwnerCommand(text: string): OwnerCommand | undefined {
  const bare = text.trim();
  if (["/", "／", "?", "？", "/?", "／?", "/？", "／？"].includes(bare)) {
    return { command: "help", arg: "" };
  }
  const match = bare.match(/^[/／](改写|重写|发送|取消|列表|待办|回复管理|回复列表|职责|帮助|help)\s*([\s\S]*)$/i);
  if (!match) return undefined;
  const token = match[1] ?? "";
  const command = COMMANDS[token.toLowerCase()] ?? COMMANDS[token];
  if (!command) return undefined;
  return { command, arg: (match[2] ?? "").trim() };
}
