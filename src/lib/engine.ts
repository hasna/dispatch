import type { DispatchOptions, DispatchRecord } from "../types.js";
import { Tmux } from "./tmux.js";
import type { Store } from "./store.js";
import { computeSubmitDelay } from "./delay.js";
import { submit } from "./submit.js";
import { confirmDelivery, evaluateDelivery } from "./confirm.js";
import { genId, nowIso } from "./ids.js";
import { validateAgentComposerTarget } from "./agent-target.js";

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

/** Prefix a prompt as a Codewith goal without trimming or rewriting the user's body. */
export function applyGoalPrefix(prompt: string, enabled = false): string {
  if (!enabled || /^\/goal(?:\s|$)/.test(prompt)) return prompt;
  return `/goal ${prompt}`;
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
  const prompt = applyGoalPrefix(options.prompt, options.goal === true);

  // Create (or synthesize) the record.
  let record: DispatchRecord = store
    ? store.createDispatch({ target: options.target, machine, prompt, status: "sending" })
    : {
        id: genId(),
        kind: "prompt",
        target: options.target,
        machine,
        prompt,
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
  const target = validateAgentComposerTarget(tmux, options.target);
  const shellCommand = target.targetKind === "shell";
  if (!target.ok) return finish({ status: "failed", detail: target.detail });
  const before = tmux.capturePane(options.target, { start: 50 });

  // 3. Deliver the prompt.
  const mode = chooseMode(prompt, options.mode);
  try {
    if (mode === "paste") {
      tmux.paste(options.target, prompt, { bracketed: true });
    } else {
      tmux.sendLiteral(options.target, prompt);
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

  const delayMs = options.submitDelayMs ?? computeSubmitDelay(prompt);

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
        return evaluateDelivery({ before, after, afterTyped, prompt, shellCommand }).delivered;
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
    prompt,
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
