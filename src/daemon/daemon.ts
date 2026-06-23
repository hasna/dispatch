import { mkdirSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { Store } from "../lib/store.js";
import { DispatchClient } from "../sdk/index.js";
import { tick } from "../lib/scheduler.js";
import { realSleep } from "../lib/submit.js";
import { daemonLogPath, pidFilePath } from "../lib/paths.js";
import { runLoop } from "./loop.js";
import { claimPid, isDaemonRunning, removePid, writeDaemonState, type DaemonStateFile } from "./control.js";

export interface RunDaemonOptions {
  intervalMs?: number;
  pidPath?: string;
  /** Inject a store (tests). When given, it is NOT closed by the daemon. */
  store?: Store;
  /** Inject a client (tests). When given, it is NOT closed by the daemon. */
  client?: DispatchClient;
  /** Stop predicate (tests). Defaults to a SIGTERM/SIGINT flag. */
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  statePath?: string;
}

function intervalFromEnv(): number | undefined {
  const raw = process.env.DISPATCH_DAEMON_INTERVAL_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The long-running daemon body: owns the scheduled-dispatch queue and fires due
 * dispatches on an interval, persisting all state. Writes a pidfile while alive
 * and removes it on exit; refuses to start if another daemon is already running.
 * Because schedules live in sqlite, a restart resumes the queue unchanged.
 */
export async function runDaemon(opts: RunDaemonOptions = {}): Promise<void> {
  const pidPath = opts.pidPath ?? pidFilePath();
  const statePath = opts.statePath;
  const intervalMs = opts.intervalMs ?? intervalFromEnv() ?? 1000;
  const log = opts.log ?? ((m: string) => console.error(`[dispatch-daemon] ${m}`));

  const claimed = claimPid(process.pid, pidPath);
  if (!claimed.claimed) {
    throw new Error(`daemon already running (pid ${claimed.pid ?? "unknown"})`);
  }

  const ownStore = !opts.store;
  const store = opts.store ?? new Store();
  const ownClient = !opts.client;
  const client = opts.client ?? new DispatchClient({ store });

  let state: DaemonStateFile = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    intervalMs,
  };
  const persistState = (): void => writeDaemonState(state, statePath);
  persistState();
  log(`started (pid ${process.pid}), interval ${intervalMs}ms`);

  let stopFlag = false;
  const onSignal = (): void => {
    stopFlag = true;
    log("stop signal received");
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    await runLoop({
      intervalMs,
      sleep: opts.sleep ?? realSleep,
      shouldStop: opts.shouldStop ?? (() => stopFlag),
      onTickError: (err) => log(`tick error: ${err instanceof Error ? err.message : String(err)}`),
      tickFn: async () => {
        state = { ...state, lastTickStartedAt: new Date().toISOString(), lastTickError: undefined };
        persistState();
        try {
          const res = await tick({
            store,
            dispatch: (options) => client.send(options),
            onError: (sched, err) =>
              log(`dispatch failed for schedule ${sched.id}: ${err instanceof Error ? err.message : String(err)}`),
          });
          state = {
            ...state,
            lastTickAt: new Date().toISOString(),
            lastTickFinishedAt: new Date().toISOString(),
            lastTickError: undefined,
          };
          persistState();
          if (res.fired.length > 0) log(`fired ${res.fired.length} schedule(s)`);
          if (res.failed.length > 0) log(`deferred ${res.failed.length} failed schedule(s) for retry`);
        } catch (err) {
          state = {
            ...state,
            lastTickAt: new Date().toISOString(),
            lastTickFinishedAt: new Date().toISOString(),
            lastTickError: err instanceof Error ? err.message : String(err),
          };
          persistState();
          throw err;
        }
      },
    });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    removePid(pidPath);
    state = { ...state, stoppedAt: new Date().toISOString() };
    persistState();
    if (ownClient) client.close();
    else if (ownStore) store.close();
    log("stopped");
  }
}

export interface StartDaemonResult {
  started: boolean;
  alreadyRunning: boolean;
  pid?: number;
}

/**
 * Launch the daemon as a detached background process by re-invoking this CLI's
 * `daemon run`. Idempotent: returns `alreadyRunning` if one is up.
 */
export async function startDaemon(opts: {
  /** Path to the entry to launch (usually process.argv[1] for the CLI). */
  cliEntry: string;
  /** Args after the entry. Default ["daemon", "run"] (the CLI path). */
  args?: string[];
  execPath?: string;
  pidPath?: string;
  logPath?: string;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<StartDaemonResult> {
  const pidPath = opts.pidPath ?? pidFilePath();
  const running = isDaemonRunning(pidPath);
  if (running.running) return { started: false, alreadyRunning: true, pid: running.pid };

  const logPath = opts.logPath ?? daemonLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  const sleep = opts.sleep ?? realSleep;
  const out = openSync(logPath, "a");
  const child = spawn(opts.execPath ?? process.execPath, [opts.cliEntry, ...(opts.args ?? ["daemon", "run"])], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  // Wait for the child to claim the pidfile.
  const deadline = (opts.waitMs ?? 4000) / 100;
  for (let i = 0; i < deadline; i++) {
    await sleep(100);
    const r = isDaemonRunning(pidPath);
    if (r.running) return { started: true, alreadyRunning: false, pid: r.pid };
  }
  return { started: false, alreadyRunning: false };
}
