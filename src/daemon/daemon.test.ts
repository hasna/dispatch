import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDaemon, startDaemon } from "./daemon.js";
import { writePid } from "./control.js";
import { Store } from "../lib/store.js";
import { DispatchClient } from "../sdk/index.js";

const pidPath = join(tmpdir(), `dispatch_daemon_pid_${process.pid}_${Math.floor(Math.random() * 1e6)}.pid`);
const noSleep = async () => {};

afterEach(() => {
  rmSync(pidPath, { force: true });
});

describe("runDaemon", () => {
  test("fires a due schedule then exits, leaving no pidfile", async () => {
    const store = new Store(":memory:");
    // A client whose send is stubbed (no real tmux) but still records.
    const client = new DispatchClient({ store });
    let sends = 0;
    (client as unknown as { send: (o: unknown) => Promise<unknown> }).send = async () => {
      sends++;
      return store.createDispatch({ target: "s:w", prompt: "fired", status: "delivered" });
    };
    store.createSchedule({
      options: { target: "s:w", prompt: "go" },
      at: "2000-01-01T00:00:00Z",
      nextRun: "2000-01-01T00:00:00Z",
    });

    let ticks = 0;
    await runDaemon({
      store,
      client,
      pidPath,
      sleep: noSleep,
      shouldStop: () => ticks++ >= 1,
      log: () => {},
    });

    expect(sends).toBe(1);
    expect(store.listSchedules({ status: "fired" })).toHaveLength(1);
    expect(existsSync(pidPath)).toBe(false); // cleaned up on exit
    store.close();
  });

  test("refuses to start when another daemon is already running", async () => {
    writePid(process.pid, pidPath); // a live pid
    const store = new Store(":memory:");
    await expect(
      runDaemon({ store, pidPath, shouldStop: () => true, sleep: noSleep, log: () => {} }),
    ).rejects.toThrow(/already running/);
    store.close();
  });

  test("startDaemon creates a missing log directory before spawning", async () => {
    const root = mkdtempSync(join(tmpdir(), "dispatch_daemon_start_"));
    const script = join(root, "exit.js");
    const logPath = join(root, "missing", "daemon.log");
    const childPidPath = join(root, "daemon.pid");
    writeFileSync(script, "process.exit(0);\n");
    try {
      const res = await startDaemon({
        execPath: process.execPath,
        cliEntry: script,
        args: [],
        pidPath: childPidPath,
        logPath,
        waitMs: 10,
        sleep: async () => {},
      });
      expect(res.started).toBe(false);
      expect(existsSync(logPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
