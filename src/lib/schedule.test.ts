import { describe, expect, test } from "bun:test";
import { computeNextRun, nextCronRun, parseCron, parseDurationMs } from "./schedule.js";

describe("parseCron", () => {
  test("rejects wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
  });
  test("expands ranges, steps, lists", () => {
    const c = parseCron("0,30 9-17 * * 1-5");
    expect([...c.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(c.hour.has(9)).toBe(true);
    expect(c.hour.has(17)).toBe(true);
    expect(c.hour.has(18)).toBe(false);
    expect(c.dow.has(1)).toBe(true);
    expect(c.dow.has(0)).toBe(false);
  });
  test("treats 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").dow.has(0)).toBe(true);
  });
});

describe("nextCronRun", () => {
  test("every minute -> next minute", () => {
    const from = new Date("2026-06-17T10:00:30.000Z");
    const next = nextCronRun("* * * * *", from);
    expect(next.toISOString()).toBe("2026-06-17T10:01:00.000Z");
  });

  test("daily at a fixed local time finds the next occurrence", () => {
    const from = new Date("2026-06-17T10:00:00");
    const next = nextCronRun("30 14 * * *", from); // 14:30 local
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  test("is strictly after `from` even when from matches", () => {
    const from = new Date("2026-06-17T10:00:00");
    const next = nextCronRun("0 10 * * *", from); // 10:00 local, matches from
    expect(next.getDate()).toBe(18); // rolls to next day
  });
});

describe("parseDurationMs", () => {
  test("accepts compact and spaced practical durations", () => {
    expect(parseDurationMs("30m")).toBe(30 * 60_000);
    expect(parseDurationMs("30min")).toBe(30 * 60_000);
    expect(parseDurationMs("5 minutes")).toBe(5 * 60_000);
    expect(parseDurationMs("2h")).toBe(2 * 60 * 60_000);
    expect(parseDurationMs("1d")).toBe(24 * 60 * 60_000);
  });

  test("rejects invalid durations", () => {
    expect(() => parseDurationMs("soon")).toThrow(/invalid duration/);
    expect(() => parseDurationMs("0m")).toThrow(/invalid duration/);
    expect(() => parseDurationMs("5 parsecs")).toThrow(/invalid duration/);
  });
});

describe("computeNextRun", () => {
  test("at returns the normalized ISO time", () => {
    expect(computeNextRun({ at: "2099-01-02T03:04:00Z" })).toBe("2099-01-02T03:04:00.000Z");
  });
  test("in returns a relative one-shot time", () => {
    expect(computeNextRun({ in: "30m" }, new Date("2026-06-17T10:00:00.000Z"))).toBe(
      "2026-06-17T10:30:00.000Z",
    );
  });
  test("every returns a recurring interval time", () => {
    expect(computeNextRun({ every: "5 minutes" }, new Date("2026-06-17T10:00:00.000Z"))).toBe(
      "2026-06-17T10:05:00.000Z",
    );
  });
  test("rejects invalid at", () => {
    expect(() => computeNextRun({ at: "not-a-date" })).toThrow(/invalid/);
  });
  test("requires exactly one timing mode", () => {
    expect(() => computeNextRun({})).toThrow(/requires/);
    expect(() => computeNextRun({ at: "2099-01-01T00:00:00Z", every: "5m" })).toThrow(/exactly one/);
  });
});
