import type { DispatchRecord, ExecDeliveryPlan, ExecOptions } from "../types.js";
import type { Store } from "./store.js";
import { Tmux } from "./tmux.js";
import { classifyPaneCommand, evaluateExecPolicy, hashCommand, redactedCommand } from "./exec-policy.js";
import { genId, nowIso } from "./ids.js";

export interface ExecDeps {
  tmux: Tmux;
  /** When present, the exec audit record is persisted and updated. */
  store?: Store;
  /** Kept injectable for tests and future confirmation waits. */
  sleep?: (ms: number) => Promise<void>;
}

/** Exact tmux input plan used by dispatch exec. */
export function buildExecPlan(command: string, forceInterrupt = false): ExecDeliveryPlan {
  return { interrupt: forceInterrupt, pasteText: command.trim(), submitKey: "Enter" };
}

/** Validate, audit, and optionally deliver a shell command to a tmux shell pane. */
export async function performExec(options: ExecOptions, deps: ExecDeps): Promise<DispatchRecord> {
  const { tmux, store } = deps;
  const machine = tmux.machine;
  const plan = buildExecPlan(options.command, options.forceInterrupt === true);
  const initialHash = hashCommand(plan.pasteText);
  const redacted = redactedCommand(initialHash);
  const auditPlan: ExecDeliveryPlan = { ...plan, pasteText: redacted };

  let record: DispatchRecord = store
    ? store.createDispatch({
        kind: "exec",
        target: options.target,
        machine,
        prompt: redacted,
        status: "sending",
        commandHash: initialHash,
        dryRun: options.dryRun === true,
        execPlan: auditPlan,
      })
    : {
        id: genId(),
        kind: "exec",
        target: options.target,
        machine,
        prompt: redacted,
        status: "sending",
        commandHash: initialHash,
        dryRun: options.dryRun === true,
        execPlan: auditPlan,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

  const finish = (patch: Partial<DispatchRecord>): DispatchRecord => {
    record = { ...record, ...patch, updatedAt: nowIso() };
    if (store) {
      const persisted = store.updateDispatch(record.id, {
        status: record.status,
        detail: record.detail,
        deliveredAt: record.deliveredAt,
        commandHash: record.commandHash,
        filter: record.filter
          ? { ...record.filter, normalizedCommand: redactedCommand(record.filter.commandHash) }
          : undefined,
        targetKind: record.targetKind,
        dryRun: record.dryRun,
        execPlan: record.execPlan ? { ...record.execPlan, pasteText: redactedCommand(record.commandHash ?? initialHash) } : undefined,
      });
      record = { ...record, updatedAt: persisted.updatedAt };
    }
    return record;
  };

  if (!tmux.paneExists(options.target)) {
    return finish({ status: "failed", detail: `target pane not found: ${options.target} (machine: ${machine})` });
  }

  const paneCommand = tmux.paneProperty(options.target, "pane_current_command");
  const targetKind = classifyPaneCommand(paneCommand);
  const filter = evaluateExecPolicy({
    target: options.target,
    targetKind,
    command: plan.pasteText,
    policy: options.policy,
    requireTargetOptIn: options.dryRun !== true,
  });

  if (!filter.allowed) {
    return finish({
      status: "skipped",
      detail: filter.reason,
      commandHash: filter.commandHash,
      filter,
      targetKind,
      dryRun: options.dryRun === true,
      execPlan: auditPlan,
    });
  }

  if (options.dryRun === true) {
    return finish({
      status: "skipped",
      detail: "dry run: command would be submitted",
      commandHash: filter.commandHash,
      filter,
      targetKind,
      dryRun: true,
      execPlan: plan,
    });
  }

  try {
    tmux.exitCopyMode(options.target);
    if (plan.interrupt) tmux.sendKey(options.target, "C-c");
    tmux.paste(options.target, plan.pasteText, { bracketed: true });
    tmux.sendKey(options.target, plan.submitKey);
  } catch (err) {
    return finish({
      status: "failed",
      detail: `exec delivery failed: ${(err as Error).message}`,
      commandHash: filter.commandHash,
      filter,
      targetKind,
      dryRun: false,
      execPlan: auditPlan,
    });
  }

  return finish({
    status: "delivered",
    detail: "command submitted to shell",
    commandHash: filter.commandHash,
    filter,
    targetKind,
    dryRun: false,
    execPlan: auditPlan,
    deliveredAt: nowIso(),
  });
}
