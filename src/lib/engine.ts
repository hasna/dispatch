import type { DispatchOptions, DispatchRecord } from "../types.js";
import { Tmux } from "./tmux.js";
import type { Store } from "./store.js";
import { computeSubmitDelay } from "./delay.js";
import { submit } from "./submit.js";
import { confirmDelivery, evaluateDelivery, isPromptParkedInComposer } from "./confirm.js";
import { genId, nowIso } from "./ids.js";
import { validateAgentComposerTarget } from "./agent-target.js";
import { performCapture } from "./capture.js";

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

function resolveSubmitKey(options: DispatchOptions, targetState: string): "Enter" | "Tab" {
  if (options.submitKey === "Enter" || options.submitKey === "Tab") return options.submitKey;
  if (options.queue === true && targetState === "active") return "Tab";
  return "Enter";
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
  const dryRun = options.dryRun === true;

  // Create (or synthesize) the record.
  let record: DispatchRecord = store
    ? store.createDispatch({ target: options.target, machine, prompt, status: "sending", dryRun })
    : {
        id: genId(),
        kind: "prompt",
        target: options.target,
        machine,
        prompt,
        status: "sending",
        dryRun,
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
        dryRun: record.dryRun,
        targetState: record.targetState,
        detection: record.detection,
        captureBefore: record.captureBefore,
      });
    }
    return record;
  };

  // 1. Validate target.
  const target = validateAgentComposerTarget(tmux, options.target);
  const shellCommand = target.targetKind === "shell";
  if (!target.ok) {
    return finish({
      status: "failed",
      detail: target.detail,
      targetState: target.activity,
      detection: target.detection,
    });
  }
  const targetState = target.activity ?? "unknown";
  const detection = target.detection;
  const submitKey = resolveSubmitKey(options, targetState);
  let captureBefore = target.visible && options.captureBeforeLines
    ? await performCapture({ target: options.target, lines: options.captureBeforeLines }, { tmux })
    : undefined;
  if (!captureBefore && options.captureBeforeLines) {
    captureBefore = await performCapture({ target: options.target, lines: options.captureBeforeLines }, { tmux });
  }
  const before = tmux.capturePane(options.target, { start: 50 });
  record = { ...record, targetState, detection, captureBefore };

  if (submitKey === "Tab" && detection?.canQueuePrompt !== true) {
    return finish({
      status: "skipped",
      detail: `target does not prove queued Tab prompt support (${detection?.reason ?? "no detection available"})`,
      targetState,
      detection,
      captureBefore,
      dryRun,
    });
  }

  if (submitEnabled && submitKey === "Enter" && detection?.canReceivePrompt !== true && options.forceActive !== true) {
    return finish({
      status: "skipped",
      detail: `target cannot receive an Enter prompt safely (${detection?.reason ?? "no detection available"}); pass --queue for supported active agents or --force-active to override`,
      targetState,
      detection,
      captureBefore,
      dryRun,
    });
  }

  if (!submitEnabled && detection?.canReceivePrompt !== true && options.forceActive !== true) {
    return finish({
      status: "skipped",
      detail: `target is not idle; refusing to type without submit (${detection?.reason ?? "no detection available"}); pass --force-active to override`,
      targetState,
      detection,
      captureBefore,
      dryRun,
    });
  }

  if (options.ifIdle && targetState !== "idle" && submitKey !== "Tab" && options.forceActive !== true) {
    return finish({
      status: "skipped",
      detail: `target is ${targetState}; refusing because --if-idle was requested (pass --queue to let the agent queue it, or --force-active to override)`,
      targetState,
      detection,
      captureBefore,
      dryRun,
    });
  }

  // 3. Deliver the prompt.
  const mode = chooseMode(prompt, options.mode);
  const delayMs = options.submitDelayMs ?? computeSubmitDelay(prompt);

  if (dryRun) {
    return finish({
      status: "skipped",
      detail: `dry run: prompt would be ${submitEnabled ? `submitted with ${submitKey}` : "typed without submitting"} using ${mode} delivery`,
      submitDelayMs: delayMs,
      targetState,
      detection,
      captureBefore,
      dryRun: true,
    });
  }

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

  // 5. Type-only mode: don't submit.
  if (!submitEnabled) {
    return finish({
      status: "delivered",
      detail: "typed into composer without submitting (submit disabled)",
      submitDelayMs: delayMs,
      deliveredAt: nowIso(),
      targetState,
      detection,
      captureBefore,
    });
  }

  // 6. Submit with retry, probing delivery if confirmation is enabled.
  let checkedInitialParkedSnapshot = false;
  const isPromptParked = mode === "paste"
    ? (): boolean => {
        if (!checkedInitialParkedSnapshot) {
          checkedInitialParkedSnapshot = true;
          if (afterTyped && isPromptParkedInComposer(afterTyped, prompt)) return true;
        }
        const latest = tmux.capturePane(options.target, { start: 50 });
        afterTyped = latest;
        return isPromptParkedInComposer(latest, prompt);
      }
    : undefined;
  const probe = confirmEnabled
    ? async (): Promise<boolean> => {
        const after = tmux.capturePane(options.target, { start: 50 });
        const verdict = evaluateDelivery({ before, after, afterTyped, prompt, shellCommand });
        // Stop retrying submit keys once the target has entered a known
        // operator-action-needed state. Final confirmation will record failure.
        return verdict.delivered || verdict.actionNeeded === true;
      }
    : undefined;

  await submit(tmux, options.target, {
    delayMs,
    maxRetries: submitKey === "Tab" ? 0 : options.maxSubmitRetries ?? 2,
    submitKey,
    isPromptParked,
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
      targetState,
      detection,
      captureBefore,
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
    targetState,
    detection,
    captureBefore,
  });
}
