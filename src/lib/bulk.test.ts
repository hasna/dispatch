import { describe, expect, test } from "bun:test";
import { MockRunner } from "../test/mock-runner.js";
import { Tmux } from "./tmux.js";
import { performBulkDispatch } from "./bulk.js";

function agentTmux(capture = "> idle composer"): Tmux {
  const r = new MockRunner();
  let submitted = false;
  r.responder = (argv) => {
    if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
      return { stdout: "codewith\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_in_mode}") {
      return { stdout: "0\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "send-keys" && argv.includes("Enter")) {
      submitted = true;
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "capture-pane") {
      return { stdout: submitted ? "✶ Working… (esc to interrupt)" : capture, stderr: "", exitCode: 0, source: "local" };
    }
    return { stdout: "", stderr: "", exitCode: 0, source: "local" };
  };
  return new Tmux(r);
}

describe("performBulkDispatch", () => {
  test("dry-runs explicit bulk sends with configured concurrency and jitter", async () => {
    const sleeps: number[] = [];
    const result = await performBulkDispatch(
      {
        targets: [{ target: "work:1.1" }, { target: "work:1.2" }],
        prompt: "Bulk prompt",
        dryRun: true,
        maxConcurrency: 2,
        jitterMs: 20,
        perMachineLimit: 1,
      },
      {
        makeTmux: async () => agentTmux(),
        random: () => 0.5,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(result).toMatchObject({
      status: "completed",
      source: "explicit",
      requested: 2,
      planned: 2,
      delivered: 0,
      skipped: 2,
      failed: 0,
      dryRun: true,
      maxConcurrency: 2,
      jitterMs: 20,
      perMachineLimit: 1,
    });
    expect(sleeps).toContain(10);
    expect(result.records.every((r) => r.detail?.includes("dry run"))).toBe(true);
  });

  test("sessions-query bulk sends default to idle-only delivery", async () => {
    const result = await performBulkDispatch(
      {
        source: "sessions-query",
        targets: [{ target: "open-sessions:2.1", machine: "spark02", source: "sessions-query", state: "active" }],
        prompt: "Do not hit busy sessions",
        queue: false,
      },
      {
        makeTmux: async () => agentTmux("✶ Working… (esc to interrupt)"),
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.skipped).toBe(1);
    expect(result.detail).toMatch(/skipped/);
    expect(result.records[0]).toMatchObject({
      target: "open-sessions:2.1",
      status: "skipped",
      targetState: "active",
    });
  });

  test("explicit bulk sends also default to idle-only delivery", async () => {
    const result = await performBulkDispatch(
      {
        targets: [{ target: "open-a:1.1" }, { target: "open-b:1.1" }],
        prompt: "Do not touch active panes by default",
      },
      {
        makeTmux: async () => agentTmux("✶ Working… (esc to interrupt)"),
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.skipped).toBe(2);
    expect(result.delivered).toBe(0);
    expect(result.records.every((r) => r.targetState === "active")).toBe(true);
  });

  test("queue permits active sessions-query targets explicitly", async () => {
    const result = await performBulkDispatch(
      {
        source: "sessions-query",
        targets: [{ target: "open-sessions:2.1", source: "sessions-query", state: "active" }],
        prompt: "Queue this",
        queue: true,
        submit: false,
      },
      {
        makeTmux: async () => agentTmux("✶ Working… (esc to interrupt)"),
        sleep: async () => undefined,
      },
    );

    expect(result.delivered).toBe(1);
    expect(result.records[0]).toMatchObject({ status: "delivered", targetState: "active" });
  });

  test("returns a failed summary when a source resolves no targets", async () => {
    const result = await performBulkDispatch(
      { source: "sessions-query", targets: [], prompt: "No targets" },
      { makeTmux: async () => agentTmux() },
    );

    expect(result).toMatchObject({
      status: "failed",
      source: "sessions-query",
      requested: 0,
      planned: 0,
      detail: "no targets resolved",
    });
  });

  test("records machine setup failures and continues with other targets", async () => {
    const result = await performBulkDispatch(
      {
        targets: [
          { target: "bad:1.1", machine: "bad-machine" },
          { target: "good:1.1", machine: "local" },
        ],
        prompt: "Bulk prompt",
        goal: true,
        submit: false,
      },
      {
        makeTmux: async (machine) => {
          if (machine === "bad-machine") throw new Error("route unavailable");
          return agentTmux();
        },
        sleep: async () => undefined,
      },
    );

    expect(result.status).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.records.find((r) => r.target === "bad:1.1")).toMatchObject({
      status: "failed",
      machine: "bad-machine",
      prompt: "/goal Bulk prompt",
      detail: "bulk dispatch failed before delivery: route unavailable",
    });
  });
});
