import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic, toErrorMessage } from "./util.js";

export interface BoundProject {
  projectId: string;
  worktree: string;
  name?: string;
  reason: string;
  boundAt: number;
}

interface ProjectFile {
  version: 1;
  chats: Record<string, BoundProject>;
}

export class ProjectStore {
  private chats = new Map<string, BoundProject>();
  private dirty = false;
  private readonly logger: Logger;

  constructor(
    private readonly file: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "projects" });
  }

  async load(): Promise<void> {
    try {
      const data = await readJsonFile<ProjectFile>(this.file, { version: 1, chats: {} });
      for (const [chatId, value] of Object.entries(data.chats ?? {})) {
        if (value && typeof value.worktree === "string" && typeof value.projectId === "string") {
          this.chats.set(chatId, value);
        }
      }
    } catch (error) {
      this.logger.error("failed to load project bindings; starting empty", {
        error: toErrorMessage(error),
      });
    }
  }

  get(chatId: string): BoundProject | undefined {
    return this.chats.get(chatId);
  }

  set(chatId: string, project: BoundProject): void {
    this.chats.set(chatId, project);
    this.dirty = true;
  }

  delete(chatId: string): void {
    if (this.chats.delete(chatId)) this.dirty = true;
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    await writeJsonAtomic(this.file, {
      version: 1,
      chats: Object.fromEntries(this.chats),
    } satisfies ProjectFile);
    this.dirty = false;
  }
}
