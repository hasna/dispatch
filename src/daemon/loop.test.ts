import { describe, expect, test } from "bun:test";
import { runLoop } from "./loop.js";

const noSleep = async () => {};

describe("runLoop", () => {
  test("runs until shouldStop returns true", async () => {
    let ticks = 0;
    await runLoop({
      tickFn: () => {
        ticks++;
      },
      intervalMs: 0,
      sleep: noSleep,
      shouldStop: () => ticks >= 3,
    });
    expect(ticks).toBe(3);
  });

  test("does not tick at all if shouldStop is true up front", async () => {
    let ticks = 0;
    await runLoop({
      tickFn: () => {
        ticks++;
      },
      intervalMs: 0,
      sleep: noSleep,
      shouldStop: () => true,
    });
    expect(ticks).toBe(0);
  });

  test("a throwing tick is reported but does not stop the loop", async () => {
    let ticks = 0;
    const errors: unknown[] = [];
    await runLoop({
      tickFn: () => {
        ticks++;
        throw new Error(`boom ${ticks}`);
      },
      intervalMs: 0,
      sleep: noSleep,
      shouldStop: () => ticks >= 3,
      onTickError: (e) => errors.push(e),
    });
    expect(ticks).toBe(3);
    expect(errors).toHaveLength(3);
  });

  test("sleeps between ticks but not after the last", async () => {
    let ticks = 0;
    const sleeps: number[] = [];
    await runLoop({
      tickFn: () => {
        ticks++;
      },
      intervalMs: 50,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      shouldStop: () => ticks >= 3,
    });
    expect(sleeps).toEqual([50, 50]); // after tick 1 and 2, not after 3
  });
});
