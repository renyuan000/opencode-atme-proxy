import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogger } from "./logger.js";
import { toErrorMessage } from "./util.js";
export class TaskStateDb {
    path;
    chatId;
    logger;
    db;
    constructor(path, chatId, logger = createLogger({ scope: "task-state" })) {
        this.path = path;
        this.chatId = chatId;
        this.logger = logger;
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_session
        ON task_links(chat_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_task_links_task
        ON task_links(chat_id, task_id);
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
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
        this.migrateLegacy();
    }
    hasMigration(name) {
        return Boolean(this.db.prepare("SELECT 1 AS ok FROM migrations WHERE name = ?").get(name));
    }
    markMigration(name) {
        this.db
            .prepare("INSERT OR IGNORE INTO migrations(name, applied_at) VALUES (?, ?)")
            .run(name, Date.now());
    }
    migrateLegacy() {
        const linksPath = join(this.path, "..", "task-links.json");
        if (existsSync(linksPath) && !this.hasMigration("legacy-task-links")) {
            try {
                const legacy = JSON.parse(readFileSync(linksPath, "utf8"));
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
            }
            catch (error) {
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
                        const event = JSON.parse(line);
                        if (!event.eventId || !event.taskId)
                            continue;
                        this.db
                            .prepare("INSERT OR IGNORE INTO task_events(event_id, chat_id, task_id, type, at, payload) VALUES (?, ?, ?, ?, ?, ?)")
                            .run(event.eventId, event.chatId ?? this.chatId, event.taskId, event.type, event.at, event.payload ? JSON.stringify(event.payload) : null);
                        imported++;
                    }
                    catch {
                        continue;
                    }
                }
                this.markMigration("legacy-task-events");
                this.db.exec("COMMIT");
                this.logger.info("legacy task events imported", { events: imported, path: eventsPath });
            }
            catch (error) {
                this.db.exec("ROLLBACK");
                this.logger.warn("legacy task events import failed", {
                    path: eventsPath,
                    error: toErrorMessage(error),
                });
            }
        }
    }
    linkMessage(messageId, taskId) {
        if (!messageId || !taskId)
            return;
        this.db
            .prepare(`INSERT INTO task_links(chat_id, message_id, task_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chat_id, message_id) DO UPDATE SET task_id = excluded.task_id`)
            .run(this.chatId, messageId, taskId, Date.now());
    }
    linkSession(sessionId, taskId, role) {
        if (!sessionId || !taskId)
            return;
        this.db
            .prepare(`INSERT INTO task_links(chat_id, session_id, task_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, session_id) DO UPDATE SET task_id = excluded.task_id, role = excluded.role`)
            .run(this.chatId, sessionId, taskId, role, Date.now());
    }
    findByMessage(messageId) {
        const row = this.db
            .prepare("SELECT task_id FROM task_links WHERE chat_id = ? AND message_id = ?")
            .get(this.chatId, messageId);
        return row?.task_id;
    }
    findBySession(sessionId) {
        const row = this.db
            .prepare("SELECT task_id, role FROM task_links WHERE chat_id = ? AND session_id = ?")
            .get(this.chatId, sessionId);
        return row?.task_id ? { taskId: row.task_id, role: row.role ?? "" } : undefined;
    }
    findByTask(taskId) {
        const rows = this.db
            .prepare("SELECT session_id, role FROM task_links WHERE chat_id = ? AND task_id = ? AND session_id IS NOT NULL")
            .all(this.chatId, taskId);
        return rows.map((row) => ({ sessionId: row.session_id, role: row.role }));
    }
    getTask(taskId) {
        const row = this.db.prepare("SELECT data FROM tasks WHERE task_id = ?").get(taskId);
        return row?.data;
    }
    listTaskData() {
        return this.db.prepare("SELECT data FROM tasks").all().map((row) => row.data);
    }
    taskCount() {
        const row = this.db.prepare("SELECT COUNT(*) AS count FROM tasks").get();
        return Number(row?.count ?? 0);
    }
    saveTask(taskId, data, updatedAt, dedupKey) {
        const transaction = this.db.transaction(() => {
            this.db.prepare("INSERT INTO tasks(task_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").run(taskId, data, updatedAt);
            this.db.prepare("INSERT INTO task_index(dedup_key, task_id) VALUES (?, ?) ON CONFLICT(dedup_key) DO UPDATE SET task_id = excluded.task_id").run(dedupKey, taskId);
        });
        transaction();
    }
    taskIndex() {
        const rows = this.db.prepare("SELECT dedup_key, task_id FROM task_index").all();
        return rows.map((row) => ({ dedupKey: row.dedup_key, taskId: row.task_id }));
    }
    linkMessageAndTask(messageId, taskId, data, updatedAt, dedupKey) {
        const transaction = this.db.transaction(() => {
            this.saveTask(taskId, data, updatedAt, dedupKey);
            this.linkMessage(messageId, taskId);
        });
        transaction();
    }
    publish(event) {
        this.db
            .prepare("INSERT OR IGNORE INTO task_events(event_id, chat_id, task_id, type, at, payload) VALUES (?, ?, ?, ?, ?, ?)")
            .run(event.eventId, event.chatId ?? this.chatId, event.taskId, event.type, event.at, event.payload ? JSON.stringify(event.payload) : null);
    }
    cleanup(input) {
        const now = Date.now();
        const linkCutoff = now - input.linkDays * 86_400_000;
        const eventCutoff = now - input.eventDays * 86_400_000;
        const transaction = this.db.transaction(() => {
            const links = this.db.prepare("DELETE FROM task_links WHERE created_at < ?").run(linkCutoff).changes;
            const events = this.db.prepare("DELETE FROM task_events WHERE at < ?").run(eventCutoff).changes;
            this.db.prepare("DELETE FROM outbox WHERE status = 'delivered' AND created_at < ?").run(eventCutoff);
            return { links: Number(links), events: Number(events) };
        });
        return transaction();
    }
    async backup(path) {
        await this.db.backup(path);
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=task-state-db.js.map