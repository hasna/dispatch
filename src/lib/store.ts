import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dbPath } from "./paths.js";
import { genId, nowIso } from "./ids.js";
import type {
  ConfirmResult,
  DispatchOptions,
  DispatchRecord,
  DispatchStatus,
  ScheduledDispatch,
} from "../types.js";

interface DispatchRow {
  id: string;
  target: string;
  machine: string;
  prompt: string;
  status: string;
  detail: string | null;
  confirm_json: string | null;
  submit_delay_ms: number | null;
  created_at: string;
  delivered_at: string | null;
  updated_at: string;
}

interface ScheduleRow {
  id: string;
  options_json: string;
  at: string | null;
  cron: string | null;
  next_run: string;
  status: string;
  last_dispatch_id: string | null;
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToDispatch(r: DispatchRow): DispatchRecord {
  return {
    id: r.id,
    target: r.target,
    machine: r.machine,
    prompt: r.prompt,
    status: r.status as DispatchStatus,
    detail: r.detail ?? undefined,
    confirm: r.confirm_json ? (JSON.parse(r.confirm_json) as ConfirmResult) : undefined,
    submitDelayMs: r.submit_delay_ms ?? undefined,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at ?? undefined,
    updatedAt: r.updated_at,
  };
}

function rowToSchedule(r: ScheduleRow): ScheduledDispatch {
  return {
    id: r.id,
    options: JSON.parse(r.options_json) as DispatchOptions,
    at: r.at ?? undefined,
    cron: r.cron ?? undefined,
    nextRun: r.next_run,
    status: r.status as ScheduledDispatch["status"],
    lastDispatchId: r.last_dispatch_id ?? undefined,
    lastFiredAt: r.last_fired_at ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const STALE_SENDING_DISPATCH_MS = 60 * 1000;
const SQLITE_BUSY_TIMEOUT_MS = 10000;
const SQLITE_BUSY_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function isSqliteBusy(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function sleepSync(ms: number): void {
  Atomics.wait(SQLITE_BUSY_RETRY_BUFFER, 0, 0, ms);
}

function withSqliteBusyRetry<T>(fn: () => T): T {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;
  let delayMs = 10;
  while (true) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) throw err;
      sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, 250);
    }
  }
}

/** Persistent store for dispatch records and scheduled dispatches (sqlite). */
export class Store {
  private db: Database;

