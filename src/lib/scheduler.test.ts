import { describe, expect, test } from "bun:test";
import { tick } from "./scheduler.js";
import { Store } from "./store.js";
import type { DispatchOptions, DispatchRecord } from "../types.js";

function fakeRecord(id: string, status: DispatchRecord["status"] = "delivered"): DispatchRecord {
  return {
    id,
    target: "s:w",
    machine: "local",
    prompt: "x",
    status,
    createdAt: "x",
    updatedAt: "x",
  };
}

function counter() {
  const calls: DispatchOptions[] = [];
  let n = 0;
  const dispatch = async (options: DispatchOptions): Promise<DispatchRecord> => {
    calls.push(options);
    return fakeRecord(`rec${++n}`);
  };
  return { calls, dispatch };
}

describe("scheduler.tick", () => {
  test("fires a past-due one-shot exactly once and marks it fired", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "go" },
      at: "2000-01-01T00:00:00.000Z",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const { calls, dispatch } = counter();

    const res = await tick({ store, dispatch });
    expect(calls).toHaveLength(1);
    expect(res.fired).toHaveLength(1);
    expect(store.getSchedule(sched.id)!.status).toBe("fired");
    expect(store.getSchedule(sched.id)!.lastDispatchId).toBe("rec1");

    // Subsequent ticks do not re-fire it.
    const res2 = await tick({ store, dispatch });
    expect(res2.fired).toHaveLength(0);
    expect(calls).toHaveLength(1);
    store.close();
  });

  test("does not fire a future schedule", async () => {
    const store = new Store(":memory:");
    store.createSchedule({
      options: { target: "s:w", prompt: "later" },
      at: "2099-01-01T00:00:00.000Z",
      nextRun: "2099-01-01T00:00:00.000Z",
    });
    const { calls, dispatch } = counter();
    const res = await tick({ store, dispatch });
    expect(calls).toHaveLength(0);
    expect(res.fired).toHaveLength(0);
    store.close();
  });

  test("a cron schedule fires and reschedules to a future run, staying scheduled", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "tick" },
      cron: "* * * * *",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const { calls, dispatch } = counter();
    const fixedNow = new Date("2026-06-17T10:00:30.000Z");

    const res = await tick({ store, dispatch, now: () => fixedNow });
    expect(calls).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("scheduled");
    expect(new Date(after.nextRun).getTime()).toBeGreaterThan(fixedNow.getTime());
    expect(after.lastDispatchId).toBe("rec1");
    store.close();
  });

  test("an interval loop fires once per tick and reschedules after the attempt completes", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "loop" },
      kind: "loop",
      every: "5m",
      intervalMs: 5 * 60_000,
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const { calls, dispatch } = counter();
    const fixedNow = new Date("2026-06-17T10:00:30.000Z");

    const res = await tick({ store, dispatch, now: () => fixedNow });
    expect(calls).toHaveLength(1);
    expect(res.fired).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("scheduled");
    expect(after.nextRun).toBe("2026-06-17T10:05:30.000Z");
    expect(after.lastDispatchId).toBe("rec1");
    store.close();
  });

  test("a one-shot dispatch error stays scheduled at a retry time and is reported", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "boom" },
      at: "2000-01-01T00:00:00.000Z",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const errors: unknown[] = [];
    const fixedNow = new Date("2026-06-17T10:00:00.000Z");
    const res = await tick({
      store,
      dispatch: async () => {
        throw new Error("tmux down");
      },
      now: () => fixedNow,
      retryDelayMs: 5_000,
      onError: (_s, e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    expect(res.fired).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("scheduled");
    expect(after.nextRun).toBe("2026-06-17T10:00:05.000Z");
    store.close();
  });

  test("a one-shot gives up (status failed) after its retry window is exhausted", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "dead:0", prompt: "permanently broken" },
      at: "2000-01-01T00:00:00.000Z",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const errors: unknown[] = [];
    // now is just after creation; window of 0 means "already exhausted".
    const fixedNow = new Date(Date.now() + 5_000);
    const res = await tick({
      store,
      dispatch: async () => {
        throw new Error("target pane not found");
      },
      now: () => fixedNow,
      maxRetryWindowMs: 0,
      onError: (_s, e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    expect(res.failed).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("failed");
    // A subsequent tick must not re-fire a failed (terminal) schedule.
    const res2 = await tick({
      store,
      dispatch: async () => fakeRecord("should-not-run"),
      now: () => new Date(Date.now() + 10_000),
      maxRetryWindowMs: 0,
    });
    expect(res2.fired).toHaveLength(0);
    expect(res2.failed).toHaveLength(0);
    store.close();
  });

  test("a cron schedule keeps retrying on failure regardless of the retry window", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "cron-fail" },
      cron: "* * * * *",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const res = await tick({
      store,
      dispatch: async () => {
        throw new Error("transient");
      },
      now: () => new Date("2026-06-17T10:00:30.000Z"),
      maxRetryWindowMs: 0, // would expire a one-shot, but crons ignore it
    });
    expect(res.failed).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("scheduled");
    expect(new Date(after.nextRun).getTime()).toBeGreaterThan(Date.parse("2026-06-17T10:00:30.000Z"));
    store.close();
  });

  test("an interval loop keeps retrying at its interval on failure", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "loop-fail" },
      kind: "loop",
      every: "30s",
      intervalMs: 30_000,
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const res = await tick({
      store,
      dispatch: async () => fakeRecord("rec-loop-failed", "skipped"),
      now: () => new Date("2026-06-17T10:00:30.000Z"),
      maxRetryWindowMs: 0,
    });
    expect(res.failed).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("scheduled");
    expect(after.nextRun).toBe("2026-06-17T10:01:00.000Z");
    expect(after.lastDispatchId).toBe("rec-loop-failed");
    store.close();
  });

  test("a failed dispatch record does not consume a one-shot schedule", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "failed-record" },
      at: "2000-01-01T00:00:00.000Z",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const res = await tick({
      store,
      dispatch: async () => fakeRecord("rec-failed", "failed"),
      now: () => new Date("2026-06-17T10:00:00.000Z"),
      retryDelayMs: 5_000,
    });
    expect(res.fired).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("scheduled");
    expect(after.lastDispatchId).toBe("rec-failed");
    expect(after.nextRun).toBe("2026-06-17T10:00:05.000Z");
    store.close();
  });

  test("a skipped dispatch record does not consume a one-shot schedule", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "skipped-record" },
      at: "2000-01-01T00:00:00.000Z",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const res = await tick({
      store,
      dispatch: async () => fakeRecord("rec-skipped", "skipped"),
      now: () => new Date("2026-06-17T10:00:00.000Z"),
      retryDelayMs: 5_000,
    });
    expect(res.fired).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    const after = store.getSchedule(sched.id)!;
    expect(after.status).toBe("scheduled");
    expect(after.lastDispatchId).toBe("rec-skipped");
    expect(after.nextRun).toBe("2026-06-17T10:00:05.000Z");
    store.close();
  });

  test("cancelled schedules never fire", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "no" },
      at: "2000-01-01T00:00:00.000Z",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    store.updateSchedule(sched.id, { status: "cancelled" });
    const { calls, dispatch } = counter();
    const res = await tick({ store, dispatch });
    expect(calls).toHaveLength(0);
    expect(res.fired).toHaveLength(0);
    store.close();
  });

  test("pause during an in-flight dispatch is preserved", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "pause-me" },
      kind: "loop",
      every: "5m",
      intervalMs: 5 * 60_000,
      nextRun: "2000-01-01T00:00:00.000Z",
    });

    const res = await tick({
      store,
      dispatch: async () => {
        store.updateSchedule(sched.id, { status: "paused" });
        return fakeRecord("rec-paused");
      },
      now: () => new Date("2026-06-17T10:00:00.000Z"),
    });

    expect(res.fired).toHaveLength(0);
    expect(store.getSchedule(sched.id)).toMatchObject({ status: "paused", lastDispatchId: undefined });
    store.close();
  });

  test("cancel during an in-flight dispatch is preserved", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "cancel-me" },
      nextRun: "2000-01-01T00:00:00.000Z",
    });

    const res = await tick({
      store,
      dispatch: async () => {
        store.updateSchedule(sched.id, { status: "cancelled" });
        return fakeRecord("rec-cancelled");
      },
      now: () => new Date("2026-06-17T10:00:00.000Z"),
    });

    expect(res.fired).toHaveLength(0);
    expect(store.getSchedule(sched.id)).toMatchObject({ status: "cancelled", lastDispatchId: undefined });
    store.close();
  });

  test("clear during an in-flight dispatch does not abort later due schedules", async () => {
    const store = new Store(":memory:");
    const doomed = store.createSchedule({
      options: { target: "s:w", prompt: "clear-me" },
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const survivor = store.createSchedule({
      options: { target: "s:w", prompt: "survivor" },
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    let calls = 0;

    const res = await tick({
      store,
      dispatch: async () => {
        calls += 1;
        if (calls === 1) {
          store.deleteSchedule(doomed.id);
          return fakeRecord("rec-cleared");
        }
        return fakeRecord("rec-survivor");
      },
      now: () => new Date("2026-06-17T10:00:00.000Z"),
    });

    expect(calls).toBe(2);
    expect(res.fired).toHaveLength(1);
    expect(store.getSchedule(doomed.id)).toBeUndefined();
    expect(store.getSchedule(survivor.id)).toMatchObject({ status: "fired", lastDispatchId: "rec-survivor" });
    store.close();
  });

  test("fires multiple due schedules in one tick", async () => {
    const store = new Store(":memory:");
    for (const p of ["a", "b", "c"]) {
      store.createSchedule({ options: { target: "s:w", prompt: p }, nextRun: "2000-01-01T00:00:00.000Z" });
    }
    const { calls, dispatch } = counter();
    const res = await tick({ store, dispatch });
    expect(calls).toHaveLength(3);
    expect(res.fired).toHaveLength(3);
    store.close();
  });
});
