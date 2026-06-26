/**
 * @hasna/dispatch SDK — programmatic API.
 *
 *   import { DispatchClient } from "@hasna/dispatch/sdk";
 *   const client = new DispatchClient();
 *   const rec = await client.send({ target: "work:agent", prompt: "Refactor X" });
 *   console.log(rec.status, rec.confirm?.reason);
 */
import type {
  AgentRecoverOptions,
  AgentRecoverResult,
  AgentTriageOptions,
  AgentTriageResult,
  BulkDispatchOptions,
  BulkDispatchResult,
  CaptureOptions,
  CaptureResult,
  DispatchBackend,
  DispatchOptions,
  DispatchRecord,
  DispatchStatus,
  ExecOptions,
  KeyOptions,
  ScheduledDispatch,
  ScheduleKind,
  ScheduleStatus,
} from "../types.js";
import { Store } from "../lib/store.js";
import { Tmux } from "../lib/tmux.js";
import { createRunner } from "../lib/runner.js";
import { performDispatch } from "../lib/engine.js";
import { performExec } from "../lib/exec.js";
import { performKeyDispatch } from "../lib/key.js";
import { performCapture } from "../lib/capture.js";
import { performAgentRecovery, performAgentTriage } from "../lib/agent-recovery.js";
import { computeNextRun, parseDurationMs } from "../lib/schedule.js";
import { performBulkDispatch } from "../lib/bulk.js";
import { resolveSessionsTargets } from "../lib/sessions-source.js";
import { normalizeBackend } from "../lib/backend.js";
import { Mosaic, performMosaicCapture, performMosaicDispatch } from "../lib/mosaic.js";

export interface DispatchClientOptions {
  /** Use an explicit store; otherwise the default sqlite store is opened. */
  store?: Store;
  /** Override the sqlite path (e.g. ":memory:"). Ignored when `store` is given. */
  dbPath?: string;
  /** Persist dispatches. Default true. */
  persist?: boolean;
  /** Default backend. Defaults to DISPATCH_BACKEND or tmux. */
  backend?: DispatchBackend;
}

/** High-level programmatic client for dispatching prompts to tmux agents. */
export class DispatchClient {
  private readonly store?: Store;
  private readonly ownsStore: boolean;
  private readonly defaultBackend?: DispatchBackend;

