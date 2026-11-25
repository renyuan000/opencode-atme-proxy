import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
    markLegacyTasksImported() {
        this.markMigration("legacy-tasks");
    }
    ensureTaskColumns() {
        const columns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name));
        if (!columns.has("state"))
            this.db.exec("ALTER TABLE tasks ADD COLUMN state TEXT");
        if (!columns.has("archived_at"))
            this.db.exec("ALTER TABLE tasks ADD COLUMN archived_at INTEGER");
    }
    ensureLinkIndexes() {
        const indexes = new Set(this.db.prepare("PRAGMA index_list(task_links)").all().map((row) => row.name));
        if (indexes.has("idx_task_links_session")) {
            this.db.exec("DROP INDEX idx_task_links_session");
        }
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_session_task ON task_links(chat_id, session_id, task_id)");
    }
    backupBeforeMigration() {
        const cacheDir = join(this.path, "..");
        const legacyLinks = join(cacheDir, "task-links.json");
        const legacyEvents = join(cacheDir, "events.jsonl");
        const legacyTasks = join(cacheDir, "..", "tasks");
        const needsMigration = (existsSync(legacyLinks) && !this.hasMigration("legacy-task-links")) ||
            (existsSync(legacyEvents) && !this.hasMigration("legacy-task-events")) ||
            (existsSync(legacyTasks) && !this.hasMigration("legacy-tasks"));
        if (!needsMigration || !existsSync(this.path))
            return;
        try {
            this.db.pragma("wal_checkpoint(TRUNCATE)");
            const backup = `${this.path}.pre-migration-${Date.now()}.bak`;
            copyFileSync(this.path, backup);
            this.logger.info("task state backup created before migration", { backup });
        }
        catch (error) {
            this.logger.warn("failed to back up task state before migration", { error: toErrorMessage(error) });
        }
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
         ON CONFLICT(chat_id, session_id, task_id) DO UPDATE SET role = excluded.role`)
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
            .prepare("SELECT task_id, role FROM task_links WHERE chat_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1")
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
    recordNotification(input) {
        const value = {
            ...input,
            id: input.id ?? `ntf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            chatId: input.chatId ?? this.chatId,
            createdAt: input.createdAt ?? Date.now(),
        };
        this.db.prepare("INSERT OR IGNORE INTO task_notifications(id, task_id, chat_id, kind, title, summary, card_message_id, source_message_id, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(value.id, value.taskId, value.chatId, value.kind, value.title, value.summary, value.cardMessageId ?? null, value.sourceMessageId ?? null, value.sourceUrl ?? null, value.createdAt);
        return value;
    }
    notificationsForTask(taskId, limit = 20) {
        const rows = this.db.prepare("SELECT * FROM task_notifications WHERE task_id = ? ORDER BY created_at DESC LIMIT ?").all(taskId, limit);
        return rows.map((row) => this.mapNotification(row));
    }
    recentNotifications(limit = 5) {
        const rows = this.db.prepare("SELECT * FROM task_notifications ORDER BY created_at DESC LIMIT ?").all(limit);
        return rows.map((row) => this.mapNotification(row));
    }
    mapNotification(row) {
        return {
            id: String(row.id ?? ""),
            taskId: String(row.task_id ?? ""),
            chatId: String(row.chat_id ?? this.chatId),
            kind: String(row.kind ?? "candidate"),
            title: String(row.title ?? ""),
            summary: String(row.summary ?? ""),
            ...(row.card_message_id ? { cardMessageId: String(row.card_message_id) } : {}),
            ...(row.source_message_id ? { sourceMessageId: String(row.source_message_id) } : {}),
            ...(row.source_url ? { sourceUrl: String(row.source_url) } : {}),
            createdAt: Number(row.created_at ?? 0),
        };
    }
    saveTask(taskId, data, updatedAt, dedupKey) {
        const parsed = JSON.parse(data);
        const transaction = this.db.transaction(() => {
            this.db.prepare("INSERT INTO tasks(task_id, data, updated_at, state, archived_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, state = excluded.state, archived_at = excluded.archived_at").run(taskId, data, updatedAt, parsed.state ?? null, parsed.archivedAt ?? null);
            this.db.prepare("INSERT INTO task_index(dedup_key, task_id) VALUES (?, ?) ON CONFLICT(dedup_key) DO UPDATE SET task_id = excluded.task_id").run(dedupKey, taskId);
        });
        transaction();
    }
    taskIndex() {
        const rows = this.db.prepare("SELECT dedup_key, task_id FROM task_index").all();
        return rows.map((row) => ({ dedupKey: row.dedup_key, taskId: row.task_id }));
    }
    saveTaskWithLinks(taskId, data, updatedAt, dedupKey, messageIds) {
        const transaction = this.db.transaction(() => {
            this.saveTask(taskId, data, updatedAt, dedupKey);
            for (const messageId of messageIds)
                this.linkMessage(messageId, taskId);
        });
        transaction();
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
            const links = this.db.prepare("DELETE FROM task_links WHERE created_at < ? AND task_id IN (SELECT task_id FROM tasks WHERE archived_at IS NOT NULL OR state IN ('done','rejected','canceled','failed','expired'))").run(linkCutoff).changes;
            const events = this.db.prepare("DELETE FROM task_events WHERE at < ?").run(eventCutoff).changes;
            this.db.prepare("DELETE FROM task_notifications WHERE created_at < ?").run(eventCutoff);
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