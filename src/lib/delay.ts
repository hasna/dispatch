/**
 * Auto-calculate how long to wait after delivering a prompt before pressing
 * Enter. The longer the prompt, the more time the target TUI needs to register
 * and render every character before submission — pressing Enter too early
 * submits a partial prompt or no-ops. The delay grows with word and character
 * count and is clamped to a sane range.
 */

export interface SubmitDelayOptions {
  /** Floor in ms (default 400, env DISPATCH_MIN_DELAY_MS). */
  minMs?: number;
  /** Ceiling in ms (default 4000, env DISPATCH_MAX_DELAY_MS). */
  maxMs?: number;
  /** Per-word contribution in ms (default 9, env DISPATCH_MS_PER_WORD). */
  msPerWord?: number;
  /** Per-character contribution in ms (default 0.6, env DISPATCH_MS_PER_CHAR). */
  msPerChar?: number;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Count whitespace-delimited words in the text. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Compute the pre-Enter delay (ms) for a prompt from its word/char count.
 * Monotonic in length, clamped to [minMs, maxMs].
 */
export function computeSubmitDelay(text: string, opts: SubmitDelayOptions = {}): number {
  const minMs = opts.minMs ?? envNum("DISPATCH_MIN_DELAY_MS", 400);
  const maxMs = opts.maxMs ?? envNum("DISPATCH_MAX_DELAY_MS", 4000);
  const msPerWord = opts.msPerWord ?? envNum("DISPATCH_MS_PER_WORD", 9);
  const msPerChar = opts.msPerChar ?? envNum("DISPATCH_MS_PER_CHAR", 0.6);

  const words = countWords(text);
  const chars = text.length;
  const raw = minMs + words * msPerWord + chars * msPerChar;
  const clamped = Math.min(maxMs, Math.max(minMs, raw));
  return Math.round(clamped);
}
