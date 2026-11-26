export type OwnerCommandName =
  | "rewrite"
  | "regenerate"
  | "send"
  | "cancel"
  | "list"
  | "replies"
  | "responsibility"
  | "workspace"
  | "tasks"
  | "task_analyze"
  | "task_archive"
  | "task_purge"
  | "task_cancel"
  | "task_restore"
  | "task_sessions"
  | "permission_allow"
  | "permission_deny"
  | "diagnose"
  | "direction"
  | "keywords"
  | "analyze"
  | "analyze_group"
  | "group_messages"
  | "mentions"
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
  任务: "tasks",
  tasks: "tasks",
  任务分析: "task_analyze",
  task_analyze: "task_analyze",
  任务清理: "task_purge",
  任务删除: "task_purge",
  任务取消: "task_cancel",
  task_cancel: "task_cancel",
  清理: "task_purge",
  删除: "task_purge",
  task_purge: "task_purge",
  任务归档: "task_archive",
  task_archive: "task_archive",
  任务恢复: "task_restore",
  task_restore: "task_restore",
  任务会话: "task_sessions",
  task_sessions: "task_sessions",
  允许: "permission_allow",
  allow: "permission_allow",
  拒绝: "permission_deny",
  deny: "permission_deny",
  诊断: "diagnose",
  配置诊断: "diagnose",
  diagnose: "diagnose",
  方向: "direction",
  关键词: "keywords",
  分析: "analyze",
  analyze: "analyze",
  群消息分析: "analyze_group",
  analyze_group: "analyze_group",
  群消息: "group_messages",
  查群: "group_messages",
  group_messages: "group_messages",
  提及: "mentions",
  at我: "mentions",
  mentions: "mentions",
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
  const match = bare.match(/^[/／](改写|重写|发送|取消|列表|待办|回复管理|回复列表|职责|工作空间|workspace|任务分析|task_analyze|任务清理|任务删除|任务取消|task_cancel|清理|删除|task_purge|任务归档|task_archive|任务恢复|task_restore|任务会话|task_sessions|允许|allow|拒绝|deny|任务|tasks|诊断|配置诊断|diagnose|方向|关键词|群消息分析|analyze_group|分析|analyze|群消息|查群|group_messages|提及|at我|mentions|目标|画像|帮助|help)\s*([\s\S]*)$/i);
  if (!match) return undefined;
  const token = match[1] ?? "";
  const command = COMMANDS[token.toLowerCase()] ?? COMMANDS[token];
  if (!command) return undefined;
  return { command, arg: (match[2] ?? "").trim() };
}
