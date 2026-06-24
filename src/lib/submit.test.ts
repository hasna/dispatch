import { describe, expect, test } from "bun:test";
import { submit } from "./submit.js";
import { Tmux } from "./tmux.js";
import { MockRunner } from "../test/mock-runner.js";

function enterCount(r: MockRunner): number {
  return r.argvs().filter((a) => a[0] === "tmux" && a[1] === "send-keys" && a.includes("Enter")).length;
}

const noSleep = async () => {};

describe("submit", () => {
  test("waits the delay before the first Enter", async () => {
    const r = new MockRunner();
    const slept: number[] = [];
    await submit(new Tmux(r), "s:w", {
      delayMs: 1234,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept[0]).toBe(1234);
    expect(enterCount(r)).toBe(1);
  });

  test("waits for a prompt-parked probe before the first Enter", async () => {
    const r = new MockRunner();
    const order: string[] = [];
    let probes = 0;
    r.responder = (argv) => {
      if (argv[1] === "send-keys" && argv.includes("Enter")) order.push("enter");
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };

    const res = await submit(new Tmux(r), "s:w", {
      delayMs: 0,
      sleep: async (ms) => {
        order.push(`sleep:${ms}`);
      },
      isPromptParked: () => {
        order.push("probe");
        probes += 1;
        return probes >= 3;
      },
      settleIntervalMs: 25,
      maxSettlePolls: 5,
    });

    expect(res).toEqual({ submitted: true, attempts: 1 });
    expect(order).toEqual(["sleep:0", "probe", "sleep:25", "probe", "sleep:25", "probe", "enter"]);
    expect(enterCount(r)).toBe(1);
  });

  test("no probe = single best-effort Enter, reported submitted", async () => {
    const r = new MockRunner();
    const res = await submit(new Tmux(r), "s:w", { delayMs: 0, sleep: noSleep });
    expect(res).toEqual({ submitted: true, attempts: 1 });
    expect(enterCount(r)).toBe(1);
  });

  test("probe true after first Enter = no retries", async () => {
    const r = new MockRunner();
    const res = await submit(new Tmux(r), "s:w", {
      delayMs: 0,
      sleep: noSleep,
      isSubmitted: () => true,
    });
    expect(res).toEqual({ submitted: true, attempts: 1 });
    expect(enterCount(r)).toBe(1);
  });

  test("retries Enter until the probe confirms submission", async () => {
    const r = new MockRunner();
    let probes = 0;
    const res = await submit(new Tmux(r), "s:w", {
      delayMs: 0,
      sleep: noSleep,
      maxRetries: 3,
      isSubmitted: () => ++probes >= 3, // false, false, true
    });
    expect(res.submitted).toBe(true);
    // initial Enter + 2 retries (probe true on the 3rd probe)
    expect(res.attempts).toBe(3);
    expect(enterCount(r)).toBe(3);
  });

  test("gives up after maxRetries and reports not submitted", async () => {
    const r = new MockRunner();
    const res = await submit(new Tmux(r), "s:w", {
      delayMs: 0,
      sleep: noSleep,
      maxRetries: 2,
      isSubmitted: () => false,
    });
    expect(res.submitted).toBe(false);
    // initial Enter + exactly maxRetries retries
    expect(res.attempts).toBe(3);
    expect(enterCount(r)).toBe(3);
  });

  test("supports async probes", async () => {
    const r = new MockRunner();
    let n = 0;
    const res = await submit(new Tmux(r), "s:w", {
      delayMs: 0,
      sleep: noSleep,
      maxRetries: 5,
      isSubmitted: async () => ++n >= 2,
    });
    expect(res.submitted).toBe(true);
    expect(res.attempts).toBe(2);
  });
});
