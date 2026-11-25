import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { OpenCodeBridge, PromptAttachment } from "./opencode.js";
import type { SessionStore } from "./session-store.js";
import { Semaphore } from "./rate-limit.js";
import { toErrorMessage } from "./util.js";

export interface SessionPermission {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
}

export type WorkerRole = "reply" | "analysis" | "review";
export type ChildRole = WorkerRole | "execution";

export interface WorkerInput {
  platform: string;
  chatId: string;
  directory: string;
  title: string;
  role: WorkerRole;
  agent?: string;
  permission?: SessionPermission[];
  model?: { providerID: string; modelID: string };
  web?: boolean;
  webFetch?: boolean;
  conversationId?: string;
}

export interface ChildInput {
  platform: string;
  chatId: string;
  directory: string;
  title: string;
  role: ChildRole;
  agent?: string;
  permission?: SessionPermission[];
  taskId?: string;
  model?: { providerID: string; modelID: string };
  signal?: AbortSignal;
  conversationId?: string;
}

export interface SessionManagerOptions {
  bridge: OpenCodeBridge;
  sessions: SessionStore;
  config: AppConfig;
  logger: Logger;
  readOnlyPermission: SessionPermission[];
  epochFor?: (chatId: string) => number;
  permissionFingerprint?: string;
}

export class SessionManager {
  private readonly coordinatorLocks = new Map<string, Promise<string>>();
  private readonly workerLocks = new Map<string, Promise<void>>();
  private readonly taskChildCounts = new Map<string, number>();
  private readonly childSlots: Semaphore;

  constructor(private readonly options: SessionManagerOptions) {
    this.childSlots = new Semaphore(options.config.subagents.maxChildrenGlobal);
  }

  private epochFor(chatId: string): number {
    const value = this.options.epochFor?.(chatId) ?? 1;
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
  }

  private sessionKey(
    prefix: string,
    platform: string,
    chatId: string,
    conversationId?: string,
  ): string {
    const conversation = conversationId ?? `${platform}:${chatId}`;
    const permission = this.options.permissionFingerprint
      ? `:p${this.options.permissionFingerprint}`
      : "";
    return `${prefix}:${conversation}:e${this.epochFor(chatId)}${permission}`;
  }

  async coordinatorSession(
    platform: string,
    chatId: string,
    directory: string,
    title: string,
    conversationId?: string,
  ): Promise<string> {
    const key = this.sessionKey("coordinator", platform, chatId, conversationId);
    const existing = this.options.sessions.get(key);
    if (existing) {
      const probe = this.options.bridge.getSession;
      if (!probe) return existing.sessionId;
      const alive = await probe.call(
        this.options.bridge,
        existing.sessionId,
        existing.directory,
      );
      if (!alive || alive.timeArchived) {
        this.options.sessions.delete(key);
      } else {
        return existing.sessionId;
      }
    }
    const inflight = this.coordinatorLocks.get(key);
    if (inflight) return inflight;
    const promise = (async () => {
      const sessionId = await this.options.bridge.createSession({
        directory,
        title,
        ...(this.options.config.opencode.agent
          ? { agent: this.options.config.opencode.agent }
          : {}),
      });
      this.options.sessions.set(key, sessionId, directory, {
        kind: "coordinator",
        chatId,
        ...(conversationId ? { conversationId } : {}),
        createdAt: Date.now(),
      });
      await this.options.sessions.flush();
      this.options.logger.info("coordinator session ready", { sessionId, chatId, directory });
      return sessionId;
    })();
    this.coordinatorLocks.set(key, promise);
    try {
      return await promise;
    } finally {
      this.coordinatorLocks.delete(key);
    }
  }

