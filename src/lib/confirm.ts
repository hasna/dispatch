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

const LIVE_WORKING_PATTERNS: RegExp[] = [
  /esc to interrupt/i,
  /esc to cancel/i,
  /ctrl\+c to (stop|interrupt|cancel)/i,
  /\besc\b.*\binterrupt\b/i,
  /\bPursuing goal\b/i,
  /(^|\n)\s*(?:[•●]\s*)?(?:thinking|working|generating|processing|crunching|pondering|forming|cooking)\s*\(/i,
  /(^|\n)\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
  /[▰▱]/,
  /✶|✻|✽/,
];

function detectLiveWorking(text: string): boolean {
  return detectWorking(text, LIVE_WORKING_PATTERNS);
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
 * Patterns indicating the target app handled the prompt immediately by
 * rejecting it, for example a disabled slash command while another turn is
 * streaming. This is delivery evidence: retrying would repeat the side effect.
 */
export const DEFAULT_HANDLED_OUTPUT_PATTERNS: RegExp[] = [
  /\bdisabled\b/i,
  /\bnot\s+(available|enabled|supported|allowed)\b/i,
  /\bunavailable\b/i,
  /\bunknown\s+(slash\s+)?command\b/i,
  /\bslash\s+command\b.*\b(disabled|unavailable|not\s+(available|enabled|supported|allowed))\b/i,
  /\bcommand\b.*\b(disabled|unavailable|not\s+(available|enabled|supported|allowed))\b/i,
];

/** True if the text contains a handled rejection/disabled-output signal. */
export function detectHandledOutput(text: string, patterns: RegExp[] = DEFAULT_HANDLED_OUTPUT_PATTERNS): boolean {
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

function handledOutputLineCount(text: string, patterns: RegExp[] = DEFAULT_HANDLED_OUTPUT_PATTERNS): number {
  return text.split("\n").filter((line) => detectHandledOutput(line, patterns)).length;
}

function livePaneRegion(text: string, maxLines = 14): string {
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  const tail = lines.slice(Math.max(0, lines.length - maxLines));
  return tail.join("\n");
}

function promptParkedInComposer(text: string, tail: string): boolean {
  if (tail.length === 0) return false;
  const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/(?:^|[\s│┃║╎╏┆┇┊┋▏▎▌▐])[>›](?:\s|$)/.test(lines[i] ?? "")) continue;
    return squish(lines.slice(i).join("\n")).includes(tail);
  }
  return false;
}

function queuedPromptVisible(text: string, tail: string, patterns: RegExp[] = DEFAULT_QUEUED_PATTERNS): boolean {
  if (tail.length === 0) return false;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!detectQueued(lines[i] ?? "", patterns)) continue;
    return squish(lines.slice(i).join("\n")).includes(tail);
  }
  return false;
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
  /** Override handled rejection/disabled-output patterns. */
  handledOutputPatterns?: RegExp[];
  /** True when the target pane is a shell rather than an agent composer. */
  shellCommand?: boolean;
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
  const handledOutputPatterns = input.handledOutputPatterns ?? DEFAULT_HANDLED_OUTPUT_PATTERNS;
  const tail = squish(promptTail(input.prompt));

  // Baseline = how the pane looked right after typing (before Enter). Falls back
  // to the pre-dispatch capture when no typed snapshot is available.
  const baseline = input.afterTyped ?? input.before;

  const promptVisible = (text: string): boolean => tail.length > 0 && squish(text).includes(tail);
  const visibleInBaseline = promptVisible(baseline);
  const visibleInAfter = promptVisible(input.after);
  const parkedInBaseline = promptParkedInComposer(baseline, tail);
  const parkedInAfter = promptParkedInComposer(input.after, tail);
  const composerCleared = parkedInBaseline && !parkedInAfter;

  const workingBefore = patterns === DEFAULT_WORKING_PATTERNS
    ? detectLiveWorking(livePaneRegion(input.before))
    : detectWorking(livePaneRegion(input.before), patterns);
  const workingAfter = patterns === DEFAULT_WORKING_PATTERNS
    ? detectLiveWorking(livePaneRegion(input.after))
    : detectWorking(livePaneRegion(input.after), patterns);
  const workingDetected = workingAfter && !workingBefore && !visibleInAfter;

  const queuedDetected =
    (detectQueued(input.after, queuedPatterns) && !detectQueued(input.before, queuedPatterns)) ||
    (queuedPromptVisible(input.after, tail, queuedPatterns) && !queuedPromptVisible(input.before, tail, queuedPatterns));

  // Did pressing Enter change the pane at all (vs the just-typed state)?
  const paneAdvanced = normalize(input.after) !== normalize(baseline);
  const handledOutputDetected =
    handledOutputLineCount(input.after, handledOutputPatterns) > handledOutputLineCount(baseline, handledOutputPatterns);

  const promptStillParkedInBusyPane = parkedInAfter && !composerCleared && !queuedDetected;
  const actedOnVisiblePrompt = paneAdvanced && visibleInAfter && !parkedInAfter && !promptStillParkedInBusyPane;
  const shellEchoedCommand = input.shellCommand === true && visibleInBaseline && visibleInAfter;
  const delivered =
    queuedDetected ||
    handledOutputDetected ||
    workingDetected ||
    composerCleared ||
    (!visibleInAfter && paneAdvanced) ||
    actedOnVisiblePrompt ||
    shellEchoedCommand;
  const queued = delivered && queuedDetected;

  let reason: string;
  if (queuedDetected) {
    reason = "prompt accepted but queued for submission (agent busy)";
  } else if (handledOutputDetected) {
    reason = "target handled the prompt with disabled/rejection output";
  } else if (workingDetected) {
    reason = "working/interrupt indicator appeared after submit";
  } else if (composerCleared) {
    reason = "prompt left the composer after submit";
  } else if (shellEchoedCommand) {
    reason = "shell command echo remained visible after submit";
  } else if (delivered && paneAdvanced) {
    reason = "pane advanced after submit (prompt was acted on)";
  } else if (promptStillParkedInBusyPane) {
    reason = "prompt is still parked in the composer while the busy indicator changed — not submitted";
  } else if (visibleInAfter) {
    reason = "prompt is still parked in the composer unchanged — not submitted";
  } else {
    reason = "no change after submit — not delivered";
  }

  return { delivered, reason, composerCleared, workingDetected, queued, handledOutput: delivered && handledOutputDetected };
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
  handledOutputPatterns?: RegExp[];
  shellCommand?: boolean;
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
      handledOutputPatterns: opts.handledOutputPatterns,
      shellCommand: opts.shellCommand,
    });
    if (last.delivered) return last;
  }
  return last;
}
