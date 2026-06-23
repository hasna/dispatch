import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { daemonLogPath, pidFilePath } from "../lib/paths.js";
import { realSleep } from "../lib/submit.js";
import type { Store } from "../lib/store.js";

const PIDFILE_OWNER = "@hasna/dispatch-daemon";

interface PidFileData {
  pid: number;
  owner?: string;
}

function readPidFile(path: string = pidFilePath()): PidFileData | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return undefined;
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as Partial<PidFileData>;
      const pid = Number(parsed.pid);
      return Number.isInteger(pid) && pid > 0 ? { pid, owner: parsed.owner } : undefined;
    }
    const pid = parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid } : undefined;
  } catch {
    return undefined;
  }
}

/** Read the daemon pid from its pidfile, if present and valid. */
export function readPid(path: string = pidFilePath()): number | undefined {
  return readPidFile(path)?.pid;
}

/** Write the current (or given) pid to the pidfile. */
export function writePid(pid: number = process.pid, path: string = pidFilePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, owner: PIDFILE_OWNER, startedAt: new Date().toISOString() }));
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

function processCommand(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return result.status === 0 ? result.stdout.trim() : undefined;
  }
}

function isDispatchDaemonProcess(pid: number, owner?: string): boolean {
  if (pid === process.pid && owner === PIDFILE_OWNER) return true;
  const command = processCommand(pid);
  if (!command) return false;
  const hasOwner = owner === PIDFILE_OWNER;
  const looksLikeDispatch =
    hasOwner ||
    /\bdispatch-daemon\b/.test(command) ||
    /@hasna\/dispatch/.test(command) ||
    /open-dispatch/.test(command) ||
    /\/dispatch(\s|$)/.test(command);
  const looksLikeDaemonRun =
    /\bdaemon\s+run\b/.test(command) ||
    /\/daemon\/index\.(js|ts)(\s|$)/.test(command) ||
    /\bdispatch-daemon\b/.test(command);
  return looksLikeDispatch && looksLikeDaemonRun;
}

export interface DaemonRunning {
  running: boolean;
  pid?: number;
  /** A pidfile existed but the process is gone (stale). */
  stale: boolean;
}

/** Determine whether the daemon is running, detecting a stale pidfile. */
export function isDaemonRunning(path: string = pidFilePath()): DaemonRunning {
  const data = readPidFile(path);
  if (!data) return { running: false, stale: false };
  const pid = data.pid;
  if (isAlive(pid) && isDispatchDaemonProcess(pid, data.owner)) return { running: true, pid, stale: false };
  return { running: false, pid, stale: true };
}

export interface DaemonStatus extends DaemonRunning {
  scheduled: number;
  paused: number;
  fired: number;
  cancelled: number;
  failed: number;
  recentDispatches: number;
  logPath: string;
}

/** A human/JSON status snapshot combining process + store state. */
export function daemonStatus(store: Store, path: string = pidFilePath()): DaemonStatus {
  const run = isDaemonRunning(path);
  return {
    ...run,
    scheduled: store.countSchedules({ status: "scheduled" }),
    paused: store.countSchedules({ status: "paused" }),
    fired: store.countSchedules({ status: "fired" }),
    cancelled: store.countSchedules({ status: "cancelled" }),
    failed: store.countSchedules({ status: "failed" }),
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
