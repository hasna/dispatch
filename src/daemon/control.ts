import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { daemonLogPath, pidFilePath } from "../lib/paths.js";
import { realSleep } from "../lib/submit.js";
import type { Store } from "../lib/store.js";

/** Read the daemon pid from its pidfile, if present and valid. */
export function readPid(path: string = pidFilePath()): number | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const pid = parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Write the current (or given) pid to the pidfile. */
export function writePid(pid: number = process.pid, path: string = pidFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid));
}

/** Remove the pidfile (best-effort). */
export function removePid(path: string = pidFilePath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/** Whether a process with the given pid is alive (signal 0 probe). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface DaemonRunning {
  running: boolean;
  pid?: number;
  /** A pidfile existed but the process is gone (stale). */
  stale: boolean;
}

/** Determine whether the daemon is running, detecting a stale pidfile. */
export function isDaemonRunning(path: string = pidFilePath()): DaemonRunning {
  const pid = readPid(path);
  if (pid === undefined) return { running: false, stale: false };
  if (isAlive(pid)) return { running: true, pid, stale: false };
  return { running: false, pid, stale: true };
}

export interface DaemonStatus extends DaemonRunning {
  scheduled: number;
  fired: number;
  cancelled: number;
  recentDispatches: number;
  logPath: string;
}

/** A human/JSON status snapshot combining process + store state. */
export function daemonStatus(store: Store, path: string = pidFilePath()): DaemonStatus {
  const run = isDaemonRunning(path);
  return {
    ...run,
    scheduled: store.listSchedules({ status: "scheduled" }).length,
    fired: store.listSchedules({ status: "fired" }).length,
    cancelled: store.listSchedules({ status: "cancelled" }).length,
    recentDispatches: store.listDispatches({ limit: 1000 }).length,
    logPath: daemonLogPath(),
  };
}

/** Send SIGTERM to the running daemon. Returns the pid signalled, if any. */
export function signalStop(path: string = pidFilePath()): { stopped: boolean; pid?: number } {
  const run = isDaemonRunning(path);
  if (run.stale) {
    removePid(path);
    return { stopped: false, pid: run.pid };
  }
  if (!run.running || run.pid === undefined) return { stopped: false };
  try {
    process.kill(run.pid, "SIGTERM");
    return { stopped: true, pid: run.pid };
  } catch {
    return { stopped: false, pid: run.pid };
  }
}

export interface StopDaemonResult {
  stopped: boolean;
  pid?: number;
  /** True if SIGKILL was needed after the graceful timeout. */
  forced: boolean;
  /** Whether a live daemon was present to stop. */
  wasRunning: boolean;
}

/**
 * Stop the daemon and wait for it to actually exit: SIGTERM, poll until the
 * process is gone (or `timeoutMs` elapses), then SIGKILL as a last resort.
 * Clears the pidfile. This makes `stop` synchronous from the caller's view.
 */
export async function stopDaemon(
  opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void>; path?: string } = {},
): Promise<StopDaemonResult> {
  const path = opts.path ?? pidFilePath();
  const sleep = opts.sleep ?? realSleep;
  const run = isDaemonRunning(path);
  if (run.stale) {
    removePid(path);
    return { stopped: false, pid: run.pid, forced: false, wasRunning: false };
  }
  if (!run.running || run.pid === undefined) {
    return { stopped: false, forced: false, wasRunning: false };
  }

  const pid = run.pid;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }

  const timeoutMs = opts.timeoutMs ?? 6000;
  const steps = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let i = 0; i < steps; i++) {
    await sleep(100);
    if (!isAlive(pid)) {
      removePid(path);
      return { stopped: true, pid, forced: false, wasRunning: true };
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
  await sleep(150);
  const dead = !isAlive(pid);
  removePid(path);
  return { stopped: dead, pid, forced: true, wasRunning: true };
}
