import type { Tmux } from "./tmux.js";
import type { SubmitKey } from "../types.js";

/** Default sleep using the host timer. Injectable for tests. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SubmitOptions {
  /** Pre-Enter delay (ms) — usually from computeSubmitDelay. */
  delayMs: number;
  /** Max additional Enter retries if submission is not confirmed. Default 2. */
  maxRetries?: number;
  /** Submit key to press after typing. Default Enter. */
  submitKey?: SubmitKey;
  /** Wait between retries (ms) while re-probing. Default 450. */
  retryIntervalMs?: number;
  /**
   * Probe that returns true once the prompt is confirmed submitted (e.g. the
   * composer cleared / the agent started working). When omitted, submission is
   * best-effort: a single Enter after the delay.
   */
  isSubmitted?: () => boolean | Promise<boolean>;
  /** Injectable sleep (defaults to realSleep). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SubmitResult {
  submitted: boolean;
  /** Number of submit keypresses issued. */
  attempts: number;
}

/**
 * Reliably submit an already-delivered prompt: wait the computed delay so the
 * full text is registered, press Enter, and — if a probe is supplied — re-press
 * Enter until submission is confirmed or retries are exhausted. This is the fix
 * for the flaky-Enter problem where text sits unsubmitted in the composer.
 */
export async function submit(tmux: Tmux, target: string, opts: SubmitOptions): Promise<SubmitResult> {
  const sleep = opts.sleep ?? realSleep;
  const maxRetries = opts.maxRetries ?? 2;
  const retryIntervalMs = opts.retryIntervalMs ?? 450;
  const submitKey = opts.submitKey ?? "Enter";

  await sleep(Math.max(0, opts.delayMs));
  tmux.sendKey(target, submitKey);
  let attempts = 1;

  if (!opts.isSubmitted) {
    return { submitted: true, attempts };
  }

  for (let retry = 0; retry <= maxRetries; retry++) {
    await sleep(retryIntervalMs);
    if (await opts.isSubmitted()) {
      return { submitted: true, attempts };
    }
    if (retry < maxRetries) {
      tmux.sendKey(target, submitKey);
      attempts++;
    }
  }

  return { submitted: false, attempts };
}
