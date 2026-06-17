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

  test("schedule requires at or cron and computes nextRun", () => {
    const store = new Store(":memory:");
    const client = new DispatchClient({ store });
    expect(() => client.schedule({ options: { target: "s:w", prompt: "x" } })).toThrow(/at.*cron/);

    const sched = client.schedule({
      options: { target: "s:w", prompt: "later" },
      cron: "*/5 * * * *",
      from: new Date("2026-06-17T10:01:00Z"),
    });
    expect(sched.status).toBe("scheduled");
    expect(new Date(sched.nextRun).getTime()).toBeGreaterThan(Date.parse("2026-06-17T10:01:00Z"));
    expect(client.listSchedules({ status: "scheduled" })).toHaveLength(1);
    client.close();
  });

  test("cancelSchedule flips status and is idempotent", () => {
    const store = new Store(":memory:");
    const client = new DispatchClient({ store });
    const sched = client.schedule({ options: { target: "s:w", prompt: "y" }, at: "2099-01-01T00:00:00Z" });
    expect(client.cancelSchedule(sched.id)).toBe(true);
    expect(client.cancelSchedule(sched.id)).toBe(false); // already cancelled
    expect(store.getSchedule(sched.id)!.status).toBe("cancelled");
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
