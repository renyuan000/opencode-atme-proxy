export type OwnerCommandName = "rewrite" | "regenerate" | "send" | "cancel" | "list" | "replies" | "responsibility" | "help";
export interface OwnerCommand {
    command: OwnerCommandName;
    arg: string;
}
export declare function parseOwnerCommand(text: string): OwnerCommand | undefined;
