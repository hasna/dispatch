import type { Tmux } from "./tmux.js";
import type { SubmitKey } from "../types.js";

/** Default sleep using the host timer. Injectable for tests. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SubmitOptions {
  /** Pre-Enter delay (ms) — usually from computeSubmitDelay. */
  delayMs: number;
  /** Max additional Enter retries if submission is not confirmed. Default derives from DISPATCH_SUBMIT_TIMEOUT_MS. */
  maxRetries?: number;
  /** Submit key to press after typing. Default Enter. */
  submitKey?: SubmitKey;
  /** Probe that returns true once the typed prompt tail is visible in the composer. */
  isPromptParked?: () => boolean | Promise<boolean>;
  /** Max prompt-parked probes before refusing to submit. Default derives from DISPATCH_SETTLE_TIMEOUT_MS. */
  maxSettlePolls?: number;
  /** Total settle budget when maxSettlePolls is not supplied. Default 2000ms. */
  settleTimeoutMs?: number;
  /** Wait between prompt-parked probes (ms). Default 250. */
  settleIntervalMs?: number;
  /** Total submit confirmation budget when maxRetries is not supplied. Default 10000ms. */
  submitTimeoutMs?: number;
  /** Wait between retries (ms) while re-probing. Default 2000. */
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
  /** Whether the prompt was proven parked before the first submit key, when a probe was supplied. */
  settled?: boolean;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Reliably submit an already-delivered prompt: wait the computed delay so the
 * full text is registered, press Enter, and — if a probe is supplied — re-press
 * Enter until submission is confirmed or retries are exhausted. This is the fix
 * for the flaky-Enter problem where text sits unsubmitted in the composer.
 */
export async function submit(tmux: Tmux, target: string, opts: SubmitOptions): Promise<SubmitResult> {
  const sleep = opts.sleep ?? realSleep;
  const retryIntervalMs = Math.max(0, opts.retryIntervalMs ?? envNum("DISPATCH_SUBMIT_RETRY_INTERVAL_MS", 2000));
  const submitTimeoutMs = Math.max(0, opts.submitTimeoutMs ?? envNum("DISPATCH_SUBMIT_TIMEOUT_MS", 10000));
  const maxRetries = opts.maxRetries ??
    Math.max(0, Math.ceil(submitTimeoutMs / Math.max(1, retryIntervalMs)) - 1);
  const settleIntervalMs = Math.max(0, opts.settleIntervalMs ?? 250);
  const settleTimeoutMs = Math.max(0, opts.settleTimeoutMs ?? envNum("DISPATCH_SETTLE_TIMEOUT_MS", 2000));
  const maxSettlePolls = opts.maxSettlePolls ??
    Math.max(0, Math.ceil(settleTimeoutMs / Math.max(1, settleIntervalMs)));
  const submitKey = opts.submitKey ?? "Enter";
  let settled: boolean | undefined;

  await sleep(Math.max(0, opts.delayMs));

  if (opts.isPromptParked) {
    settled = false;
    for (let poll = 0; poll <= maxSettlePolls; poll += 1) {
      if (await opts.isPromptParked()) {
        settled = true;
        break;
      }
      if (poll < maxSettlePolls) await sleep(settleIntervalMs);
    }
    if (!settled) return { submitted: false, attempts: 0, settled: false };
  }

  tmux.sendKey(target, submitKey);
  let attempts = 1;

  const result = (submitted: boolean): SubmitResult =>
    settled === undefined ? { submitted, attempts } : { submitted, attempts, settled };

  if (!opts.isSubmitted) {
    return result(true);
  }

  for (let retry = 0; retry <= maxRetries; retry++) {
    await sleep(retryIntervalMs);
    if (await opts.isSubmitted()) {
      return result(true);
    }
    if (retry < maxRetries) {
      tmux.sendKey(target, submitKey);
      attempts++;
    }
  }

  return result(false);
}
