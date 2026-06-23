import type { BulkDispatchOptions, BulkDispatchResult, DispatchRecord, DispatchTargetRef } from "../types.js";
import type { Store } from "./store.js";
import { applyGoalPrefix, performDispatch } from "./engine.js";
import { genId, nowIso } from "./ids.js";
import { Tmux } from "./tmux.js";

export interface BulkDispatchDeps {
  makeTmux: (machine?: string) => Promise<Tmux>;
  store?: Store;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function normalizePositive(value: number | undefined, fallback: number, max = 100): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value as number)));
}

function normalizeNonNegative(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value as number));
}

function emptyResult(options: BulkDispatchOptions, detail: string): BulkDispatchResult {
  return {
    status: "failed",
    source: options.source ?? "explicit",
    requested: 0,
    planned: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    dryRun: options.dryRun === true,
    maxConcurrency: normalizePositive(options.maxConcurrency, 1),
    jitterMs: normalizeNonNegative(options.jitterMs),
    perMachineLimit: normalizePositive(options.perMachineLimit, normalizePositive(options.maxConcurrency, 1)),
    records: [],
    detail,
  };
}

function summarize(options: BulkDispatchOptions, records: DispatchRecord[], requested: number): BulkDispatchResult {
  const delivered = records.filter((r) => r.status === "delivered").length;
  const skipped = records.filter((r) => r.status === "skipped").length;
  const failed = records.filter((r) => r.status === "failed").length;
  const skippedIsFailure = options.dryRun !== true && skipped > 0;
  return {
    status: failed > 0 || skippedIsFailure ? "failed" : "completed",
    source: options.source ?? "explicit",
    requested,
    planned: records.length,
    delivered,
    skipped,
    failed,
    dryRun: options.dryRun === true,
    maxConcurrency: normalizePositive(options.maxConcurrency, 1),
    jitterMs: normalizeNonNegative(options.jitterMs),
    perMachineLimit: normalizePositive(options.perMachineLimit, normalizePositive(options.maxConcurrency, 1)),
    records,
    detail: skippedIsFailure ? "one or more targets were skipped; pass queue or forceActive only when intentional" : undefined,
  };
}

export async function performBulkDispatch(
  options: BulkDispatchOptions & { targets: DispatchTargetRef[] },
  deps: BulkDispatchDeps,
): Promise<BulkDispatchResult> {
  const requested = options.targets.length;
  if (requested === 0) return emptyResult(options, "no targets resolved");

  const maxConcurrency = normalizePositive(options.maxConcurrency, 1);
  const perMachineLimit = normalizePositive(options.perMachineLimit, maxConcurrency);
  const jitterMs = normalizeNonNegative(options.jitterMs);
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const records: DispatchRecord[] = [];
  const tmuxByMachine = new Map<string, Promise<Tmux>>();
  const activeByMachine = new Map<string, number>();
  const pending = [...options.targets];
  const defaultIfIdle = options.queue === true || options.forceActive === true ? false : true;

  const tmuxFor = (machine?: string): Promise<Tmux> => {
    const key = machine ?? "local";
    let existing = tmuxByMachine.get(key);
    if (!existing) {
      existing = deps.makeTmux(machine);
      tmuxByMachine.set(key, existing);
    }
    return existing;
  };

  async function worker(): Promise<void> {
    while (true) {
      let ref: DispatchTargetRef | undefined;
      for (let i = 0; i < pending.length; i += 1) {
        const machine = pending[i]!.machine ?? options.machine ?? "local";
        if ((activeByMachine.get(machine) ?? 0) < perMachineLimit) {
          ref = pending.splice(i, 1)[0]!;
          activeByMachine.set(machine, (activeByMachine.get(machine) ?? 0) + 1);
          break;
        }
      }
      if (!ref) {
        if (pending.length === 0) return;
        await sleep(5);
        continue;
      }

      const machine = ref.machine ?? options.machine;
      try {
        if (jitterMs > 0) await sleep(Math.floor(random() * jitterMs));
        const tmux = await tmuxFor(machine);
        const record = await performDispatch(
          {
            target: ref.target,
            prompt: options.prompt,
            goal: options.goal,
            machine,
            submitDelayMs: options.submitDelayMs,
            submit: options.submit,
            confirm: options.confirm,
            maxSubmitRetries: options.maxSubmitRetries,
            mode: options.mode,
            ifIdle: options.ifIdle ?? defaultIfIdle,
            queue: options.queue,
            forceActive: options.forceActive,
            dryRun: options.dryRun,
            captureBeforeLines: options.captureBeforeLines,
          },
          { tmux, store: deps.store, sleep },
        );
        records.push(record);
      } catch (err) {
        const now = nowIso();
        records.push({
          id: genId(),
          kind: "prompt",
          target: ref.target,
          machine: machine ?? "local",
          prompt: applyGoalPrefix(options.prompt, options.goal === true),
          status: "failed",
          detail: `bulk dispatch failed before delivery: ${(err as Error).message}`,
          dryRun: options.dryRun === true,
          createdAt: now,
          updatedAt: now,
        });
      } finally {
        const key = machine ?? "local";
        activeByMachine.set(key, Math.max(0, (activeByMachine.get(key) ?? 1) - 1));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, requested) }, () => worker()));
  return summarize(options, records, requested);
}