  constructor(path?: string) {
    const file = path ?? dbPath();
    if (file !== ":memory:") {
      mkdirSync(dirname(file), { recursive: true });
    }
    this.db = withSqliteBusyRetry(() => new Database(file));
    withSqliteBusyRetry(() => this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`));
    withSqliteBusyRetry(() => this.db.exec("PRAGMA journal_mode = WAL;"));
    this.migrate();
  }

  private migrate(): void {
    withSqliteBusyRetry(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatches (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        machine TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        confirm_json TEXT,
        submit_delay_ms INTEGER,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatches_status ON dispatches(status);
      CREATE INDEX IF NOT EXISTS idx_dispatches_created ON dispatches(created_at);

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        options_json TEXT NOT NULL,
        at TEXT,
        cron TEXT,
        next_run TEXT NOT NULL,
        status TEXT NOT NULL,
        last_dispatch_id TEXT,
        last_fired_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
      CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(next_run);
    `));
  }

  // ---- dispatches ----

  failStaleSendingDispatches(maxAgeMs: number = STALE_SENDING_DISPATCH_MS): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const now = nowIso();
    const detail = `dispatch left in sending state for more than ${Math.round(maxAgeMs / 1000)}s; marking stale`;
    const result = withSqliteBusyRetry(() =>
      this.db.query(
        `UPDATE dispatches
         SET status='failed', detail=$detail, updated_at=$updated
         WHERE status='sending' AND updated_at < $cutoff`,
      )
      .run({ $detail: detail, $updated: now, $cutoff: cutoff }),
    );
    return result.changes;
  }

  createDispatch(input: {
    target: string;
    machine?: string;
    prompt: string;
    status?: DispatchStatus;
    detail?: string;
    submitDelayMs?: number;
  }): DispatchRecord {
    const now = nowIso();
    const rec: DispatchRecord = {
      id: genId(),
      target: input.target,
      machine: input.machine ?? "local",
      prompt: input.prompt,
      status: input.status ?? "pending",
      detail: input.detail,
      submitDelayMs: input.submitDelayMs,
      createdAt: now,
      updatedAt: now,
    };
    withSqliteBusyRetry(() =>
      this.db.query(
        `INSERT INTO dispatches (id, target, machine, prompt, status, detail, confirm_json, submit_delay_ms, created_at, delivered_at, updated_at)
         VALUES ($id, $target, $machine, $prompt, $status, $detail, $confirm, $delay, $created, $delivered, $updated)`,
      )
      .run({
        $id: rec.id,
        $target: rec.target,
        $machine: rec.machine,
        $prompt: rec.prompt,
        $status: rec.status,
        $detail: rec.detail ?? null,
        $confirm: null,
        $delay: rec.submitDelayMs ?? null,
        $created: rec.createdAt,
        $delivered: null,
        $updated: rec.updatedAt,
      }),
    );
    return rec;
  }

  getDispatch(id: string): DispatchRecord | undefined {
    this.failStaleSendingDispatches();
    const row = this.db.query<DispatchRow, [string]>("SELECT * FROM dispatches WHERE id = ?").get(id);
    return row ? rowToDispatch(row) : undefined;
  }

  updateDispatch(
    id: string,
    patch: Partial<Pick<DispatchRecord, "status" | "detail" | "confirm" | "submitDelayMs" | "deliveredAt">>,
  ): DispatchRecord {
    const existing = this.getDispatch(id);
    if (!existing) throw new Error(`dispatch not found: ${id}`);
    const merged: DispatchRecord = { ...existing, ...patch, updatedAt: nowIso() };
    withSqliteBusyRetry(() =>
      this.db.query(
        `UPDATE dispatches SET status=$status, detail=$detail, confirm_json=$confirm, submit_delay_ms=$delay, delivered_at=$delivered, updated_at=$updated WHERE id=$id`,
      )
      .run({
        $id: id,
        $status: merged.status,
        $detail: merged.detail ?? null,
        $confirm: merged.confirm ? JSON.stringify(merged.confirm) : null,
        $delay: merged.submitDelayMs ?? null,
        $delivered: merged.deliveredAt ?? null,
        $updated: merged.updatedAt,
      }),
    );
    return merged;
  }

  listDispatches(opts: { status?: DispatchStatus; limit?: number } = {}): DispatchRecord[] {
    this.failStaleSendingDispatches();
    const limit = opts.limit ?? 100;
    const rows = opts.status
      ? this.db
          .query<DispatchRow, [string, number]>(
            "SELECT * FROM dispatches WHERE status = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(opts.status, limit)
      : this.db
          .query<DispatchRow, [number]>("SELECT * FROM dispatches ORDER BY created_at DESC LIMIT ?")
          .all(limit);
    return rows.map(rowToDispatch);
  }

  // ---- schedules ----

  createSchedule(input: {
    options: DispatchOptions;
    at?: string;
    cron?: string;
    nextRun: string;
  }): ScheduledDispatch {
    const now = nowIso();
    const sched: ScheduledDispatch = {
      id: genId(),
      options: input.options,
      at: input.at,
      cron: input.cron,
      nextRun: input.nextRun,
      status: "scheduled",
      createdAt: now,
      updatedAt: now,
    };
    withSqliteBusyRetry(() =>
      this.db.query(
        `INSERT INTO schedules (id, options_json, at, cron, next_run, status, last_dispatch_id, last_fired_at, created_at, updated_at)
         VALUES ($id, $options, $at, $cron, $next, $status, $lastDispatch, $lastFired, $created, $updated)`,
      )
      .run({
        $id: sched.id,
        $options: JSON.stringify(sched.options),
        $at: sched.at ?? null,
        $cron: sched.cron ?? null,
        $next: sched.nextRun,
        $status: sched.status,
        $lastDispatch: null,
        $lastFired: null,
        $created: sched.createdAt,
        $updated: sched.updatedAt,
      }),
    );
    return sched;
  }

  getSchedule(id: string): ScheduledDispatch | undefined {
    const row = this.db.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE id = ?").get(id);
    return row ? rowToSchedule(row) : undefined;
  }

  updateSchedule(
    id: string,
    patch: Partial<Pick<ScheduledDispatch, "nextRun" | "status" | "lastDispatchId" | "lastFiredAt">>,
  ): ScheduledDispatch {
    const existing = this.getSchedule(id);
    if (!existing) throw new Error(`schedule not found: ${id}`);
    const merged: ScheduledDispatch = { ...existing, ...patch, updatedAt: nowIso() };
    withSqliteBusyRetry(() =>
      this.db.query(
        `UPDATE schedules SET next_run=$next, status=$status, last_dispatch_id=$lastDispatch, last_fired_at=$lastFired, updated_at=$updated WHERE id=$id`,
      )
      .run({
        $id: id,
        $next: merged.nextRun,
        $status: merged.status,
        $lastDispatch: merged.lastDispatchId ?? null,
        $lastFired: merged.lastFiredAt ?? null,
        $updated: merged.updatedAt,
      }),
    );
    return merged;
  }

  deleteSchedule(id: string): boolean {
    const res = withSqliteBusyRetry(() => this.db.query("DELETE FROM schedules WHERE id = ?").run(id));
    return res.changes > 0;
  }

  listSchedules(opts: { status?: ScheduledDispatch["status"]; limit?: number } = {}): ScheduledDispatch[] {
    const limit = opts.limit ?? 200;
    const rows = opts.status
      ? this.db
          .query<ScheduleRow, [string, number]>(
            "SELECT * FROM schedules WHERE status = ? ORDER BY next_run ASC LIMIT ?",
          )
          .all(opts.status, limit)
      : this.db
          .query<ScheduleRow, [number]>("SELECT * FROM schedules ORDER BY next_run ASC LIMIT ?")
          .all(limit);
    return rows.map(rowToSchedule);
  }

  /** Schedules that are due to fire at or before `nowMs`. */
  dueSchedules(nowMs: number): ScheduledDispatch[] {
    return this.listSchedules({ status: "scheduled" }).filter(
      (s) => new Date(s.nextRun).getTime() <= nowMs,
    );
  }

  close(): void {
    this.db.close();
  }
}
