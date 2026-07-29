import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { DaemonStatus } from "../daemon/control.js";
import type { Store } from "../lib/store.js";
import { registerDaemonCommands, type DaemonCommandDeps } from "./daemon-commands.js";

const initialExitCode = process.exitCode ?? 0;

beforeEach(() => {
  process.exitCode = initialExitCode;
});

afterEach(() => {
  process.exitCode = initialExitCode;
});

function status(overrides: Partial<DaemonStatus> = {}): DaemonStatus {
  return {
    running: true,
    pid: 4321,
    stale: false,
    health: "alive",
    scheduled: 2,
    paused: 1,
    fired: 3,
    cancelled: 4,
    failed: 1,
    recentDispatches: 9,
    heartbeatStaleMs: 30_000,
    logPath: "/tmp/dispatch.log",
    pidPath: "/tmp/dispatch.pid",
    statePath: "/tmp/dispatch-state.json",
    recentFailures: [],
    ...overrides,
  };
}

function harness(overrides: Partial<DaemonCommandDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let storesClosed = 0;
  const program = new Command();
  registerDaemonCommands(program, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    createStore: () =>
      ({
        close: () => {
          storesClosed += 1;
        },
      }) as Store,
    getDaemonStatus: () => status(),
    cliEntry: () => "/opt/dispatch/cli.js",
    ...overrides,
  });
  return { program, out, err, storesClosed: () => storesClosed };
}

