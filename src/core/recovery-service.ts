import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { PendingStore } from "./pending-store.js";
import type { PlatformAdapter } from "./ports.js";
import type { TaskStore } from "./task-store.js";
import type { IncomingMessage, TaskRecord } from "./types.js";
import { toErrorMessage } from "./util.js";

export interface RecoveryServiceOptions {
  config: AppConfig;
  logger: Logger;
  platform: PlatformAdapter;
  pending: PendingStore;
  tasks: TaskStore;
  dedup: { has(key: string, chatId?: string): boolean; delete(key: string, chatId?: string): void };
  historyMentions: {
    has(key: string, chatId?: string): boolean;
    add(key: string, chatId?: string): void;
    flush(): Promise<void>;
  };
  sentReplies: { hasSource(messageId: string): boolean };
  groupIds: Set<string>;
  lastCursor?(platform: string, chatId: string): number | undefined;
  recordCursor(chatId: string, endTime: number): Promise<void>;
  isMention(message: IncomingMessage): boolean;
  ingest(message: IncomingMessage, force?: boolean): Promise<void>;
  ingestBatch(messages: IncomingMessage[]): Promise<void>;
  analyzeTask(task: TaskRecord): Promise<void>;
  track<T>(promise: Promise<T>): Promise<T>;
  sendToOwner(text: string): Promise<boolean>;
}

export class RecoveryService {
  constructor(private readonly options: RecoveryServiceOptions) {}

  async recoverOnStartup(): Promise<void> {
    const recovery = this.options.config.recovery;
    if (!recovery.enabled) return;
    if (recovery.resumeTasks) {
      await this.resumeOpenTasks();
    }
    if (recovery.onStartup) {
      await this.pullStartupWindow();
    }
  }

  private async pullStartupWindow(): Promise<void> {
    const recovery = this.options.config.recovery;
    if (!this.options.platform.capabilities().groupHistory) {
      this.options.logger.warn("recovery skipped: platform has no groupHistory capability");
      return;
    }
    const endTime = Date.now();
    const configuredStart = endTime - recovery.lookbackSeconds * 1000;
    this.options.logger.info("startup recovery pull", {
      startTime: new Date(configuredStart).toISOString(),
      endTime: new Date(endTime).toISOString(),
      groups: this.options.groupIds.size,
    });
    for (const chatId of this.options.groupIds) {
      try {
        const cursor = this.options.lastCursor?.("feishu", chatId);
        const cursorStart =
          cursor && cursor < endTime
            ? Math.max(cursor - 60_000, endTime - 7 * 24 * 3600_000)
            : undefined;
        const startTime = cursorStart
          ? Math.max(configuredStart, cursorStart)
          : configuredStart;
        const result = await this.options.platform.listMessages({
          chatId,
          startTime,
          endTime,
          maxPages: 20,
          maxMessages: recovery.maxMessages,
        });
        if (result.messages.length === 0) continue;
        const messageIds = result.messages.map(
          (message) => `${message.platform}:${message.messageId}`,
        );
        const unprocessed = result.messages.filter(
          (message) =>
            !this.options.dedup.has(`${message.platform}:${message.messageId}`, chatId),
        );
        this.options.logger.info("startup recovery fetched", {
          chatId,
          fetched: result.messages.length,
          unprocessed: unprocessed.length,
          unique: new Set(messageIds).size,
        });
        const allMentions = recovery.includeMentions
          ? result.messages.filter((message) => this.options.isMention(message))
          : [];
        const mentions: IncomingMessage[] = [];
        for (const message of allMentions) {
          const key = `${message.platform}:${message.messageId}`;
          if (this.options.historyMentions.has(key, chatId)) continue;
          if (this.options.sentReplies.hasSource(message.messageId)) {
            this.options.historyMentions.add(key, chatId);
            continue;
          }
          mentions.push(message);
        }
        await this.options.historyMentions.flush();
        const plain = unprocessed
          .filter((message) => !this.options.isMention(message))
          .slice(-recovery.maxPlainMessagesPerGroup);
        this.options.logger.info("startup recovery classified", {
          chatId,
          unprocessed: unprocessed.length,
          mentions: mentions.length,
          plain: plain.length,
        });
        for (const message of mentions) {
          const key = `${message.platform}:${message.messageId}`;
          try {
            this.options.dedup.delete(key, chatId);
            await this.options.ingest(message, true);
            this.options.historyMentions.add(key, chatId);
            await this.options.historyMentions.flush();
          } catch (error) {
            this.options.logger.error("historical mention processing failed; will retry", {
              messageId: message.messageId,
              chatId,
              error: toErrorMessage(error),
            });
          }
        }
        if (recovery.includeRelevantPlain) {
          if (plain.length > 0) await this.options.ingestBatch(plain);
        }
        await this.options.recordCursor(chatId, endTime);
      } catch (error) {
        this.options.logger.error("startup recovery failed for group; continuing", {
          chatId,
          error: toErrorMessage(error),
        });
      }
    }
  }

  private async resumeOpenTasks(): Promise<void> {
    const recovery = this.options.config.recovery;
    const now = Date.now();
    const maxAgeMs = recovery.resumeMaxAgeDays * 86_400_000;
    const tasks = await this.options.tasks.list();
    let resumed = 0;
    let interrupted = 0;
    for (const task of tasks) {
      if (now - task.updatedAt > maxAgeMs) continue;
      if (task.state === "done" || task.state === "rejected" || task.state === "canceled") {
        continue;
      }
      if (task.state === "executing" || task.state === "verifying") {
        const staleMs = recovery.staleRunningMinutes * 60_000;
        if (now - task.updatedAt < staleMs) continue;
        task.state = "awaiting_approval";
        task.updatedAt = now;
        await this.options.tasks.save(task);
        interrupted++;
        await this.options.sendToOwner(
          `上次执行被中断，已暂停等待你重新批准：\n群：${task.chatName ?? task.chatId}\n${task.title}\n不会自动重放代码修改。`,
        );
        continue;
      }
      if (
        (task.state === "awaiting_approval" || task.state === "needs_info") &&
        this.options.pending.findForTask(task.id)
      ) {
        continue;
      }
      if (task.state === "candidate" || task.state === "analyzing") {
        task.state = "analyzing";
        task.updatedAt = now;
        await this.options.tasks.save(task);
        this.options.track(this.options.analyzeTask(task)).catch((error) => {
          this.options.logger.error("resumed task analysis failed", {
            taskId: task.id,
            error: toErrorMessage(error),
          });
        });
        resumed++;
        continue;
      }
      const nudgeMs = recovery.nudgeHours * 3600_000;
      if (
        (task.state === "awaiting_approval" || task.state === "needs_info") &&
        (nudgeMs === 0 || now - (task.lastNudgeAt ?? 0) > nudgeMs)
      ) {
        task.lastNudgeAt = now;
        task.updatedAt = now;
        await this.options.tasks.save(task);
        await this.options.sendToOwner(
          [
            `未完成任务提醒（${task.chatName ?? task.chatId}）：${task.title}`,
            `状态：${task.state}`,
            `来源：${task.chatName ?? task.chatId} / ${task.requester.displayName ?? task.requester.id}`,
            "请在原审批卡或群里处理。",
          ].join("\n"),
        );
        resumed++;
      }
    }
    this.options.logger.info("task resume finished", { resumed, interrupted });
    if (resumed > 0 || interrupted > 0) {
      await this.options.sendToOwner(
        `启动恢复：续作 ${resumed} 个未完成任务，中断 ${interrupted} 个执行。`,
      );
    }
  }
}
