export interface PermissionRule {
    permission: string;
    pattern: string;
    action: "allow" | "deny" | "ask";
}
export declare function isDangerousCommand(command: string): boolean;
export declare function dangerousBashRules(): PermissionRule[];
export declare function protectedSourceRules(): PermissionRule[];
