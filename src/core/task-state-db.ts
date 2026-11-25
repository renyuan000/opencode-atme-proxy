import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import type { TaskEvent } from "./task-events.js";
import { toErrorMessage } from "./util.js";

interface LegacyLinks {
  byMessage?: Record<string, string>;
  bySession?: Record<string, { taskId: string; role: string }>;
}

export interface TaskNotification {
  id: string;
  taskId: string;
  chatId: string;
  kind: "candidate" | "approval" | "result" | "reminder";
  title: string;
  summary: string;
  cardMessageId?: string;
  sourceMessageId?: string;
  sourceUrl?: string;
  createdAt: number;
}

export class TaskStateDb {
  private readonly db: Database.Database;

  constructor(
    private readonly path: string,
    private readonly chatId: string,
    private readonly logger: Logger = createLogger({ scope: "task-state" }),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_links (
        chat_id TEXT NOT NULL,
        message_id TEXT,
        session_id TEXT,
        task_id TEXT NOT NULL,
        role TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_message
        ON task_links(chat_id, message_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_session_task
        ON task_links(chat_id, session_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_task_links_task
        ON task_links(chat_id, task_id);
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        state TEXT,
        archived_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS task_index (
        dedup_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        event_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        at INTEGER NOT NULL,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_task_events_task
        ON task_events(chat_id, task_id, at);
      CREATE TABLE IF NOT EXISTS task_notifications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        card_message_id TEXT,
        source_message_id TEXT,
        source_url TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_notifications_task
        ON task_notifications(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_notifications_recent
        ON task_notifications(created_at);
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_pending
        ON outbox(status, next_at);
    `);
    this.ensureTaskColumns();
    this.ensureLinkIndexes();
    this.backupBeforeMigration();
    this.migrateLegacy();
  }

  markLegacyTasksImported(): void {
    this.markMigration("legacy-tasks");
  }

  private ensureTaskColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("state")) this.db.exec("ALTER TABLE tasks ADD COLUMN state TEXT");
    if (!columns.has("archived_at")) this.db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER");
  }

  private ensureLinkIndexes(): void {
    const indexes = new Set(
      (this.db.prepare("PRAGMA index_list(task_links)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (indexes.has("idx_task_links_session")) {
      this.db.exec("DROP INDEX idx_task_links_session");
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_session_task ON task_links(chat_id, session_id, task_id)",
    );
  }

  private backupBeforeMigration(): void {
    const cacheDir = join(this.path, "..");
    const legacyLinks = join(cacheDir, "task-links.json");
    const legacyEvents = join(cacheDir, "events.jsonl");
    const legacyTasks = join(cacheDir, "..", "tasks");
    const needsMigration =
      (existsSync(legacyLinks) && !this.hasMigration("legacy-task-links")) ||
      (existsSync(legacyEvents) && !this.hasMigration("legacy-task-events")) ||
      (existsSync(legacyTasks) && !this.hasMigration("legacy-tasks"));
    if (!needsMigration || !existsSync(this.path)) return;
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      const backup = `${this.path}.pre-migration-${Date.now()}.bak`;
      copyFileSync(this.path, backup);
      this.logger.info("task state backup created before migration", { backup });
    } catch (error) {
      this.logger.warn("failed to back up task state before migration", { error: toErrorMessage(error) });
    }
  }

  private hasMigration(name: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS ok FROM migrations WHERE name = ?").get(name),
    );
  }

  private markMigration(name: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO migrations(name, applied_at) VALUES (?, ?)")
      .run(name, Date.now());
  }

  private migrateLegacy(): void {
    const linksPath = join(this.path, "..", "task-links.json");
    if (existsSync(linksPath) && !this.hasMigration("legacy-task-links")) {
      try {
        const legacy = JSON.parse(readFileSync(linksPath, "utf8")) as LegacyLinks;
        this.db.exec("BEGIN");
        for (const [messageId, taskId] of Object.entries(legacy.byMessage ?? {})) {
          this.linkMessage(messageId, taskId);
        }
        for (const [sessionId, value] of Object.entries(legacy.bySession ?? {})) {
          this.linkSession(sessionId, value.taskId, value.role);
        }
        this.markMigration("legacy-task-links");
        this.db.exec("COMMIT");
        this.logger.info("legacy task links imported", { links: linksPath });
      } catch (error) {
        this.db.exec("ROLLBACK");
        this.logger.warn("legacy task links import failed", {
          path: linksPath,
          error: toErrorMessage(error),
        });
      }
    }
    const eventsPath = join(this.path, "..", "events.jsonl");
    if (existsSync(eventsPath) && !this.hasMigration("legacy-task-events")) {
      try {
        const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
        this.db.exec("BEGIN");
        let imported = 0;
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as TaskEvent;
            if (!event.eventId || !event.taskId) continue;
            this.db
              .prepare(
                "INSERT OR IGNORE INTO task_events(event_id, chat_id, task_id, type, at, payload) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .run(
                event.eventId,
                event.chatId ?? this.chatId,
                event.taskId,
                event.type,
                event.at,
                event.payload ? JSON.stringify(event.payload) : null,
              );
            imported++;
          } catch {
            continue;
          }
        }
        this.markMigration("legacy-task-events");
        this.db.exec("COMMIT");
        this.logger.info("legacy task events imported", { events: imported, path: eventsPath });
      } catch (error) {
        this.db.exec("ROLLBACK");
        this.logger.warn("legacy task events import failed", {
          path: eventsPath,
          error: toErrorMessage(error),
        });
      }
    }
  }

  linkMessage(messageId: string, taskId: string): void {
    if (!messageId || !taskId) return;
    this.db
      .prepare(
        `INSERT INTO task_links(chat_id, message_id, task_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET task_id = excluded.task_id`,
      )
      .run(this.chatId, messageId, taskId, Date.now());
  }

  linkSession(sessionId: string, taskId: string, role: string): void {
    if (!sessionId || !taskId) return;
    this.db
      .prepare(
        `INSERT INTO task_links(chat_id, session_id, task_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, session_id, task_id) DO UPDATE SET role = excluded.role`,
      )
      .run(this.chatId, sessionId, taskId, role, Date.now());
  }

  findByMessage(messageId: string): string | undefined {
    const row = this.db
      .prepare("SELECT task_id FROM task_links WHERE chat_id = ? AND message_id = ?")
      .get(this.chatId, messageId) as { task_id?: string } | undefined;
    return row?.task_id;
  }

  findBySession(sessionId: string): { taskId: string; role: string } | undefined {
    const row = this.db
      .prepare("SELECT task_id, role FROM task_links WHERE chat_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(this.chatId, sessionId) as { task_id?: string; role?: string } | undefined;
    return row?.task_id ? { taskId: row.task_id, role: row.role ?? "" } : undefined;
  }

  findByTask(taskId: string): Array<{ sessionId: string; role: string }> {
    const rows = this.db
      .prepare("SELECT session_id, role FROM task_links WHERE chat_id = ? AND task_id = ? AND session_id IS NOT NULL")
      .all(this.chatId, taskId) as Array<{ session_id: string; role: string }>;
    return rows.map((row) => ({ sessionId: row.session_id, role: row.role }));
  }

  getTask(taskId: string): string | undefined {
    const row = this.db.prepare("SELECT data FROM tasks WHERE task_id = ?").get(taskId) as { data?: string } | undefined;
    return row?.data;
  }

  listTaskData(): string[] {
    return (this.db.prepare("SELECT data FROM tasks").all() as Array<{ data: string }>).map((row) => row.data);
  }

  taskCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  recordNotification(input: Omit<TaskNotification, "id" | "createdAt"> & Partial<Pick<TaskNotification, "id" | "createdAt">>): TaskNotification {
    const value: TaskNotification = {
      ...input,
      id: input.id ?? `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      chatId: input.chatId ?? this.chatId,
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db.prepare(
      "INSERT OR IGNORE INTO task_notifications(id, task_id, chat_id, kind, title, summary, card_message_id, source_message_id, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      value.id,
      value.taskId,
      value.chatId,
      value.kind,
      value.title,
      value.summary,
      value.cardMessageId ?? null,
      value.sourceMessageId ?? null,
      value.sourceUrl ?? null,
      value.createdAt,
    );
    return value;
  }

  notificationsForTask(taskId: string, limit = 20): TaskNotification[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_notifications WHERE task_id = ? ORDER BY created_at DESC LIMIT ?",
    ).all(taskId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapNotification(row));
  }

  recentNotifications(limit = 5): TaskNotification[] {
    const rows = this.db.prepare(
      "SELECT * FROM task_notifications ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapNotification(row));
  }

  private mapNotification(row: Record<string, unknown>): TaskNotification {
    return {
      id: String(row.id ?? ""),
      taskId: String(row.task_id ?? ""),
      chatId: String(row.chat_id ?? this.chatId),
      kind: String(row.kind ?? "candidate") as TaskNotification["kind"],
      title: String(row.title ?? ""),
      summary: String(row.summary ?? ""),
      ...(row.card_message_id ? { cardMessageId: String(row.card_message_id) } : {}),
      ...(row.source_message_id ? { sourceMessageId: String(row.source_message_id) } : {}),
      ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}),
      createdAt: Number(row.created_at ?? 0),
    };
  }

  saveTask(taskId: string, data: string, updatedAt: number, dedupKey: string): void {
    const parsed = JSON.parse(data) as { state?: string; archivedAt?: number };
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO tasks(task_id, data, updated_at, state, archived_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, state = excluded.state, archived_at = excluded.archived_at",
      ).run(taskId, data, updatedAt, parsed.state ?? null, parsed.archivedAt ?? null);
      this.db.prepare(
        "INSERT INTO task_index(dedup_key, task_id) VALUES (?, ?) ON CONFLICT(dedup_key) DO UPDATE SET task_id = excluded.task_id",
      ).run(dedupKey, taskId);
    });
    transaction();
  }

  taskIndex(): Array<{ dedupKey: string; taskId: string }> {
    const rows = this.db.prepare("SELECT dedup_key, task_id FROM task_index").all() as Array<{ dedup_key: string; task_id: string }>;
    return rows.map((row) => ({ dedupKey: row.dedup_key, taskId: row.task_id }));
  }

  saveTaskWithLinks(
    taskId: string,
    data: string,
    updatedAt: number,
    dedupKey: string,
    messageIds: string[],
  ): void {
    const transaction = this.db.transaction(() => {
      this.saveTask(taskId, data, updatedAt, dedupKey);
      for (const messageId of messageIds) this.linkMessage(messageId, taskId);
    });
    transaction();
  }

  linkMessageAndTask(
    messageId: string,
    taskId: string,
    data: string,
    updatedAt: number,
    dedupKey: string,
  ): void {
    const transaction = this.db.transaction(() => {
      this.saveTask(taskId, data, updatedAt, dedupKey);
      this.linkMessage(messageId, taskId);
    });
    transaction();
  }

  publish(event: TaskEvent): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_events(event_id, chat_id, task_id, type, at, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.eventId,
        event.chatId ?? this.chatId,
        event.taskId,
        event.type,
        event.at,
        event.payload ? JSON.stringify(event.payload) : null,
      );
  }

  cleanup(input: { linkDays: number; eventDays: number }): { links: number; events: number } {
    const now = Date.now();
    const linkCutoff = now - input.linkDays * 86_400_000;
    const eventCutoff = now - input.eventDays * 86_400_000;
    const transaction = this.db.transaction(() => {
      const links = this.db.prepare(
        "DELETE FROM task_links WHERE created_at < ? AND task_id IN (SELECT task_id FROM tasks WHERE archived_at IS NOT NULL OR state IN ('done','rejected','canceled','failed','expired'))",
      ).run(linkCutoff).changes;
      const events = this.db.prepare("DELETE FROM task_events WHERE at < ?").run(eventCutoff).changes;
      this.db.prepare("DELETE FROM task_notifications WHERE created_at < ?").run(eventCutoff);
      this.db.prepare("DELETE FROM outbox WHERE status = 'delivered' AND created_at < ?").run(eventCutoff);
      return { links: Number(links), events: Number(events) };
    });
    return transaction();
  }

  async backup(path: string): Promise<void> {
    await this.db.backup(path);
  }

  close(): void {
    this.db.close();
  }
}
