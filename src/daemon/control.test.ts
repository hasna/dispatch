import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  daemonStatus,
  isAlive,
  isDaemonRunning,
  readPid,
  removePid,
  signalStop,
  stopDaemon,
  writePid,
} from "./control.js";
import { Store } from "../lib/store.js";

const pidPath = join(tmpdir(), `dispatch_test_pid_${process.pid}_${Math.floor(Math.random() * 1e6)}.pid`);
const DEAD_PID = 2147480000; // almost certainly not a live process

afterEach(() => {
  rmSync(pidPath, { force: true });
});

describe("pidfile", () => {
  test("write/read/remove round-trips", () => {
    writePid(4242, pidPath);
    expect(readPid(pidPath)).toBe(4242);
    removePid(pidPath);
    expect(readPid(pidPath)).toBeUndefined();
    expect(existsSync(pidPath)).toBe(false);
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
});

describe("daemonStatus", () => {
  test("combines process + store counts", () => {
    const store = new Store(":memory:");
    store.createSchedule({ options: { target: "s:w", prompt: "x" }, nextRun: "2099-01-01T00:00:00Z" });
    store.createDispatch({ target: "s:w", prompt: "a" });
    writePid(process.pid, pidPath);
    const st = daemonStatus(store, pidPath);
    expect(st.running).toBe(true);
    expect(st.scheduled).toBe(1);
    expect(st.recentDispatches).toBe(1);
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
