import type { DispatchOptions, DispatchRecord } from "../types.js";
import { Tmux } from "./tmux.js";
import type { Store } from "./store.js";
import { computeSubmitDelay } from "./delay.js";
import { submit } from "./submit.js";
import { confirmDelivery, evaluateDelivery } from "./confirm.js";
import { genId, nowIso } from "./ids.js";
import { classifyPaneCommand, isAgentWrapperCommand, looksLikeWrappedAgentComposer } from "./exec-policy.js";

/** Single-line prompts longer than this also go through paste, not send-keys. */
export const PASTE_LENGTH_THRESHOLD = 1000;

export type DeliveryMode = "paste" | "literal";

/** Decide how to deliver the prompt. Multiline always pastes (newlines submit). */
export function chooseMode(prompt: string, mode: DispatchOptions["mode"] = "auto"): DeliveryMode {
  if (mode === "paste" || mode === "literal") return mode;
  if (prompt.includes("\n")) return "paste";
  if (prompt.length > PASTE_LENGTH_THRESHOLD) return "paste";
  return "literal";
}

export interface DispatchDeps {
  tmux: Tmux;
  /** When present, the dispatch is persisted and updated as it progresses. */
  store?: Store;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Execute a single dispatch end-to-end: validate the target, deliver the prompt
 * (literal or bracketed paste), wait the auto-computed delay, submit with retry,
 * and confirm delivery — recording every step when a store is provided.
 */
export async function performDispatch(options: DispatchOptions, deps: DispatchDeps): Promise<DispatchRecord> {
  const { tmux, store, sleep } = deps;
  const machine = tmux.machine;
  const submitEnabled = options.submit !== false;
  const confirmEnabled = options.confirm !== false;

  // Create (or synthesize) the record.
  let record: DispatchRecord = store
    ? store.createDispatch({ target: options.target, machine, prompt: options.prompt, status: "sending" })
    : {
        id: genId(),
        kind: "prompt",
        target: options.target,
        machine,
        prompt: options.prompt,
        status: "sending",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

  const finish = (patch: Partial<DispatchRecord>): DispatchRecord => {
    record = { ...record, ...patch, updatedAt: nowIso() };
    if (store) {
      record = store.updateDispatch(record.id, {
        status: record.status,
        detail: record.detail,
        confirm: record.confirm,
        submitDelayMs: record.submitDelayMs,
        deliveredAt: record.deliveredAt,
      });
    }
    return record;
  };

  // 1. Validate target.
  if (!tmux.paneExists(options.target)) {
    return finish({ status: "failed", detail: `target pane not found: ${options.target} (machine: ${machine})` });
  }
  const paneCommand = tmux.paneProperty(options.target, "pane_current_command");
  const targetKind = classifyPaneCommand(paneCommand);
  const shellCommand = targetKind === "shell";
  if (shellCommand) {
    return finish({
      status: "failed",
      detail: `target appears to be a shell (${paneCommand || "unknown"}); use dispatch exec for shell commands`,
    });
  }

  // If the pane is scrolled into copy-mode, visible captures can show stale
  // scrollback. Exit first so wrapper safety checks inspect the live process.
  try {
    if (tmux.paneInMode(options.target) && !tmux.exitCopyMode(options.target)) {
      return finish({
        status: "failed",
        detail: "target is in tmux copy-mode or another pane mode; refusing prompt delivery until mode exits",
      });
    }
  } catch {
    return finish({
      status: "failed",
      detail: "could not verify target left tmux copy-mode; refusing prompt delivery",
    });
  }

  if (targetKind !== "agent") {
    if (!isAgentWrapperCommand(paneCommand)) {
      return finish({
        status: "failed",
        detail: `target is not a recognized agent composer (${paneCommand || "unknown"}); refusing prompt delivery`,
      });
    }
    const visibleBefore = tmux.capturePane(options.target);
    const processTree = tmux.processTree(options.target);
    if (!looksLikeWrappedAgentComposer(visibleBefore, { processTree })) {
      return finish({
        status: "failed",
        detail: `target is not a recognized agent composer (${paneCommand || "unknown"}); refusing prompt delivery`,
      });
    }
  }
  const before = tmux.capturePane(options.target, { start: 50 });

  // 3. Deliver the prompt.
  const mode = chooseMode(options.prompt, options.mode);
  try {
    if (mode === "paste") {
      tmux.paste(options.target, options.prompt, { bracketed: true });
    } else {
      tmux.sendLiteral(options.target, options.prompt);
    }
  } catch (err) {
    return finish({ status: "failed", detail: `delivery failed: ${(err as Error).message}` });
  }

  // 4. Snapshot what the composer holds (best-effort).
  let afterTyped: string | undefined;
  try {
    afterTyped = tmux.capturePane(options.target, { start: 50 });
  } catch {
    afterTyped = undefined;
  }

  const delayMs = options.submitDelayMs ?? computeSubmitDelay(options.prompt);

  // 5. Type-only mode: don't submit.
  if (!submitEnabled) {
    return finish({
      status: "delivered",
      detail: "typed into composer without submitting (submit disabled)",
      submitDelayMs: delayMs,
      deliveredAt: nowIso(),
    });
  }

  // 6. Submit with retry, probing delivery if confirmation is enabled.
  const probe = confirmEnabled
    ? async (): Promise<boolean> => {
        const after = tmux.capturePane(options.target, { start: 50 });
        return evaluateDelivery({ before, after, afterTyped, prompt: options.prompt, shellCommand }).delivered;
      }
    : undefined;

  await submit(tmux, options.target, {
    delayMs,
    maxRetries: options.maxSubmitRetries ?? 2,
    isSubmitted: probe,
    sleep,
  });

  // 7. Confirm + record.
  if (!confirmEnabled) {
    return finish({
      status: "delivered",
      detail: "submitted (confirmation disabled)",
      submitDelayMs: delayMs,
      deliveredAt: nowIso(),
    });
  }

  const confirm = await confirmDelivery(tmux, options.target, {
    before,
    afterTyped,
    prompt: options.prompt,
    waitMs: 250,
    maxPolls: 3,
    shellCommand,
    sleep,
  });

  return finish({
    status: confirm.delivered ? "delivered" : "failed",
    detail: confirm.reason,
    confirm,
    submitDelayMs: delayMs,
    deliveredAt: confirm.delivered ? nowIso() : undefined,
  });
}