  async createGroupSession(
    platform: string,
    chatId: string,
    directory: string,
    conversationId?: string,
    title?: string,
  ): Promise<string> {
    const key = this.sessionKey("group", platform, chatId, conversationId);
    const existing = this.options.sessions.get(key);
    if (existing) {
      const probe = this.options.bridge.getSession;
      if (probe) {
        const alive = await probe.call(
          this.options.bridge,
          existing.sessionId,
          existing.directory,
        );
        if (alive && !alive.timeArchived) return existing.sessionId;
      } else {
        return existing.sessionId;
      }
      this.options.sessions.delete(key);
    }
    const sessionId = await this.options.bridge.createSession({
      directory,
      title: title ?? `${this.options.config.opencode.sessionTitlePrefix}:group:${chatId}`,
      permission: this.options.readOnlyPermission,
      ...(this.options.config.opencode.agent
        ? { agent: this.options.config.opencode.agent }
        : {}),
    });
    this.options.sessions.set(key, sessionId, directory, {
      kind: "group",
      chatId,
      ...(conversationId ? { conversationId } : {}),
      createdAt: Date.now(),
    });
    await this.options.sessions.flush();
    return sessionId;
  }

  async createWorkerSession(input: WorkerInput): Promise<string> {
    const key = `${this.sessionKey(`worker:${input.role}`, input.platform, input.chatId, input.conversationId)}${input.webFetch ? ":web:fetch" : input.web ? ":web" : ""}`;
    const existing = this.options.sessions.get(key);
    if (existing && existing.directory === input.directory) {
      const probe = this.options.bridge.getSession;
      if (!probe) return existing.sessionId;
      const alive = await probe.call(
        this.options.bridge,
        existing.sessionId,
        existing.directory,
      );
      if (alive && !alive.timeArchived) return existing.sessionId;
    }
    if (existing) this.options.sessions.delete(key);
    const coordinator = await this.coordinatorSession(
      input.platform,
      input.chatId,
      input.directory,
      `${this.options.config.opencode.sessionTitlePrefix}:chat:${input.chatId}`,
      input.conversationId,
    );
    const roleAgent =
      input.role === "analysis"
        ? this.options.config.subagents.analyst
        : input.role === "review"
          ? this.options.config.subagents.reviewer
          : input.agent;
    const sessionId = await this.options.bridge.createSession({
      directory: input.directory,
      title: input.web ? `${input.title}:web` : input.title,
      parentID: coordinator,
      ...(roleAgent ? { agent: roleAgent } : {}),
      ...(input.permission ? { permission: input.permission } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
    this.options.sessions.set(key, sessionId, input.directory, {
      kind: "worker",
      chatId: input.chatId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      createdAt: Date.now(),
    });
    await this.options.sessions.flush();
    return sessionId;
  }

  async runWorker(
    input: WorkerInput,
    promptText: string,
    signal?: AbortSignal,
    attachments?: PromptAttachment[],
  ): Promise<string> {
    if (!this.options.config.subagents.enabled) {
      const { sessionId, release } = await this.createChildSession({
        ...input,
        ...(signal ? { signal } : {}),
      });
      try {
        return await this.options.bridge.prompt(sessionId, {
          directory: input.directory,
          title: input.title,
          text: promptText,
          ...(attachments ? { attachments } : {}),
          ...(signal ? { signal } : {}),
        });
      } finally {
        release();
        await this.finishSession(
          sessionId,
          input.title,
          input.directory,
          "worker_fallback",
        );
      }
    }
    const key = this.sessionKey(
      `worker:${input.role}`,
      input.platform,
      input.chatId,
      input.conversationId,
    );
    const run = async (): Promise<string> => {
      const sessionId = await this.createWorkerSession(input);
      return this.options.bridge.prompt(sessionId, {
        directory: input.directory,
        title: input.title,
        text: promptText,
        ...(attachments ? { attachments } : {}),
        ...(signal ? { signal } : {}),
      });
    };
    const previous = this.workerLocks.get(key) ?? Promise.resolve();
    const current = previous.then(run, run);
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.workerLocks.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.workerLocks.get(key) === tail) this.workerLocks.delete(key);
    }
  }

  async createChildSession(
    input: ChildInput,
  ): Promise<{ sessionId: string; release: () => void }> {
    if (!this.options.config.subagents.enabled) {
      const sessionId = await this.options.bridge.createSession({
        directory: input.directory,
        title: input.title,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.permission ? { permission: input.permission } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      return { sessionId, release: () => {} };
    }
    if (input.taskId) {
      const current = this.taskChildCounts.get(input.taskId) ?? 0;
      if (current >= this.options.config.subagents.maxChildrenPerTask) {
        throw new Error(
          `task ${input.taskId} already has ${current} active children (max ${this.options.config.subagents.maxChildrenPerTask})`,
        );
      }
    }
    const releaseSlot = await this.childSlots.acquire(input.signal);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      releaseSlot();
      if (input.taskId) {
        const next = (this.taskChildCounts.get(input.taskId) ?? 1) - 1;
        if (next <= 0) this.taskChildCounts.delete(input.taskId);
        else this.taskChildCounts.set(input.taskId, next);
      }
    };
    if (input.taskId) {
      this.taskChildCounts.set(
        input.taskId,
        (this.taskChildCounts.get(input.taskId) ?? 0) + 1,
      );
    }
    try {
      const coordinator = await this.coordinatorSession(
        input.platform,
        input.chatId,
        input.directory,
        `${this.options.config.opencode.sessionTitlePrefix}:chat:${input.chatId}`,
        input.conversationId,
      );
      const roleAgent =
        input.role === "analysis"
          ? this.options.config.subagents.analyst
          : input.role === "execution"
            ? this.options.config.subagents.executor
            : input.role === "review"
              ? this.options.config.subagents.reviewer
              : input.agent;
      const sessionId = await this.options.bridge.createSession({
        directory: input.directory,
        title: input.title,
        parentID: coordinator,
        ...(roleAgent ? { agent: roleAgent } : {}),
        ...(input.permission ? { permission: input.permission } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      this.options.sessions.set(`child:${sessionId}`, sessionId, input.directory, {
        kind: "child",
        chatId: input.chatId,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        createdAt: Date.now(),
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      await this.options.sessions.flush();
      return { sessionId, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async archiveTaskChildren(taskId: string): Promise<void> {
    if (!this.options.config.subagents.enabled) return;
    for (const [key, record] of this.options.sessions.findByTask(taskId)) {
      if (record.archivedAt) continue;
      try {
        await this.options.bridge.archiveSession?.(record.sessionId, record.directory);
        this.options.sessions.set(key, record.sessionId, record.directory, {
          ...(record.taskId ? { taskId: record.taskId } : {}),
          ...(record.chatId ? { chatId: record.chatId } : {}),
          ...(record.conversationId ? { conversationId: record.conversationId } : {}),
          kind: "child",
          createdAt: record.createdAt,
          archivedAt: Date.now(),
        });
      } catch (error) {
        this.options.logger.warn("failed to archive task child session", {
          sessionId: record.sessionId,
          taskId,
          error: toErrorMessage(error),
        });
      }
    }
    await this.options.sessions.flush();
  }

  async sweepSessions(): Promise<void> {
    if (!this.options.config.subagents.enabled) return;
    const now = Date.now();
    const archiveMs = this.options.config.subagents.archiveAfterDays * 86_400_000;
    const deleteMs = this.options.config.subagents.deleteAfterDays * 86_400_000;
    for (const [key, record] of this.options.sessions.list("child")) {
      const age = now - record.createdAt;
      const archivedAge = record.archivedAt ? now - record.archivedAt : 0;
      if (age < archiveMs && archivedAge < deleteMs) continue;
      try {
        if (age >= deleteMs) {
          await this.options.bridge.deleteSession(record.sessionId);
          this.options.sessions.delete(key);
        } else if (!record.archivedAt) {
          await this.options.bridge.archiveSession?.(record.sessionId, record.directory);
          this.options.sessions.set(key, record.sessionId, record.directory, {
            ...(record.taskId ? { taskId: record.taskId } : {}),
            ...(record.chatId ? { chatId: record.chatId } : {}),
            ...(record.conversationId ? { conversationId: record.conversationId } : {}),
            kind: "child",
            createdAt: record.createdAt,
            archivedAt: now,
          });
        }
      } catch (error) {
        this.options.logger.warn("session cleanup failed", {
          sessionId: record.sessionId,
          error: toErrorMessage(error),
        });
      }
    }
    await this.options.sessions.flush();
  }

  async finishSession(
    sessionId: string,
    title: string,
    directory: string,
    purpose: string,
  ): Promise<void> {
    if (this.options.config.opencode.keepSessions) {
      if (this.options.config.opencode.sessionListVisible) {
        this.options.logger.info("session kept for review", {
          sessionId,
          title,
          directory,
          purpose,
        });
      }
      return;
    }
    await this.options.bridge.deleteSession(sessionId);
  }
}
