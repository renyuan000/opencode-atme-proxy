import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { groupDirName } from "./group-state.js";
import { toErrorMessage, writeJsonAtomic } from "./util.js";
export class GroupWorkspaceManager {
    root;
    logger;
    constructor(root, logger) {
        this.root = root;
        this.logger = logger ?? createLogger({ scope: "group-workspace" });
    }
    async ensure(input) {
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
                .then((raw) => JSON.parse(raw))
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
            const changed = !previous ||
                JSON.stringify(previous.project ?? null) !== JSON.stringify(next.project) ||
                previous.name !== next.name ||
                previous.stateGroupDir !== next.stateGroupDir;
            if (changed)
                await writeJsonAtomic(path, next);
            return dir;
        }
        catch (error) {
            this.logger.warn("failed to ensure group workspace", {
                chatId: input.chatId,
                root: this.root,
                error: toErrorMessage(error),
            });
            return undefined;
        }
    }
}
//# sourceMappingURL=group-workspace.js.map