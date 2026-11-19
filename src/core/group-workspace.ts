import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { groupDirName } from "./group-state.js";
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
  stateGroupDir: string;
}

export class GroupWorkspaceManager {
  private readonly logger: Logger;

  constructor(
    private readonly root: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "group-workspace" });
  }

  async ensure(input: GroupWorkspaceInput): Promise<string | undefined> {
    const dirName = groupDirName(input.chatId, input.name);
    const dir = join(this.root, dirName);
    try {
      await mkdir(dir, { recursive: true });
      await Promise.all([
        mkdir(join(dir, "session"), { recursive: true }),
        mkdir(join(dir, "files"), { recursive: true }),
        mkdir(join(dir, "worktrees"), { recursive: true }),
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
        paths: {
          session: "session",
          files: "files",
          worktrees: "worktrees",
        },
        stateGroupDir: input.stateGroupDir,
      };
      const changed =
        !previous ||
        JSON.stringify(previous.project ?? null) !== JSON.stringify(next.project) ||
        previous.name !== next.name ||
        previous.stateGroupDir !== next.stateGroupDir;
      if (changed) await writeJsonAtomic(path, next);
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
}
