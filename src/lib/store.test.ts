import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { Store } from "./store.js";

function mem(): Store {
  return new Store(":memory:");
}

function ageDispatch(s: Store, id: string, updatedAt: string): void {
  const store = s as unknown as {
    db: { query: (sql: string) => { run: (updatedAt: string, id: string) => void } };
  };
  store.db.query("UPDATE dispatches SET updated_at = ? WHERE id = ?").run(updatedAt, id);
}

describe("Store — dispatches", () => {
  test("create/get round-trips with defaults", () => {
    const s = mem();
    const rec = s.createDispatch({ target: "s:w", prompt: "hi" });
    expect(rec.id).toHaveLength(12);
    expect(rec.machine).toBe("local");
    expect(rec.status).toBe("pending");
    expect(s.getDispatch(rec.id)).toEqual(rec);
    s.close();
  });

  test("update patches fields and bumps updatedAt", () => {
    const s = mem();
    const rec = s.createDispatch({ target: "s:w", prompt: "hi", machine: "spark01" });
    const confirm = { delivered: true, reason: "working detected" };
    const updated = s.updateDispatch(rec.id, {
      status: "delivered",
      confirm,
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(updated.status).toBe("delivered");
    expect(updated.confirm).toEqual(confirm);
    expect(updated.deliveredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s.getDispatch(rec.id)!.confirm).toEqual(confirm);
    s.close();
  });

  test("exec audit fields round-trip", () => {
    const s = mem();
    const rec = s.createDispatch({
      kind: "exec",
      target: "open-mailery:01",
      prompt: "mailery status",
      status: "skipped",
      commandHash: "0123456789abcdef",
      targetKind: "shell",
      dryRun: true,
      filter: {
        allowed: true,
        code: "allowed_prefix",
        reason: "command prefix is allowlisted",
        commandHash: "0123456789abcdef",
        normalizedCommand: "mailery status",
        targetKind: "shell",
        matchedRule: "mailery status",
      },
      execPlan: { interrupt: false, pasteText: "mailery status", submitKey: "Enter" },
    });

    expect(s.getDispatch(rec.id)).toMatchObject({
      kind: "exec",
      commandHash: "0123456789abcdef",
      targetKind: "shell",
      dryRun: true,
      filter: { allowed: true, code: "allowed_prefix" },
      execPlan: { pasteText: "mailery status", submitKey: "Enter" },
    });
    s.close();
  });

  test("key audit records round-trip for list/status output", () => {
    const s = mem();
    const rec = s.createDispatch({
      kind: "key",
      target: "work:agent",
      prompt: "<key:Tab>",
      status: "delivered",
      detail: "sent key Tab to agent composer",
    });

    expect(s.getDispatch(rec.id)).toMatchObject({
      kind: "key",
      prompt: "<key:Tab>",
      detail: "sent key Tab to agent composer",
    });
    expect(s.listDispatches({ limit: 1 })[0]).toMatchObject({ kind: "key", prompt: "<key:Tab>" });
    s.close();
  });

  test("prompt orchestration audit fields round-trip", () => {
    const s = mem();
    const rec = s.createDispatch({
      target: "open-sessions:2.1",
      prompt: "Inspect this",
      status: "skipped",
      dryRun: true,
      targetState: "active",
      detection: {
        targetKind: "agent",
        agentKind: "codewith",
        composerState: "active",
        canReceivePrompt: false,
        canQueuePrompt: true,
        submitKeys: ["Enter", "Tab"],
        recommendedSubmitKey: "Tab",
        reason: "active composer supports queued Tab prompt delivery",
        paneCommand: "node",
        cwd: "/repo",
      },
      captureBefore: {
        status: "captured",
        target: "open-sessions:2.1",
        machine: "local",
        requestedLines: 50,
        lines: 50,
        maxLines: 2000,
        capturedAt: "2026-06-23T00:00:00.000Z",
        text: "Goal active Objective: test\n",
        redacted: true,
      },
    });

    expect(s.getDispatch(rec.id)).toMatchObject({
      dryRun: true,
      targetState: "active",
      detection: {
        agentKind: "codewith",
        composerState: "active",
        canQueuePrompt: true,
        recommendedSubmitKey: "Tab",
      },
      captureBefore: {
        status: "captured",
        lines: 50,
        text: "Goal active Objective: test\n",
      },
    });
    s.close();
  });

  test("update throws for unknown id", () => {
    const s = mem();
    expect(() => s.updateDispatch("nope", { status: "failed" })).toThrow(/not found/);
    s.close();
  });

  test("list filters by status and respects limit + order", () => {
    const s = mem();
    const a = s.createDispatch({ target: "s:w", prompt: "1" });
    s.updateDispatch(a.id, { status: "delivered" });
    s.createDispatch({ target: "s:w", prompt: "2" });
    s.createDispatch({ target: "s:w", prompt: "3" });
    expect(s.listDispatches({ status: "delivered" })).toHaveLength(1);
    expect(s.listDispatches({ status: "pending" })).toHaveLength(2);
    expect(s.listDispatches({ limit: 2 })).toHaveLength(2);
    s.close();
  });

  test("list marks old sending dispatches as failed", () => {
    const s = mem();
    const rec = s.createDispatch({ target: "s:w", prompt: "stale", status: "sending" });
    ageDispatch(s, rec.id, "2000-01-01T00:00:00.000Z");
    expect(s.listDispatches({ status: "sending" })).toHaveLength(0);
    expect(s.listDispatches({ status: "failed" })[0]).toMatchObject({
      id: rec.id,
      status: "failed",
      detail: expect.stringContaining("left in sending state"),
    });
    s.close();
  });

  test("get marks old sending dispatches as failed", () => {
    const s = mem();
    const rec = s.createDispatch({ target: "s:w", prompt: "stale", status: "sending" });
    ageDispatch(s, rec.id, "2000-01-01T00:00:00.000Z");
    expect(s.getDispatch(rec.id)).toMatchObject({
      id: rec.id,
      status: "failed",
      detail: expect.stringContaining("left in sending state"),
    });
    s.close();
  });
});

describe("Store — schedules", () => {
  test("create/get/list/delete round-trips", () => {
    const s = mem();
    const sched = s.createSchedule({
      options: { target: "s:w", prompt: "later" },
      at: "2099-01-01T00:00:00.000Z",
      nextRun: "2099-01-01T00:00:00.000Z",
    });
    expect(sched.status).toBe("scheduled");
    expect(s.getSchedule(sched.id)!.options.prompt).toBe("later");
    expect(s.listSchedules({ status: "scheduled" })).toHaveLength(1);
    expect(s.deleteSchedule(sched.id)).toBe(true);
    expect(s.getSchedule(sched.id)).toBeUndefined();
    s.close();
  });

  test("loop metadata round-trips and can be filtered by kind/status", () => {
    const s = mem();
    const loop = s.createSchedule({
      options: { target: "s:w", prompt: "loop" },
      kind: "loop",
      name: "heartbeat",
      every: "5m",
      intervalMs: 5 * 60_000,
      nextRun: "2099-01-01T00:05:00.000Z",
    });

    expect(s.getSchedule(loop.id)).toMatchObject({
      kind: "loop",
      name: "heartbeat",
      every: "5m",
      intervalMs: 5 * 60_000,
    });
    expect(s.listSchedules({ kind: "loop" })).toHaveLength(1);
    expect(s.listSchedules({ kind: "schedule" })).toHaveLength(0);
    s.updateSchedule(loop.id, { status: "paused" });
    expect(s.listSchedules({ status: "paused", kind: "loop" })).toHaveLength(1);
    expect(s.dueSchedules(Date.parse("2100-01-01T00:00:00.000Z"))).toHaveLength(0);
    s.close();
  });

  test("countSchedules is not capped by list page size", () => {
    const s = mem();
    for (let i = 0; i < 250; i += 1) {
      s.createSchedule({ options: { target: "s:w", prompt: `task ${i}` }, nextRun: "2099-01-01T00:00:00.000Z" });
    }
    expect(s.listSchedules({ status: "scheduled" })).toHaveLength(200);
    expect(s.countSchedules({ status: "scheduled" })).toBe(250);
    expect(s.dueSchedules(Date.parse("2100-01-01T00:00:00.000Z"))).toHaveLength(250);
    s.close();
  });

  test("dueSchedules returns only past-due scheduled entries", () => {
    const s = mem();
    s.createSchedule({ options: { target: "s:w", prompt: "past" }, nextRun: "2000-01-01T00:00:00.000Z" });
    s.createSchedule({ options: { target: "s:w", prompt: "future" }, nextRun: "2099-01-01T00:00:00.000Z" });
    const due = s.dueSchedules(Date.now());
    expect(due).toHaveLength(1);
    expect(due[0]!.options.prompt).toBe("past");
    s.close();
  });

  test("updateSchedule advances next_run and marks fired", () => {
    const s = mem();
    const sched = s.createSchedule({ options: { target: "s:w", prompt: "x" }, nextRun: "2000-01-01T00:00:00.000Z" });
    const fired = s.updateSchedule(sched.id, {
      status: "fired",
      lastDispatchId: "abc123",
      lastFiredAt: "2026-06-17T00:00:00.000Z",
    });
    expect(fired.status).toBe("fired");
    expect(fired.lastDispatchId).toBe("abc123");
    expect(s.dueSchedules(Date.now())).toHaveLength(0); // no longer "scheduled"
    s.close();
  });

  test("schedule failure metadata is persisted and queryable", () => {
    const s = mem();
    const sched = s.createSchedule({ options: { target: "s:w", prompt: "sensitive body" }, nextRun: "2099-01-01T00:00:00.000Z" });
    s.updateSchedule(sched.id, {
      lastFailureAt: "2026-06-23T00:00:00.000Z",
      lastFailureReason: "target pane not found",
      failureCount: 2,
    });
    const after = s.getSchedule(sched.id)!;
    expect(after.lastFailureAt).toBe("2026-06-23T00:00:00.000Z");
    expect(after.lastFailureReason).toBe("target pane not found");
    expect(after.failureCount).toBe(2);
    expect(s.recentScheduleFailures()).toHaveLength(1);
    expect(s.nextScheduled()?.id).toBe(sched.id);
    s.close();
  });

  test("persists across reopen (same file)", () => {
    const path = `/tmp/dispatch_store_${process.pid}_${Math.floor(Math.random() * 1e6)}.db`;
    const s1 = new Store(path);
    const rec = s1.createDispatch({ target: "s:w", prompt: "persist me" });
    s1.close();
    const s2 = new Store(path);
    expect(s2.getDispatch(rec.id)!.prompt).toBe("persist me");
    s2.close();
  });

  test("migrates older schedules table before creating failure index", () => {
    const path = `/tmp/dispatch_store_old_${process.pid}_${Math.floor(Math.random() * 1e6)}.db`;
    const db = new Database(path);
    db.exec(`
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        options_json TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'schedule',
        name TEXT,
        at TEXT,
        cron TEXT,
        every TEXT,
        interval_ms INTEGER,
        next_run TEXT NOT NULL,
        status TEXT NOT NULL,
        last_dispatch_id TEXT,
        last_fired_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.close();
    const s = new Store(path);
    const sched = s.createSchedule({ options: { target: "s:w", prompt: "x" }, nextRun: "2099-01-01T00:00:00.000Z" });
    s.updateSchedule(sched.id, { lastFailureAt: "2026-06-23T00:00:00.000Z", lastFailureReason: "failed", failureCount: 1 });
    expect(s.recentScheduleFailures()).toHaveLength(1);
    s.close();
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  });
});
