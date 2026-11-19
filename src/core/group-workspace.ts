import { lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { groupDirName, shortGroupId } from "./group-state.js";
import { toErrorMessage, writeJsonAtomic } from "./util.js";

export interface GroupWorkspaceProject {
  primary?: string | null;
  core?: string[];
  reference?: string[];
  secondary?: string[];
}

export interface GroupWorkspaceInput {
  chatId: string;
  name: string;
  project?: GroupWorkspaceProject;
  responsibility?: {
    summary?: string;
    owns?: string[];
    dependsOn?: string[];
    excludes?: string[];
    notes?: string;
  };
  stateGroupDir: string;
}

export class GroupWorkspaceManager {
  private readonly logger: Logger;
  private readonly dirs = new Map<string, string>();

  constructor(
    private readonly root: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "group-workspace" });
  }

  async ensure(input: GroupWorkspaceInput): Promise<string | undefined> {
    const canonicalName = basename(input.stateGroupDir);
    const dirName = canonicalName || groupDirName(input.chatId, input.name);
    const dir = join(this.root, dirName);
    try {
      await mkdir(dir, { recursive: true });
      await Promise.all([
        mkdir(join(dir, "session"), { recursive: true }),
        mkdir(join(dir, "files"), { recursive: true }),
        mkdir(join(dir, "worktrees"), { recursive: true }),
        mkdir(join(dir, "analysis"), { recursive: true }),
        mkdir(join(dir, "execution"), { recursive: true }),
      ]);
      const path = join(dir, "group.json");
      const previous = await readFile(path, "utf8")
        .then((raw) => JSON.parse(raw) as Record<string, unknown>)
        .catch(() => undefined);
      const now = new Date().toISOString();
      const project = input.project ?? (previous?.project ?? null);
      const next = {
        groupKey: `feishu:${input.chatId}`,
        chatId: input.chatId,
        name: input.name,
        dirName,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        project,
        responsibility: input.responsibility ?? (previous?.responsibility ?? null),
        paths: {
          session: "session",
          files: "files",
          worktrees: "worktrees",
          analysis: "analysis",
          execution: "execution",
        },
        stateGroupDir: input.stateGroupDir,
      };
      const changed =
        !previous ||
        JSON.stringify(previous.project ?? null) !== JSON.stringify(next.project) ||
        previous.name !== next.name ||
        previous.stateGroupDir !== next.stateGroupDir ||
        JSON.stringify(previous.responsibility ?? null) !== JSON.stringify(next.responsibility);
      if (changed) await writeJsonAtomic(path, next);
      this.dirs.set(input.chatId, dir);
      await this.writeAlias(input, dirName);
      return dir;
    } catch (error) {
      this.logger.warn("failed to ensure group workspace", {
        chatId: input.chatId,
        root: this.root,
        error: toErrorMessage(error),
      });
      return undefined;
    }
  }

  dirFor(chatId: string): string | undefined {
    return this.dirs.get(chatId);
  }

  private async writeAlias(input: GroupWorkspaceInput, canonicalDirName: string): Promise<void> {
    const aliasesDir = join(this.root, "aliases");
    await mkdir(aliasesDir, { recursive: true });
    const aliasDirName = groupDirName(input.chatId, input.name);
    if (aliasDirName === canonicalDirName) return;
    const aliasPath = join(aliasesDir, aliasDirName);
    try {
      const existing = await lstat(aliasPath).catch(() => undefined);
      if (!existing) {
        await symlink(join("..", canonicalDirName), aliasPath, "dir");
      }
    } catch (error) {
      this.logger.warn("failed to create group workspace alias symlink", {
        chatId: input.chatId,
        aliasPath,
        canonicalDirName,
        error: toErrorMessage(error),
      });
    }
    const aliasesFile = join(this.root, "aliases.json");
    const previous = await readFile(aliasesFile, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => undefined);
    const byChat = {
      ...((previous?.byChat as Record<string, unknown> | undefined) ?? {}),
    };
    byChat[input.chatId] = {
      chatId: input.chatId,
      shortId: shortGroupId(input.chatId),
      name: input.name,
      dirName: canonicalDirName,
      alias: aliasDirName,
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(aliasesFile, {
      version: 1,
      updatedAt: new Date().toISOString(),
      byChat,
    });
  }
}
