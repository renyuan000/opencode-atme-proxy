export type OwnerCommandName =
  | "rewrite"
  | "regenerate"
  | "send"
  | "cancel"
  | "list"
  | "replies"
  | "responsibility"
  | "workspace"
  | "direction"
  | "keywords"
  | "target"
  | "profile"
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
  工作空间: "workspace",
  workspace: "workspace",
  方向: "direction",
  关键词: "keywords",
  目标: "target",
  画像: "profile",
  帮助: "help",
  help: "help",
};

export function parseOwnerCommand(text: string): OwnerCommand | undefined {
  const bare = text.trim();
  if (["/", "／", "?", "？", "/?", "／?", "/？", "／？"].includes(bare)) {
    return { command: "help", arg: "" };
  }
  const match = bare.match(/^[/／](改写|重写|发送|取消|列表|待办|回复管理|回复列表|职责|工作空间|workspace|方向|关键词|目标|画像|帮助|help)\s*([\s\S]*)$/i);
  if (!match) return undefined;
  const token = match[1] ?? "";
  const command = COMMANDS[token.toLowerCase()] ?? COMMANDS[token];
  if (!command) return undefined;
  return { command, arg: (match[2] ?? "").trim() };
}