describe("registerDaemonCommands", () => {
  test("status emits detailed human output or a JSON status and always closes its store", async () => {
    const rich = status({
      heartbeatAgeMs: 125,
      lastTickAt: "2026-07-29T10:00:00.000Z",
      nextDue: {
        id: "loop-1",
        kind: "loop",
        status: "scheduled",
        target: "work:1.0",
        machine: "remote",
        nextRun: "2026-07-29T10:05:00.000Z",
      },
      recentFailures: [
        {
          id: "schedule-2",
          status: "scheduled",
          target: "work:2.0",
          nextRun: "2026-07-29T10:10:00.000Z",
          lastFailureAt: "2026-07-29T09:59:00.000Z",
          lastFailureReason: undefined,
        },
      ],
    });
    const h = harness({ getDaemonStatus: () => rich });

    await h.program.parseAsync(["daemon", "status"], { from: "user" });

    expect(h.out).toContain("daemon running (pid 4321)");
    expect(h.out).toContain("  health: alive  heartbeat_age_ms: 125");
    expect(h.out).toContain("  last tick: 2026-07-29T10:00:00.000Z");
    expect(h.out).toContain("  next due: loop-1 loop 2026-07-29T10:05:00.000Z remote/work:1.0");
    expect(h.out).toContain("    schedule-2 2026-07-29T09:59:00.000Z unknown failure");
    expect(h.out).toContain("  scheduled: 2  paused: 1  fired: 3  cancelled: 4  failed: 1");
    expect(h.storesClosed()).toBe(1);

    h.out.length = 0;
    await h.program.parseAsync(["daemon", "status", "--json"], { from: "user" });
    expect(JSON.parse(h.out.join("\n"))).toEqual(rich);
    expect(h.storesClosed()).toBe(2);
  });

  test("status reports stale and stopped daemon boundaries", async () => {
    const statuses = [
      status({ running: false, stale: true, health: "stale" }),
      status({ running: false, pid: undefined, stale: false, health: "dead" }),
    ];
    const h = harness({ getDaemonStatus: () => statuses.shift()! });

    await h.program.parseAsync(["daemon", "status"], { from: "user" });
    expect(h.out[0]).toBe("daemon not running (stale pidfile, pid 4321)");
    h.out.length = 0;
    await h.program.parseAsync(["daemon", "status"], { from: "user" });
    expect(h.out[0]).toBe("daemon not running");
  });

  test("start reports started, already-running, failed, and missing-entry outcomes", async () => {
    const startedEntries: string[] = [];
    const started = harness({
      startDaemon: async (opts) => {
        startedEntries.push(opts.cliEntry);
        return { started: true, alreadyRunning: false, pid: 1001 };
      },
    });
    await started.program.parseAsync(["daemon", "start"], { from: "user" });
    expect(started.out).toEqual(["daemon started (pid 1001)"]);
    expect(startedEntries).toEqual(["/opt/dispatch/cli.js"]);

    const running = harness({
      startDaemon: async () => ({ started: false, alreadyRunning: true, pid: 1002 }),
    });
    await running.program.parseAsync(["daemon", "start"], { from: "user" });
    expect(running.out).toEqual(["daemon already running (pid 1002)"]);

    const failed = harness({
      startDaemon: async () => ({ started: false, alreadyRunning: false }),
    });
    await failed.program.parseAsync(["daemon", "start"], { from: "user" });
    expect(failed.err).toEqual(["daemon failed to start (check the log)"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = initialExitCode;
    let called = false;
    const missing = harness({
      cliEntry: () => undefined,
      startDaemon: async () => {
        called = true;
        return { started: true, alreadyRunning: false, pid: 1003 };
      },
    });
    await missing.program.parseAsync(["daemon", "start"], { from: "user" });
    expect(missing.err).toEqual(["cannot determine CLI entry to launch the daemon"]);
    expect(called).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test("ensure is idempotent when healthy and recovers stale state", async () => {
    let stopped = 0;
    let started = 0;
    const alive = status();
    const healthy = harness({
      getDaemonStatus: () => alive,
      stopDaemon: async () => {
        stopped += 1;
        return { stopped: true, pid: 1, forced: false, wasRunning: true };
      },
      startDaemon: async () => {
        started += 1;
        return { started: true, alreadyRunning: false, pid: 2 };
      },
    });
    await healthy.program.parseAsync(["daemon", "ensure", "--json"], { from: "user" });
    expect(JSON.parse(healthy.out.join("\n"))).toMatchObject({
      ok: true,
      action: "ensure",
      started: false,
      alreadyRunning: true,
    });
    expect({ stopped, started }).toEqual({ stopped: 0, started: 0 });
    expect(healthy.storesClosed()).toBe(1);

    const before = status({ running: false, stale: true, health: "stale" });
    const after = status({ pid: 2222 });
    const statuses = [before, after];
    const recovered = harness({
      getDaemonStatus: () => statuses.shift()!,
      stopDaemon: async () => {
        stopped += 1;
        return { stopped: false, pid: 1111, forced: false, wasRunning: false };
      },
      startDaemon: async () => {
        started += 1;
        return { started: true, alreadyRunning: false, pid: 2222 };
      },
    });
    await recovered.program.parseAsync(["daemon", "ensure"], { from: "user" });
    expect(recovered.out).toEqual(["daemon ensured (pid 2222)"]);
    expect({ stopped, started }).toEqual({ stopped: 1, started: 1 });
    expect(recovered.storesClosed()).toBe(1);
  });

  test("ensure reports missing CLI entry and an unsuccessful health check", async () => {
    const missing = harness({
      cliEntry: () => undefined,
      getDaemonStatus: () => status({ running: false, pid: undefined, health: "dead" }),
    });
    await missing.program.parseAsync(["daemon", "ensure"], { from: "user" });
    expect(missing.err).toEqual(["cannot determine CLI entry to launch the daemon"]);
    expect(missing.storesClosed()).toBe(1);
    expect(process.exitCode).toBe(1);

    process.exitCode = initialExitCode;
    const statuses = [
      status({ running: false, pid: undefined, health: "dead" }),
      status({ running: false, pid: undefined, health: "dead" }),
    ];
    const unhealthy = harness({
      getDaemonStatus: () => statuses.shift()!,
      startDaemon: async () => ({ started: false, alreadyRunning: false }),
    });
    await unhealthy.program.parseAsync(["daemon", "ensure"], { from: "user" });
    expect(unhealthy.out).toEqual(["daemon ensure failed"]);
    expect(process.exitCode).toBe(1);
  });

  test("restart reports success, launch failure, and a missing CLI entry", async () => {
    const stopped = { stopped: true, pid: 1001, forced: false, wasRunning: true };
    const successful = harness({
      stopDaemon: async () => stopped,
      startDaemon: async () => ({ started: true, alreadyRunning: false, pid: 1002 }),
    });
    await successful.program.parseAsync(["daemon", "restart", "--json"], { from: "user" });
    expect(JSON.parse(successful.out.join("\n"))).toEqual({
      action: "restart",
      stopped,
      started: { started: true, alreadyRunning: false, pid: 1002 },
      ok: true,
    });

    const failed = harness({
      stopDaemon: async () => stopped,
      startDaemon: async () => ({ started: false, alreadyRunning: false }),
    });
    await failed.program.parseAsync(["daemon", "restart"], { from: "user" });
    expect(failed.out).toEqual(["daemon restart failed"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = initialExitCode;
    const missing = harness({ cliEntry: () => undefined, stopDaemon: async () => stopped });
    await missing.program.parseAsync(["daemon", "restart"], { from: "user" });
    expect(missing.err).toEqual(["cannot determine CLI entry to launch the daemon"]);
    expect(process.exitCode).toBe(1);
  });

  test("stop distinguishes graceful, forced, stale-pidfile, and already-stopped outcomes", async () => {
    const results = [
      { stopped: true, pid: 1001, forced: false, wasRunning: true },
      { stopped: true, pid: 1002, forced: true, wasRunning: true },
      { stopped: false, pid: 1003, forced: false, wasRunning: false },
      { stopped: false, forced: false, wasRunning: false },
    ];
    const h = harness({ stopDaemon: async () => results.shift()! });

    for (let index = 0; index < 4; index += 1) {
      await h.program.parseAsync(["daemon", "stop"], { from: "user" });
    }

    expect(h.out).toEqual([
      "daemon stopped (pid 1001)",
      "daemon stopped (pid 1002) [forced]",
      "removed stale pidfile (pid 1003 was not running)",
      "daemon is not running",
    ]);
  });

  test("doctor reports healthy state and actionable unhealthy findings", async () => {
    const healthy = harness();
    await healthy.program.parseAsync(["daemon", "doctor"], { from: "user" });
    expect(healthy.out).toEqual(["daemon doctor: ok"]);
    expect(process.exitCode).toBe(initialExitCode);

    const unhealthyStatus = status({
      running: false,
      pid: undefined,
      health: "dead",
      scheduled: 2,
      recentFailures: [
        {
          id: "schedule-1",
          status: "scheduled",
          target: "work:1.0",
          nextRun: "2026-07-29T10:10:00.000Z",
        },
      ],
    });
    const unhealthy = harness({ getDaemonStatus: () => unhealthyStatus });
    await unhealthy.program.parseAsync(["daemon", "doctor", "--json"], { from: "user" });
    const result = JSON.parse(unhealthy.out.join("\n"));
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual([
      "daemon is not running; run `dispatch daemon ensure` or install the user service",
      "2 scheduled item(s) cannot fire until the daemon is alive",
      "1 recent schedule/loop failure(s) recorded",
    ]);
    expect(process.exitCode).toBe(1);
    expect(unhealthy.storesClosed()).toBe(1);
  });

  test("service rejects unknown actions and renders service success or permission failure", async () => {
    let called = false;
    const unknown = harness({
      serviceAction: () => {
        called = true;
        return { ok: true, action: "status", detail: "unexpected" };
      },
    });
    await unknown.program.parseAsync(["daemon", "service", "bogus"], { from: "user" });
    expect(unknown.err).toEqual(["unknown service action: bogus"]);
    expect(called).toBe(false);
    expect(process.exitCode).toBe(1);

    process.exitCode = initialExitCode;
    const failed = harness({
      serviceAction: (action, opts) => ({
        ok: false,
        action,
        detail: `permission denied for ${opts.cliEntry}`,
        unitPath: "/home/user/.config/systemd/user/dispatch.service",
        stdout: " service output \n",
        stderr: " permission denied \n",
      }),
    });
    await failed.program.parseAsync(["daemon", "service", "install", "--start"], { from: "user" });
    expect(failed.out).toEqual([
      "permission denied for /opt/dispatch/cli.js",
      "unit: /home/user/.config/systemd/user/dispatch.service",
      "service output",
    ]);
    expect(failed.err).toEqual(["permission denied"]);
    expect(process.exitCode).toBe(1);

    process.exitCode = initialExitCode;
    const success = harness({
      serviceAction: (action) => ({ ok: true, action, detail: "service running" }),
    });
    await success.program.parseAsync(["daemon", "service", "status", "--json"], { from: "user" });
    expect(JSON.parse(success.out.join("\n"))).toEqual({ ok: true, action: "status", detail: "service running" });
  });

  test("run forwards parsed and omitted intervals to the foreground daemon", async () => {
    const intervals: Array<number | undefined> = [];
    const h = harness({
      runDaemon: async (opts) => {
        intervals.push(opts.intervalMs);
      },
    });

    await h.program.parseAsync(["daemon", "run", "--interval", "250"], { from: "user" });
    await h.program.parseAsync(["daemon", "run"], { from: "user" });
    expect(intervals).toEqual([250, undefined]);
  });
});