  constructor(opts: DispatchClientOptions = {}) {
    this.defaultBackend = opts.backend;
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

  private backend(input?: DispatchBackend): DispatchBackend {
    return normalizeBackend(input ?? this.defaultBackend);
  }

  /** Dispatch a prompt to a tmux target (local or, via `machine`, remote). */
  async send(options: DispatchOptions): Promise<DispatchRecord> {
    const runner = await createRunner(options.machine);
    if (this.backend(options.backend) === "mosaic") {
      return performMosaicDispatch(options, { mosaic: new Mosaic(runner), store: this.store });
    }
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
    if (this.backend(options.backend) === "mosaic") {
      return performMosaicCapture(options, { mosaic: new Mosaic(runner) });
    }
    const tmux = new Tmux(runner);
    return performCapture(options, { tmux });
  }

  /** Classify a target agent state and return bounded recovery context. */
  async triage(options: AgentTriageOptions): Promise<AgentTriageResult> {
    const runner = await createRunner(options.machine);
    const tmux = new Tmux(runner);
    return performAgentTriage(options, { tmux });
  }

  /** Plan or apply a guarded recovery prompt. Defaults to dry-run planning. */
  async recover(options: AgentRecoverOptions): Promise<AgentRecoverResult> {
    const runner = await createRunner(options.machine);
    const tmux = new Tmux(runner);
    return performAgentRecovery(options, { tmux, store: this.store });
  }

  /** Dispatch one prompt to multiple targets with idle guards/concurrency controls. */
  async bulkSend(options: BulkDispatchOptions): Promise<BulkDispatchResult> {
    if (this.backend(options.backend) === "mosaic") {
      throw new Error("bulk Mosaic dispatch is not supported in this backend slice; send one Mosaic target at a time");
    }
    let targets = options.targets ?? [];
    if (options.source === "sessions-query") {
      const runner = await createRunner(options.machine);
      targets = await resolveSessionsTargets({ runner, machine: options.machine, query: options.sessionsQuery });
    }
    return performBulkDispatch(
      { ...options, targets },
      {
        store: this.store,
        makeTmux: async (machine?: string) => new Tmux(await createRunner(machine)),
      },
    );
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
  schedule(input: {
    options: DispatchOptions;
    at?: string;
    in?: string;
    cron?: string;
    every?: string;
    intervalMs?: number;
    name?: string;
    from?: Date;
  }): ScheduledDispatch {
    if (!this.store) throw new Error("scheduling requires a persistent store");
    const intervalMs = input.intervalMs ?? (input.every ? parseDurationMs(input.every) : undefined);
    const nextRun = computeNextRun(
      { at: input.at, in: input.in, cron: input.cron, every: input.every, intervalMs },
      input.from ?? new Date(),
    );
    const at = input.at ?? (input.in ? nextRun : undefined);
    const kind = intervalMs ? "loop" : "schedule";
    return this.store.createSchedule({
      options: input.options,
      kind,
      name: input.name,
      at,
      cron: input.cron,
      every: input.every,
      intervalMs,
      nextRun,
    });
  }

  /** Create a recurring interval loop. */
  loop(input: { options: DispatchOptions; every: string; name?: string; from?: Date }): ScheduledDispatch {
    return this.schedule(input);
  }

  /** Look up a scheduled dispatch or loop by id. */
  scheduleStatus(id: string): ScheduledDispatch | undefined {
    return this.store?.getSchedule(id);
  }

  /** List scheduled dispatches. */
  listSchedules(opts: { status?: ScheduleStatus; kind?: ScheduleKind; limit?: number } = {}): ScheduledDispatch[] {
    return this.store?.listSchedules(opts) ?? [];
  }

  /** List recurring interval loops. */
  listLoops(opts: { status?: ScheduleStatus; limit?: number } = {}): ScheduledDispatch[] {
    return this.listSchedules({ ...opts, kind: "loop" });
  }

  /** Cancel a scheduled dispatch. */
  cancelSchedule(id: string): boolean {
    if (!this.store) return false;
    const sched = this.store.getSchedule(id);
    if (!sched || !["scheduled", "paused"].includes(sched.status)) return false;
    this.store.updateSchedule(id, { status: "cancelled" });
    return true;
  }

  /** Pause a scheduled dispatch or loop so it will not fire until resumed. */
  pauseSchedule(id: string): boolean {
    if (!this.store) return false;
    const sched = this.store.getSchedule(id);
    if (!sched || sched.status !== "scheduled") return false;
    this.store.updateSchedule(id, { status: "paused" });
    return true;
  }

  /** Resume a paused scheduled dispatch or loop. */
  resumeSchedule(id: string, from: Date = new Date()): boolean {
    if (!this.store) return false;
    const sched = this.store.getSchedule(id);
    if (!sched || sched.status !== "paused") return false;
    let nextRun = sched.nextRun;
    if (sched.intervalMs) {
      nextRun = computeNextRun({ intervalMs: sched.intervalMs }, from);
    } else if (sched.cron) {
      nextRun = computeNextRun({ cron: sched.cron }, from);
    } else if (new Date(nextRun).getTime() <= from.getTime()) {
      nextRun = from.toISOString();
    }
    this.store.updateSchedule(id, { status: "scheduled", nextRun });
    return true;
  }

  /** Delete a scheduled dispatch or loop from the store. */
  clearSchedule(id: string): boolean {
    return this.store?.deleteSchedule(id) ?? false;
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

/** One-shot convenience: triage an agent target without managing a client. */
export async function dispatchTriage(options: AgentTriageOptions): Promise<AgentTriageResult> {
  const client = new DispatchClient({ persist: false });
  try {
    return await client.triage(options);
  } finally {
    client.close();
  }
}

/** One-shot convenience: plan/apply guarded recovery without managing a client. */
export async function dispatchRecover(options: AgentRecoverOptions): Promise<AgentRecoverResult> {
  const client = new DispatchClient({ persist: false });
  try {
    return await client.recover(options);
  } finally {
    client.close();
  }
}

/** One-shot convenience: bulk dispatch without managing a client. */
export async function dispatchBulk(options: BulkDispatchOptions): Promise<BulkDispatchResult> {
  const client = new DispatchClient({ persist: false });
  try {
    return await client.bulkSend(options);
  } finally {
    client.close();
  }
}

export * from "../types.js";
