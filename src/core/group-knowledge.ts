import { appendFile } from "node:fs/promises";
import { createLogger } from "./logger.js";
import type { Logger } from "./logger.js";
import { readJsonFile, writeJsonAtomic } from "./util.js";
import type { GroupStateLayout } from "./group-state.js";

export interface GroupKnowledge {
  chatId: string;
  name: string;
  product: string;
  summary: string;
  features: string[];
  tasks: string[];
  dependsOn: string[];
  excludes: string[];
  source: "inferred" | "owner";
  confidence: number;
  updatedAt: number;
}

export class ScopedGroupKnowledge {
  private readonly logger: Logger;
  private readonly profiles = new Map<string, GroupKnowledge>();

  constructor(
    private readonly layout: GroupStateLayout,
    logger?: Logger,
  ) {
    this.logger = logger ?? createLogger({ scope: "group-knowledge" });
  }

  async load(): Promise<void> {
    for (const info of this.layout.all()) {
      try {
        let profile = await readJsonFile<GroupKnowledge | undefined>(
          `${info.dir}/group-knowledge.json`,
          undefined,
        );
        if (!profile) {
          profile = await readJsonFile<GroupKnowledge | undefined>(
            `${info.dir}/group-profile.json`,
            undefined,
          );
          if (profile) await this.set(profile);
        }
        if (profile?.chatId === info.chatId) this.profiles.set(info.chatId, profile);
      } catch (error) {
        this.logger.warn("failed to load group knowledge", {
          chatId: info.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  get(chatId: string): GroupKnowledge | undefined {
    return this.profiles.get(chatId);
  }

  async set(profile: GroupKnowledge): Promise<void> {
    this.profiles.set(profile.chatId, profile);
    const dir = this.layout.dirFor(profile.chatId);
    await writeJsonAtomic(`${dir}/group-knowledge.json`, profile);
    try {
      await appendFile(
        `${dir}/group-knowledge-history.jsonl`,
        `${JSON.stringify({ at: profile.updatedAt, ...profile })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch (error) {
      this.logger.warn("failed to append group knowledge history", {
        chatId: profile.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  list(): GroupKnowledge[] {
    return [...this.profiles.values()];
  }

  async flush(): Promise<void> {
    for (const profile of this.profiles.values()) {
      await writeJsonAtomic(`${this.layout.dirFor(profile.chatId)}/group-knowledge.json`, profile);
    }
  }
}
