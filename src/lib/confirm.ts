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

/** Normalize a pane capture for substring matching (collapse whitespace runs). */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
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
}

/**
 * Decide whether a dispatched prompt was actually received/submitted by
 * comparing pane captures. Evidence, strongest first:
 *  - a working/interrupt indicator appeared that wasn't there before, and/or
 *  - the prompt text that was in the composer cleared after Enter.
 */
export function evaluateDelivery(input: EvaluateDeliveryInput): ConfirmResult {
  const patterns = input.workingPatterns ?? DEFAULT_WORKING_PATTERNS;
  const tail = promptTail(input.prompt);

  const workingBefore = detectWorking(input.before, patterns);
  const workingAfter = detectWorking(input.after, patterns);
  const workingDetected = workingAfter && !workingBefore;

  const afterNorm = normalize(input.after);
  const promptInAfter = tail.length > 0 && afterNorm.includes(tail);

  let composerCleared: boolean;
  if (input.afterTyped !== undefined) {
    const typedNorm = normalize(input.afterTyped);
    const wasInComposer = tail.length > 0 && typedNorm.includes(tail);
    composerCleared = wasInComposer && !promptInAfter;
  } else {
    // Without a typed snapshot, treat the prompt no longer being visible as a
    // weaker "cleared" signal.
    composerCleared = tail.length > 0 && !promptInAfter;
  }

  const delivered = workingDetected || composerCleared;

  let reason: string;
  if (workingDetected && composerCleared) {
    reason = "agent is working (interrupt indicator appeared) and composer cleared";
  } else if (workingDetected) {
    reason = "working/interrupt indicator appeared after submit";
  } else if (composerCleared) {
    reason = "prompt left the composer after submit";
  } else if (promptInAfter) {
    reason = "prompt still visible in composer — likely not submitted";
  } else {
    reason = "no working indicator and no composer change detected";
  }

  return { delivered, reason, composerCleared, workingDetected };
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
    });
    if (last.delivered) return last;
  }
  return last;
}
