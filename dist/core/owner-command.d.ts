export type OwnerCommandName = "rewrite" | "regenerate" | "send" | "cancel" | "help";
export interface OwnerCommand {
    command: OwnerCommandName;
    arg: string;
}
export declare function parseOwnerCommand(text: string): OwnerCommand | undefined;
