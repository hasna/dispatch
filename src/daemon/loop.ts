import { realSleep } from "../lib/submit.js";

export interface LoopOptions {
  /** One iteration of work (e.g. a scheduler tick). */
  tickFn: () => Promise<void> | void;
  /** Wait between iterations (ms). */
  intervalMs: number;
  /** Return true to stop the loop (checked before and after each tick). */
  shouldStop: () => boolean;
  /** Injectable sleep (defaults to realSleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Called when a tick throws; the loop keeps running. */
  onTickError?: (error: unknown) => void;
  /**
   * Granularity for the between-tick wait. The wait is split into slices and
   * `shouldStop` is re-checked between them, so the loop reacts to a stop signal
   * within ~sliceMs even when the interval is long. Default 200ms.
   */
  sliceMs?: number;
}

/**
 * The daemon's heart: run `tickFn` on an interval until `shouldStop` is true.
 * A throwing tick is reported but never stops the loop — a transient tmux error
 * must not take the daemon down. The interval wait is sliced so a stop signal is
 * honored promptly regardless of how long the interval is.
 */
export async function runLoop(opts: LoopOptions): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  const sliceMs = opts.sliceMs ?? 200;
  while (!opts.shouldStop()) {
    try {
      await opts.tickFn();
    } catch (err) {
      opts.onTickError?.(err);
    }
    if (opts.shouldStop()) break;
    let waited = 0;
    while (waited < opts.intervalMs && !opts.shouldStop()) {
      const chunk = Math.min(sliceMs, opts.intervalMs - waited);
      await sleep(chunk);
      waited += chunk;
    }
  }
}
