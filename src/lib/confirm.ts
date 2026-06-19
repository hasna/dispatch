import type { ConfirmResult } from "../types.js";
import type { Tmux } from "./tmux.js";
import { realSleep } from "./submit.js";

/**
 * Footer/status patterns that coding-agent TUIs show while processing a prompt.
 * Their appearance after submit is strong evidence the prompt was received.
 * Covers Claude Code, Codex, and common generic spinners. Case-insensitive.
 */
export const DEFAULT_WORKING_PATTERNS: RegExp[] = [
  /esc to interrupt/i,
  /esc to cancel/i,
  /ctrl\+c to (stop|interrupt|cancel)/i,
  /\b(thinking|working|generating|processing|crunching|pondering|forming|cooking)\b/i,
  /\besc\b.*\binterrupt\b/i,
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // braille spinner frames
  /[▰▱]/, // bar spinner
  /✶|✻|✽|·\s*$/m,
];

/** True if any working pattern matches the text. */
export function detectWorking(text: string, patterns: RegExp[] = DEFAULT_WORKING_PATTERNS): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Patterns a busy coding agent shows when it accepts a message but stages it for
 * later submission (e.g. Codewith/Claude Code while a tool call is running).
 * Their appearance means the prompt was delivered (queued), not rejected.
 */
export const DEFAULT_QUEUED_PATTERNS: RegExp[] = [
  /messages?\s+to\s+be\s+submitted/i,
  /to be submitted after/i,
  /\bqueued\b/i,
  /will be (submitted|sent)/i,
  /pending submission/i,
  /submitted after (the |your )?next/i,
];

/** True if any queued/staged pattern matches the text. */
export function detectQueued(text: string, patterns: RegExp[] = DEFAULT_QUEUED_PATTERNS): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * A distinctive tail of the prompt used to detect whether it is still sitting
 * unsent in the composer. We use the last non-empty line (trimmed, collapsed
 * whitespace), capped, since the composer shows the end of what was typed.
 */
export function promptTail(prompt: string, maxLen = 48): string {
  const lines = prompt.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const collapsed = last.replace(/\s+/g, " ");
  return collapsed.slice(Math.max(0, collapsed.length - maxLen));
}

/** Normalize a pane capture for change detection (collapse whitespace runs). */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Collapse ALL whitespace so wrapped/echoed text still matches contiguously. */
function squish(text: string): string {
  return text.replace(/\s+/g, "");
}

export interface EvaluateDeliveryInput {
  /** Pane capture before dispatch. */
  before: string;
  /** Pane capture after submit. */
  after: string;
  /** Optional capture taken after typing but before pressing Enter. */
  afterTyped?: string;
  /** The prompt that was dispatched. */
  prompt: string;
  /** Override working-state patterns. */
  workingPatterns?: RegExp[];
  /** Override queued/staged patterns. */
  queuedPatterns?: RegExp[];
}

/**
 * Decide whether a dispatched prompt was actually received/submitted by
 * comparing pane captures.
 *
 * The core insight: pressing Enter on a delivered prompt *changes the pane* —
 * the composer clears, a working/interrupt indicator appears, the agent queues
 * the message, or a shell echoes the command and prints output. A genuine
 * delivery failure is the opposite: Enter is a no-op and the pane is unchanged
 * from the moment we finished typing. So we treat any meaningful change after
 * submit as delivered, and reserve "not delivered" for the unchanged case.
 *
 * Matching is whitespace-insensitive so line-wrapped prompts and command echo
 * in scrollback are recognized rather than mistaken for an unsent composer.
 */
export function evaluateDelivery(input: EvaluateDeliveryInput): ConfirmResult {
  const patterns = input.workingPatterns ?? DEFAULT_WORKING_PATTERNS;
  const queuedPatterns = input.queuedPatterns ?? DEFAULT_QUEUED_PATTERNS;
  const tail = squish(promptTail(input.prompt));

  // Baseline = how the pane looked right after typing (before Enter). Falls back
  // to the pre-dispatch capture when no typed snapshot is available.
  const baseline = input.afterTyped ?? input.before;

  const workingBefore = detectWorking(input.before, patterns);
  const workingAfter = detectWorking(input.after, patterns);
  const workingDetected = workingAfter && !workingBefore;

  const queuedDetected = detectQueued(input.after, queuedPatterns) && !detectQueued(input.before, queuedPatterns);

  const promptVisible = (text: string): boolean => tail.length > 0 && squish(text).includes(tail);
  const visibleInBaseline = promptVisible(baseline);
  const visibleInAfter = promptVisible(input.after);
  const composerCleared = visibleInBaseline && !visibleInAfter;

  // Did pressing Enter change the pane at all (vs the just-typed state)?
  const paneAdvanced = normalize(input.after) !== normalize(baseline);

  // A busy agent that stays "working" and now shows our prompt has queued it.
  const busyQueued = workingAfter && visibleInAfter && !composerCleared && paneAdvanced;

  const delivered = workingDetected || queuedDetected || composerCleared || paneAdvanced;
  const queued = delivered && (queuedDetected || busyQueued);

  let reason: string;
  if (queuedDetected || busyQueued) {
    reason = "prompt accepted but queued for submission (agent busy)";
  } else if (workingDetected) {
    reason = "working/interrupt indicator appeared after submit";
  } else if (composerCleared) {
    reason = "prompt left the composer after submit";
  } else if (paneAdvanced) {
    reason = "pane advanced after submit (prompt was acted on)";
  } else if (visibleInAfter) {
    reason = "prompt is still parked in the composer unchanged — not submitted";
  } else {
    reason = "no change after submit — not delivered";
  }

  return { delivered, reason, composerCleared, workingDetected, queued };
}

export interface ConfirmDeliveryOptions {
  before: string;
  prompt: string;
  afterTyped?: string;
  /** How long to wait for the TUI to react before capturing `after`. Default 700ms. */
  waitMs?: number;
  /** Poll up to this many times waiting for a positive signal. Default 4. */
  maxPolls?: number;
  workingPatterns?: RegExp[];
  queuedPatterns?: RegExp[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Capture the pane after a dispatch and evaluate delivery, polling a few times
 * so a slightly-delayed working indicator is still caught.
 */
export async function confirmDelivery(
  tmux: Tmux,
  target: string,
  opts: ConfirmDeliveryOptions,
): Promise<ConfirmResult> {
  const sleep = opts.sleep ?? realSleep;
  const waitMs = opts.waitMs ?? 700;
  const maxPolls = opts.maxPolls ?? 4;

  let last: ConfirmResult = { delivered: false, reason: "not yet evaluated" };
  for (let i = 0; i < maxPolls; i++) {
    await sleep(i === 0 ? waitMs : Math.round(waitMs / 2));
    const after = tmux.capturePane(target, { start: 50 });
    last = evaluateDelivery({
      before: opts.before,
      after,
      afterTyped: opts.afterTyped,
      prompt: opts.prompt,
      workingPatterns: opts.workingPatterns,
      queuedPatterns: opts.queuedPatterns,
    });
    if (last.delivered) return last;
  }
  return last;
}
