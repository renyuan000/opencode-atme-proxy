export type OwnerCommandName = "rewrite" | "regenerate" | "send" | "cancel" | "list" | "replies" | "responsibility" | "workspace" | "direction" | "keywords" | "analyze" | "analyze_group" | "group_messages" | "mentions" | "target" | "profile" | "help";
export interface OwnerCommand {
    command: OwnerCommandName;
    arg: string;
}
export declare function parseOwnerCommand(text: string): OwnerCommand | undefined;
