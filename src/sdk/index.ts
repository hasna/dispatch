/**
 * @hasna/dispatch SDK — programmatic API.
 *
 *   import { DispatchClient } from "@hasna/dispatch/sdk";
 *   const client = new DispatchClient();
 *   const rec = await client.send({ target: "work:agent", prompt: "Refactor X" });
 *   console.log(rec.status, rec.confirm?.reason);
 */
import type {
  CaptureOptions,
  CaptureResult,
  DispatchOptions,
  DispatchRecord,
  DispatchStatus,
  ExecOptions,
  KeyOptions,
  ScheduledDispatch,
} from "../types.js";
import { Store } from "../lib/store.js";
import { Tmux } from "../lib/tmux.js";
import { createRunner } from "../lib/runner.js";
import { performDispatch } from "../lib/engine.js";
import { performExec } from "../lib/exec.js";
import { performKeyDispatch } from "../lib/key.js";
import { performCapture } from "../lib/capture.js";
import { computeNextRun } from "../lib/schedule.js";

export interface DispatchClientOptions {
  /** Use an explicit store; otherwise the default sqlite store is opened. */
  store?: Store;
  /** Override the sqlite path (e.g. ":memory:"). Ignored when `store` is given. */
  dbPath?: string;
  /** Persist dispatches. Default true. */
  persist?: boolean;
}

/** High-level programmatic client for dispatching prompts to tmux agents. */
export class DispatchClient {
  private readonly store?: Store;
  private readonly ownsStore: boolean;

  constructor(opts: DispatchClientOptions = {}) {
    if (opts.persist === false) {
      this.store = undefined;
      this.ownsStore = false;
    } else if (opts.store) {
      this.store = opts.store;
      this.ownsStore = false;
    } else {
      this.store = new Store(opts.dbPath);
      this.ownsStore = true;
    }
  }

  /** Dispatch a prompt to a tmux target (local or, via `machine`, remote). */
  async send(options: DispatchOptions): Promise<DispatchRecord> {
    const runner = await createRunner(options.machine);
    const tmux = new Tmux(runner);
    return performDispatch(options, { tmux, store: this.store });
  }

  /** Dispatch a shell command to a detected shell tmux target after policy filtering. */
  async exec(options: ExecOptions): Promise<DispatchRecord> {
    const runner = await createRunner(options.machine);
    const tmux = new Tmux(runner);
    return performExec(options, { tmux, store: this.store });
  }

  /** Dispatch a safe allowlisted special key to a tmux agent composer. */
  async key(options: KeyOptions): Promise<DispatchRecord> {
    const runner = await createRunner(options.machine);
    const tmux = new Tmux(runner);
    return performKeyDispatch(options, { tmux, store: this.store });
  }

  /** Capture a bounded, redacted pane transcript, optionally with an AI transform. */
  async capture(options: CaptureOptions): Promise<CaptureResult> {
    const runner = await createRunner(options.machine);
    const tmux = new Tmux(runner);
    return performCapture(options, { tmux });
  }

  /** Look up a previously-recorded dispatch by id. */
  status(id: string): DispatchRecord | undefined {
    return this.store?.getDispatch(id);
  }

  /** List recorded dispatches, newest first. */
  list(opts: { status?: DispatchStatus; limit?: number } = {}): DispatchRecord[] {
    return this.store?.listDispatches(opts) ?? [];
  }

  /** Queue a dispatch to fire later (one-shot `at` or recurring `cron`). */
  schedule(input: { options: DispatchOptions; at?: string; cron?: string; from?: Date }): ScheduledDispatch {
    if (!this.store) throw new Error("scheduling requires a persistent store");
    if (!input.at && !input.cron) throw new Error("schedule requires `at` or `cron`");
    const nextRun = computeNextRun({ at: input.at, cron: input.cron }, input.from ?? new Date());
    return this.store.createSchedule({ options: input.options, at: input.at, cron: input.cron, nextRun });
  }

  /** List scheduled dispatches. */
  listSchedules(opts: { status?: ScheduledDispatch["status"]; limit?: number } = {}): ScheduledDispatch[] {
    return this.store?.listSchedules(opts) ?? [];
  }

  /** Cancel a scheduled dispatch. */
  cancelSchedule(id: string): boolean {
    if (!this.store) return false;
    const sched = this.store.getSchedule(id);
    if (!sched || sched.status !== "scheduled") return false;
    this.store.updateSchedule(id, { status: "cancelled" });
    return true;
  }

  close(): void {
    if (this.ownsStore) this.store?.close();
  }
}

/** One-shot convenience: dispatch without managing a client. */
export async function dispatch(options: DispatchOptions): Promise<DispatchRecord> {
  const client = new DispatchClient({ persist: false });
  try {
    return await client.send(options);
  } finally {
    client.close();
  }
}

/** One-shot convenience: exec without managing a client. */
export async function dispatchExec(options: ExecOptions): Promise<DispatchRecord> {
  const client = new DispatchClient({ persist: false });
  try {
    return await client.exec(options);
  } finally {
    client.close();
  }
}

/** One-shot convenience: key dispatch without managing a client. */
export async function dispatchKey(options: KeyOptions): Promise<DispatchRecord> {
  const client = new DispatchClient({ persist: false });
  try {
    return await client.key(options);
  } finally {
    client.close();
  }
}

/** One-shot convenience: capture without managing a client. */
export async function dispatchCapture(options: CaptureOptions): Promise<CaptureResult> {
  const client = new DispatchClient({ persist: false });
  try {
    return await client.capture(options);
  } finally {
    client.close();
  }
}

export * from "../types.js";
