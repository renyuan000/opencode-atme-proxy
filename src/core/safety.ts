export interface PermissionRule {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}

const DANGEROUS_COMMAND_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/\*/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/root(?:\/|\s|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/home(?:\/|\s|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/opt(?:\/|\s|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/var(?:\/|\s|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/mnt\/d\/Work\/source(?:\/|\s|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/mnt\/d\/Work\/source\/go-projects\/net-inspect(?:\/|\s|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/home\/renyuan\/[^\s]*\.git(?:\/|\s|$)/i,
  /\bmkfs(\.\w+)?\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\binit\s+0\b/i,
  /\bgit\s+push\s+--force\b/i,
  /\bgit\s+push\s+-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdrop\s+(database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bchmod\s+-R\s+777\s+\/(?:\s|$)/i,
  />\s*\/dev\/sd[a-z]/i,
];

const PROTECTED_SOURCE_RULES: PermissionRule[] = [
  { permission: "bash", pattern: "*rm -rf /mnt/d/Work/source*", action: "deny" },
  { permission: "bash", pattern: "*rm -rf /mnt/d/Work/source/go-projects/net-inspect*", action: "deny" },
  { permission: "bash", pattern: "*rm -rf /home/renyuan/*.git*", action: "deny" },
  { permission: "bash", pattern: "*rm -rf /home/renyuan/*/*.git*", action: "deny" },
];

const DANGEROUS_BASH_RULES: PermissionRule[] = [
  { permission: "bash", pattern: "*rm -rf /*", action: "ask" },
  { permission: "bash", pattern: "*rm -rf /root*", action: "ask" },
  { permission: "bash", pattern: "*rm -rf /home*", action: "ask" },
  { permission: "bash", pattern: "*rm -rf /opt*", action: "ask" },
  { permission: "bash", pattern: "*rm -rf /var*", action: "ask" },
  { permission: "bash", pattern: "*mkfs*", action: "ask" },
  { permission: "bash", pattern: "*dd if=*", action: "ask" },
  { permission: "bash", pattern: "*shutdown*", action: "ask" },
  { permission: "bash", pattern: "*reboot*", action: "ask" },
  { permission: "bash", pattern: "*poweroff*", action: "ask" },
  { permission: "bash", pattern: "*git push --force*", action: "ask" },
  { permission: "bash", pattern: "*git reset --hard*", action: "ask" },
  { permission: "bash", pattern: "*DROP DATABASE*", action: "ask" },
  { permission: "bash", pattern: "*TRUNCATE TABLE*", action: "ask" },
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function dangerousBashRules(): PermissionRule[] {
  return [...DANGEROUS_BASH_RULES];
}

export function protectedSourceRules(): PermissionRule[] {
  return [...PROTECTED_SOURCE_RULES];
}

export function protectedProjectRules(paths: string[]): PermissionRule[] {
  return [...new Set(paths.filter(Boolean))].flatMap((path) => [
    { permission: "bash", pattern: `*rm -rf ${path}*`, action: "deny" as const },
    { permission: "bash", pattern: `*rm -rf ${path}/*`, action: "deny" as const },
  ]);
}
