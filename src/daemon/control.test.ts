import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claimPid,
  daemonStatus,
  isAlive,
  isDaemonRunning,
  readDaemonState,
  readPid,
  removePid,
  signalStop,
  stopDaemon,
  writeDaemonState,
  writePid,
} from "./control.js";
import { Store } from "../lib/store.js";

const pidPath = join(tmpdir(), `dispatch_test_pid_${process.pid}_${Math.floor(Math.random() * 1e6)}.pid`);
const statePath = join(tmpdir(), `dispatch_test_state_${process.pid}_${Math.floor(Math.random() * 1e6)}.json`);
const DEAD_PID = 2147480000; // almost certainly not a live process

function spawnNamedSleeper(argv0: string) {
  return spawn("bash", ["-lc", 'exec -a "$0" sleep 30', argv0], { stdio: "ignore" });
}

afterEach(() => {
  rmSync(pidPath, { force: true });
  rmSync(statePath, { force: true });
});

describe("pidfile", () => {
  test("write/read/remove round-trips", () => {
    writePid(4242, pidPath);
    expect(readPid(pidPath)).toBe(4242);
    removePid(pidPath);
    expect(readPid(pidPath)).toBeUndefined();
    expect(existsSync(pidPath)).toBe(false);
  });
  test("claimPid recovers a stale pidfile atomically", () => {
    writePid(DEAD_PID, pidPath);
    const claimed = claimPid(process.pid, pidPath);
    expect(claimed.claimed).toBe(true);
    expect(readPid(pidPath)).toBe(process.pid);
  });
  test("claimPid refuses an already running owned daemon", () => {
    writePid(process.pid, pidPath);
    const claimed = claimPid(12345, pidPath);
    expect(claimed.claimed).toBe(false);
    expect(claimed.pid).toBe(process.pid);
  });
});

describe("daemon state", () => {
  test("write/read daemon heartbeat state", () => {
    writeDaemonState({ pid: 123, startedAt: "2026-06-23T00:00:00.000Z", intervalMs: 1000, lastTickAt: "2026-06-23T00:00:01.000Z" }, statePath);
    expect(readDaemonState(statePath)).toMatchObject({ pid: 123, intervalMs: 1000, lastTickAt: "2026-06-23T00:00:01.000Z" });
  });
});

describe("isAlive", () => {
  test("true for the current process, false for a dead pid", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(DEAD_PID)).toBe(false);
  });
});

