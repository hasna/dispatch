import { describe, expect, test } from "bun:test";
import { DispatchClient } from "./index.js";
import { Store } from "../lib/store.js";

describe("DispatchClient", () => {
  test("records and looks up dispatches via the store", () => {
    const store = new Store(":memory:");
    const client = new DispatchClient({ store });
    // simulate a recorded dispatch directly through the store the client uses
    const rec = store.createDispatch({ target: "s:w", prompt: "hi", status: "delivered" });
    expect(client.status(rec.id)!.prompt).toBe("hi");
    expect(client.list({ status: "delivered" })).toHaveLength(1);
    client.close();
  });

  test("schedule requires exactly one timing mode and computes nextRun", () => {
    const store = new Store(":memory:");
    const client = new DispatchClient({ store });
    expect(() => client.schedule({ options: { target: "s:w", prompt: "x" } })).toThrow(/exactly one/);
    expect(() =>
      client.schedule({
        options: { target: "s:w", prompt: "x" },
        at: "2099-01-01T00:00:00Z",
        every: "5m",
      }),
    ).toThrow(/exactly one/);

    const sched = client.schedule({
      options: { target: "s:w", prompt: "later" },
      cron: "*/5 * * * *",
      from: new Date("2026-06-17T10:01:00Z"),
    });
    expect(sched.status).toBe("scheduled");
    expect(new Date(sched.nextRun).getTime()).toBeGreaterThan(Date.parse("2026-06-17T10:01:00Z"));
    expect(client.listSchedules({ status: "scheduled" })).toHaveLength(1);

    const relative = client.schedule({
      options: { target: "s:w", prompt: "relative" },
      in: "30m",
      from: new Date("2026-06-17T10:00:00Z"),
    });
    expect(relative.at).toBe("2026-06-17T10:30:00.000Z");
    client.close();
  });

  test("loop creates a recurring interval schedule with metadata", () => {
    const store = new Store(":memory:");
    const client = new DispatchClient({ store });
    const loop = client.loop({
      options: { target: "s:w", prompt: "poll", queue: true },
      every: "5m",
      name: "poller",
      from: new Date("2026-06-17T10:00:00Z"),
    });

    expect(loop).toMatchObject({
      kind: "loop",
      name: "poller",
      every: "5m",
      intervalMs: 5 * 60_000,
      nextRun: "2026-06-17T10:05:00.000Z",
    });
    expect(client.scheduleStatus(loop.id)).toMatchObject({ id: loop.id, kind: "loop" });
    expect(client.listLoops()).toHaveLength(1);
    const cron = client.schedule({
      options: { target: "s:w", prompt: "cron" },
      cron: "*/5 * * * *",
      from: new Date("2026-06-17T10:00:00Z"),
    });
    expect(cron.kind).toBe("schedule");
    client.close();
  });

  test("pause/resume/cancel/clear lifecycle", () => {
    const store = new Store(":memory:");
    const client = new DispatchClient({ store });
    const sched = client.loop({
      options: { target: "s:w", prompt: "y" },
      every: "5m",
      from: new Date("2026-06-17T10:00:00Z"),
    });
    expect(client.pauseSchedule(sched.id)).toBe(true);
    expect(store.getSchedule(sched.id)!.status).toBe("paused");
    expect(client.pauseSchedule(sched.id)).toBe(false);
    expect(client.resumeSchedule(sched.id, new Date("2026-06-17T11:00:00Z"))).toBe(true);
    expect(store.getSchedule(sched.id)!.nextRun).toBe("2026-06-17T11:05:00.000Z");
    expect(client.cancelSchedule(sched.id)).toBe(true);
    expect(client.cancelSchedule(sched.id)).toBe(false); // already cancelled
    expect(store.getSchedule(sched.id)!.status).toBe("cancelled");
    expect(client.clearSchedule(sched.id)).toBe(true);
    expect(store.getSchedule(sched.id)).toBeUndefined();
    client.close();
  });

  test("persist:false disables the store (no status, scheduling throws)", () => {
    const client = new DispatchClient({ persist: false });
    expect(client.status("anything")).toBeUndefined();
    expect(client.list()).toEqual([]);
    expect(() => client.schedule({ options: { target: "s:w", prompt: "x" }, at: "2099-01-01T00:00:00Z" })).toThrow(
      /requires a persistent store/,
    );
    client.close();
  });
});
