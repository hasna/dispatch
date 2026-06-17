import { describe, expect, test } from "bun:test";
import { tick } from "./scheduler.js";
import { Store } from "./store.js";
import type { DispatchOptions, DispatchRecord } from "../types.js";

function fakeRecord(id: string): DispatchRecord {
  return {
    id,
    target: "s:w",
    machine: "local",
    prompt: "x",
    status: "delivered",
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

  test("a dispatch error still advances the schedule (no spin) and is reported", async () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({
      options: { target: "s:w", prompt: "boom" },
      at: "2000-01-01T00:00:00.000Z",
      nextRun: "2000-01-01T00:00:00.000Z",
    });
    const errors: unknown[] = [];
    const res = await tick({
      store,
      dispatch: async () => {
        throw new Error("tmux down");
      },
      onError: (_s, e) => errors.push(e),
    });
    expect(errors).toHaveLength(1);
    expect(res.fired).toHaveLength(1);
    expect(store.getSchedule(sched.id)!.status).toBe("fired");
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
