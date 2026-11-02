/**
 * store/db.ts
 *
 * SQLite 持久化层
 * - Thread / Ticket / Assignment / Eval 历史
 * - 配置持久化
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        key TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evals (
        id TEXT PRIMARY KEY,
        thread_key TEXT NOT NULL,
        trigger_ids TEXT NOT NULL,
        primary_trigger_id TEXT NOT NULL,
        strength TEXT NOT NULL,
        actor TEXT NOT NULL,
        decision TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        requeue_count INTEGER DEFAULT 0,
        FOREIGN KEY (thread_key) REFERENCES threads(key)
      );

      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        eval_id TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        status TEXT NOT NULL,
        context_budget INTEGER NOT NULL,
        context_used INTEGER DEFAULT 0,
        priority REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (eval_id) REFERENCES evals(id)
      );

      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        watchdog_verdict TEXT,
        watchdog_extended TEXT,
        result TEXT,
        error TEXT,
        FOREIGN KEY (ticket_id) REFERENCES tickets(id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_evals_thread ON evals(thread_key);
      CREATE INDEX IF NOT EXISTS idx_tickets_eval ON tickets(eval_id);
      CREATE INDEX IF NOT EXISTS idx_assignments_ticket ON assignments(ticket_id);
    `);
  }

  // ============================================================
  // Thread
  // ============================================================

  upsertThread(key: string, sourceId: string, status: string, createdAt: number, lastActiveAt: number): void {
    this.db.prepare(`
      INSERT INTO threads (key, source_id, status, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        status = excluded.status,
        last_active_at = excluded.last_active_at
    `).run(key, sourceId, status, createdAt, lastActiveAt);
  }

  // ============================================================
  // Eval
  // ============================================================

  insertEval(
    id: string, threadKey: string, triggerIds: string, primaryTriggerId: string,
    strength: string, actor: string, startedAt: number,
  ): void {
    this.db.prepare(`
      INSERT INTO evals (id, thread_key, trigger_ids, primary_trigger_id, strength, actor, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, threadKey, triggerIds, primaryTriggerId, strength, actor, startedAt);
  }

  updateEvalDecision(id: string, decision: string, completedAt: number): void {
    this.db.prepare(`UPDATE evals SET decision = ?, completed_at = ? WHERE id = ?`)
      .run(decision, completedAt, id);
  }

  // ============================================================
  // Ticket
  // ============================================================

  insertTicket(
    id: string, evalId: string, threadKey: string, status: string,
    contextBudget: number, priority: number, createdAt: number, updatedAt: number,
  ): void {
    this.db.prepare(`
      INSERT INTO tickets (id, eval_id, thread_key, status, context_budget, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, evalId, threadKey, status, contextBudget, priority, createdAt, updatedAt);
  }

  updateTicketStatus(id: string, status: string, contextUsed: number, updatedAt: number): void {
    this.db.prepare(`UPDATE tickets SET status = ?, context_used = ?, updated_at = ? WHERE id = ?`)
      .run(status, contextUsed, updatedAt, id);
  }

  // ============================================================
  // Assignment
  // ============================================================

  insertAssignment(
    id: string, ticketId: string, executorId: string, status: string,
    startedAt: number, watchdogVerdict?: string, watchdogExtended?: string,
  ): void {
    this.db.prepare(`
      INSERT INTO assignments (id, ticket_id, executor_id, status, started_at, watchdog_verdict, watchdog_extended)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, ticketId, executorId, status, startedAt, watchdogVerdict ?? null, watchdogExtended ?? null);
  }

  updateAssignmentResult(
    id: string, status: string, completedAt: number,
    result?: unknown, error?: string,
    watchdogVerdict?: string, watchdogExtended?: string,
  ): void {
    this.db.prepare(`
      UPDATE assignments SET status = ?, completed_at = ?, result = ?, error = ?,
        watchdog_verdict = COALESCE(?, watchdog_verdict),
        watchdog_extended = COALESCE(?, watchdog_extended)
      WHERE id = ?
    `).run(
      status, completedAt,
      result ? JSON.stringify(result) : null,
      error ?? null,
      watchdogVerdict ?? null, watchdogExtended ?? null,
      id,
    );
  }

  // ============================================================
  // Settings
  // ============================================================

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  // ============================================================
  // 查询
  // ============================================================

  getTicketCounts(): { pending: number; running: number; completed: number; failed: number; expired: number } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) as cnt FROM tickets GROUP BY status
    `).all() as Array<{ status: string; cnt: number }>;
    const out = { pending: 0, running: 0, completed: 0, failed: 0, expired: 0 };
    for (const r of rows) {
      (out as Record<string, number>)[r.status] = r.cnt;
    }
    return out;
  }

  getRecentEvals(limit = 50): unknown[] {
    return this.db.prepare(`
      SELECT * FROM evals ORDER BY started_at DESC LIMIT ?
    `).all(limit);
  }

  close(): void {
    this.db.close();
  }
}