describe("isDaemonRunning", () => {
  test("no pidfile -> not running", () => {
    expect(isDaemonRunning(pidPath)).toEqual({ running: false, stale: false });
  });
  test("live pid -> running", () => {
    writePid(process.pid, pidPath);
    expect(isDaemonRunning(pidPath)).toEqual({ running: true, pid: process.pid, stale: false });
  });
  test("dead pid -> stale", () => {
    writePid(DEAD_PID, pidPath);
    expect(isDaemonRunning(pidPath)).toEqual({ running: false, pid: DEAD_PID, stale: true });
  });
  test("plain pidfile pointing at an unrelated live process is stale and is not stopped", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      expect(child.pid).toBeDefined();
      writeFileSync(pidPath, String(child.pid));
      expect(isDaemonRunning(pidPath)).toEqual({ running: false, pid: child.pid, stale: true });
      const stopped = await stopDaemon({ path: pidPath, sleep: async () => {} });
      expect(stopped.wasRunning).toBe(false);
      expect(isAlive(child.pid!)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
  test("owned direct daemon entrypoint pidfile is recognized and stopped", async () => {
    const child = spawnNamedSleeper(join(import.meta.dir, "index.ts"));
    try {
      expect(child.pid).toBeDefined();
      await Bun.sleep(20);
      writePid(child.pid!, pidPath);
      expect(isDaemonRunning(pidPath)).toEqual({ running: true, pid: child.pid, stale: false });
      const stopped = await stopDaemon({ path: pidPath, timeoutMs: 500, sleep: () => Bun.sleep(10) });
      expect(stopped.wasRunning).toBe(true);
      expect(stopped.stopped).toBe(true);
      expect(isAlive(child.pid!)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
  test("owned dispatch-daemon bin pidfile is recognized and stopped", async () => {
    const child = spawnNamedSleeper("dispatch-daemon");
    try {
      expect(child.pid).toBeDefined();
      await Bun.sleep(20);
      writePid(child.pid!, pidPath);
      expect(isDaemonRunning(pidPath)).toEqual({ running: true, pid: child.pid, stale: false });
      const stopped = await stopDaemon({ path: pidPath, timeoutMs: 500, sleep: () => Bun.sleep(10) });
      expect(stopped.wasRunning).toBe(true);
      expect(stopped.stopped).toBe(true);
      expect(isAlive(child.pid!)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("daemonStatus", () => {
  test("combines process + store counts", () => {
    const store = new Store(":memory:");
    store.createSchedule({ options: { target: "s:w", prompt: "x" }, nextRun: "2099-01-01T00:00:00Z" });
    const paused = store.createSchedule({ options: { target: "s:w", prompt: "paused" }, nextRun: "2099-01-01T00:00:00Z" });
    store.updateSchedule(paused.id, { status: "paused" });
    store.createDispatch({ target: "s:w", prompt: "a" });
    writePid(process.pid, pidPath);
    writeDaemonState(
      {
        pid: process.pid,
        startedAt: "2026-06-23T00:00:00.000Z",
        intervalMs: 1000,
        lastTickAt: new Date().toISOString(),
      },
      statePath,
    );
    const st = daemonStatus(store, pidPath, statePath);
    expect(st.running).toBe(true);
    expect(st.health).toBe("alive");
    expect(st.scheduled).toBe(1);
    expect(st.paused).toBe(1);
    expect(st.recentDispatches).toBe(1);
    expect(st.nextDue?.target).toBe("s:w");
    store.close();
  });
  test("reports stale health when heartbeat is old", () => {
    const store = new Store(":memory:");
    writePid(process.pid, pidPath);
    writeDaemonState(
      {
        pid: process.pid,
        startedAt: "2026-06-23T00:00:00.000Z",
        intervalMs: 1000,
        lastTickAt: "2026-06-23T00:00:00.000Z",
      },
      statePath,
    );
    const st = daemonStatus(store, pidPath, statePath, new Date("2026-06-23T00:02:00.000Z"));
    expect(st.health).toBe("stale");
    store.close();
  });
  test("uses the freshest tick marker while a tick is in progress", () => {
    const store = new Store(":memory:");
    writePid(process.pid, pidPath);
    writeDaemonState(
      {
        pid: process.pid,
        startedAt: "2026-06-23T00:00:00.000Z",
        intervalMs: 1000,
        lastTickAt: "2026-06-23T00:00:00.000Z",
        lastTickStartedAt: "2026-06-23T00:01:59.000Z",
      },
      statePath,
    );
    const st = daemonStatus(store, pidPath, statePath, new Date("2026-06-23T00:02:00.000Z"));
    expect(st.health).toBe("alive");
    expect(st.heartbeatAgeMs).toBe(1000);
    store.close();
  });
  test("ignores heartbeat state for a different live pid", () => {
    const store = new Store(":memory:");
    writePid(process.pid, pidPath);
    writeDaemonState(
      {
        pid: DEAD_PID,
        startedAt: "2026-06-23T00:00:00.000Z",
        intervalMs: 1000,
        lastTickAt: "2026-06-23T00:00:00.000Z",
      },
      statePath,
    );
    const st = daemonStatus(store, pidPath, statePath, new Date("2026-06-23T00:02:00.000Z"));
    expect(st.health).toBe("alive");
    expect(st.lastTickAt).toBeUndefined();
    store.close();
  });
  test("reports recent schedule failures without exposing prompt text", () => {
    const store = new Store(":memory:");
    const sched = store.createSchedule({ options: { target: "s:w", prompt: "secret prompt" }, nextRun: "2099-01-01T00:00:00Z" });
    store.updateSchedule(sched.id, {
      lastFailureAt: "2026-06-23T00:00:00.000Z",
      lastFailureReason: "target pane not found",
      failureCount: 1,
    });
    const st = daemonStatus(store, pidPath, statePath);
    expect(st.recentFailures).toHaveLength(1);
    expect(st.recentFailures[0]).toMatchObject({ id: sched.id, target: "s:w", lastFailureReason: "target pane not found" });
    expect(JSON.stringify(st.recentFailures)).not.toContain("secret prompt");
    store.close();
  });
});

describe("signalStop", () => {
  test("clears a stale pidfile and reports not stopped", () => {
    writePid(DEAD_PID, pidPath);
    const res = signalStop(pidPath);
    expect(res.stopped).toBe(false);
    expect(res.pid).toBe(DEAD_PID);
    expect(existsSync(pidPath)).toBe(false);
  });
  test("not running -> no-op", () => {
    expect(signalStop(pidPath)).toEqual({ stopped: false });
  });
});

describe("stopDaemon", () => {
  const noSleep = async () => {};
  test("not running -> wasRunning false", async () => {
    expect(await stopDaemon({ path: pidPath, sleep: noSleep })).toEqual({
      stopped: false,
      forced: false,
      wasRunning: false,
    });
  });
  test("stale pidfile -> cleared, wasRunning false", async () => {
    writePid(DEAD_PID, pidPath);
    const res = await stopDaemon({ path: pidPath, sleep: noSleep });
    expect(res.wasRunning).toBe(false);
    expect(res.pid).toBe(DEAD_PID);
    expect(existsSync(pidPath)).toBe(false);
  });
});
