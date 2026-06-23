import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { daemonLogPath, daemonPidLockPath, daemonStatePath, pidFilePath } from "../lib/paths.js";
import { realSleep } from "../lib/submit.js";
import type { Store } from "../lib/store.js";
import type { ScheduledDispatch } from "../types.js";

const PIDFILE_OWNER = "@hasna/dispatch-daemon";
const DEFAULT_HEARTBEAT_STALE_MS = 30_000;
const PID_LOCK_WAIT_MS = 2_000;
const PID_LOCK_RETRY_MS = 25;
const PID_LOCK_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

interface PidFileData {
  pid: number;
  owner?: string;
  startedAt?: string;
}

export interface DaemonStateFile {
  pid: number;
  startedAt: string;
  intervalMs: number;
  lastTickStartedAt?: string;
  lastTickFinishedAt?: string;
  lastTickAt?: string;
  lastTickError?: string;
  stoppedAt?: string;
}

function readPidFile(path: string = pidFilePath()): PidFileData | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return undefined;
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as Partial<PidFileData>;
      const pid = Number(parsed.pid);
      return Number.isInteger(pid) && pid > 0 ? { pid, owner: parsed.owner, startedAt: parsed.startedAt } : undefined;
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

function sleepSync(ms: number): void {
  Atomics.wait(PID_LOCK_RETRY_BUFFER, 0, 0, ms);
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const raw = readFileSync(join(lockPath, "pid"), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function acquirePidLock(lockPath: string = daemonPidLockPath()): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + PID_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "pid"), String(process.pid));
      return () => {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readLockPid(lockPath);
      if (owner !== undefined && !isAlive(owner)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      sleepSync(PID_LOCK_RETRY_MS);
    }
  }
  throw new Error(`could not acquire daemon pidfile lock: ${lockPath}`);
}

/** Atomically claim the daemon pidfile; used by the daemon single-instance guard. */
export function claimPid(
  pid: number = process.pid,
  path: string = pidFilePath(),
  lockPath: string = daemonPidLockPath(),
): { claimed: boolean; pid?: number; stale?: boolean } {
  mkdirSync(dirname(path), { recursive: true });
  const release = acquirePidLock(lockPath);
  try {
    const running = isDaemonRunning(path);
    if (running.running) return { claimed: false, pid: running.pid, stale: false };
    if (running.stale || existsSync(path)) removePid(path);
    try {
      writeFileSync(path, JSON.stringify({ pid, owner: PIDFILE_OWNER, startedAt: new Date().toISOString() }), {
        flag: "wx",
      });
      return { claimed: true, pid };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const after = isDaemonRunning(path);
      return { claimed: false, pid: after.pid, stale: after.stale };
    }
  } finally {
    release();
  }
}

/** Remove the pidfile (best-effort). */
export function removePid(path: string = pidFilePath()): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/** Persist daemon heartbeat/health state. */
export function writeDaemonState(state: DaemonStateFile, path: string = daemonStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Read daemon heartbeat/health state, if present and valid. */
export function readDaemonState(path: string = daemonStatePath()): DaemonStateFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DaemonStateFile>;
    if (!Number.isInteger(parsed.pid) || !parsed.startedAt || !Number.isFinite(parsed.intervalMs)) return undefined;
    const pid = parsed.pid as number;
    const intervalMs = parsed.intervalMs as number;
    return {
      pid,
      startedAt: parsed.startedAt,
      intervalMs,
      lastTickStartedAt: parsed.lastTickStartedAt,
      lastTickFinishedAt: parsed.lastTickFinishedAt,
      lastTickAt: parsed.lastTickAt,
      lastTickError: parsed.lastTickError,
      stoppedAt: parsed.stoppedAt,
    };
  } catch {
    return undefined;
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
  health: "alive" | "stale" | "dead";
  scheduled: number;
  paused: number;
  fired: number;
  cancelled: number;
  failed: number;
  recentDispatches: number;
  startedAt?: string;
  lastTickAt?: string;
  lastTickStartedAt?: string;
  lastTickFinishedAt?: string;
  lastTickError?: string;
  stoppedAt?: string;
  heartbeatAgeMs?: number;
  heartbeatStaleMs: number;
  nextDue?: DaemonQueueItem;
  recentFailures: DaemonQueueItem[];
  logPath: string;
  pidPath: string;
  statePath: string;
}

export interface DaemonQueueItem {
  id: string;
  kind?: string;
  name?: string;
  status: string;
  target: string;
  machine?: string;
  nextRun: string;
  lastDispatchId?: string;
  lastFiredAt?: string;
  lastFailureAt?: string;
  lastFailureReason?: string;
  failureCount?: number;
}

function queueItem(s: ScheduledDispatch): DaemonQueueItem {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    status: s.status,
    target: s.options.target,
    machine: s.options.machine,
    nextRun: s.nextRun,
    lastDispatchId: s.lastDispatchId,
    lastFiredAt: s.lastFiredAt,
    lastFailureAt: s.lastFailureAt,
    lastFailureReason: s.lastFailureReason,
    failureCount: s.failureCount,
  };
}

function heartbeatAgeMs(state: DaemonStateFile | undefined, nowMs: number): number | undefined {
  const markers = [
    state?.startedAt,
    state?.lastTickStartedAt,
    state?.lastTickFinishedAt,
    state?.lastTickAt,
  ]
    .map((marker) => (marker ? Date.parse(marker) : NaN))
    .filter((timestamp) => Number.isFinite(timestamp));
  if (markers.length === 0) return undefined;
  return Math.max(0, nowMs - Math.max(...markers));
}

/** A human/JSON status snapshot combining process + store state. */
export function daemonStatus(
  store: Store,
  path: string = pidFilePath(),
  statePath: string = daemonStatePath(),
  now: Date = new Date(),
): DaemonStatus {
  const run = isDaemonRunning(path);
  const rawState = readDaemonState(statePath);
  const state = rawState && (run.pid === undefined || rawState.pid === run.pid) ? rawState : undefined;
  const staleMs = Math.max(DEFAULT_HEARTBEAT_STALE_MS, (state?.intervalMs ?? 1000) * 5);
  const age = heartbeatAgeMs(state, now.getTime());
  const heartbeatStale = run.running && age !== undefined && age > staleMs;
  const health = run.running ? (heartbeatStale ? "stale" : "alive") : run.stale ? "stale" : "dead";
  const nextDue = store.nextScheduled();
  return {
    ...run,
    health,
    scheduled: store.countSchedules({ status: "scheduled" }),
    paused: store.countSchedules({ status: "paused" }),
    fired: store.countSchedules({ status: "fired" }),
    cancelled: store.countSchedules({ status: "cancelled" }),
    failed: store.countSchedules({ status: "failed" }),
    recentDispatches: store.listDispatches({ limit: 1000 }).length,
    startedAt: state?.startedAt,
    lastTickAt: state?.lastTickAt,
    lastTickStartedAt: state?.lastTickStartedAt,
    lastTickFinishedAt: state?.lastTickFinishedAt,
    lastTickError: state?.lastTickError,
    stoppedAt: state?.stoppedAt,
    heartbeatAgeMs: age,
    heartbeatStaleMs: staleMs,
    nextDue: nextDue ? queueItem(nextDue) : undefined,
    recentFailures: store.recentScheduleFailures(5).map(queueItem),
    logPath: daemonLogPath(),
    pidPath: path,
    statePath,
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
