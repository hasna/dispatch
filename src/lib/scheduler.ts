import type { DispatchOptions, DispatchRecord, ScheduledDispatch } from "../types.js";
import type { Store } from "./store.js";
import { computeNextRun } from "./schedule.js";
import { nowIso } from "./ids.js";

export interface SchedulerDeps {
  store: Store;
  /** Performs an actual dispatch (usually DispatchClient.send). */
  dispatch: (options: DispatchOptions) => Promise<DispatchRecord>;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Delay before retrying a failed one-shot schedule. Default 60s. */
  retryDelayMs?: number;
  /** Optional sink for errors (a dispatch failing should not stop the tick). */
  onError?: (schedule: ScheduledDispatch, error: unknown) => void;
}

export interface TickResult {
  fired: ScheduledDispatch[];
  failed: ScheduledDispatch[];
}

/**
 * Fire every due schedule once: run its dispatch, then advance it — a one-shot
 * `at` becomes `fired`; a `cron` reschedules to its next run and stays
 * `scheduled`. A failed one-shot is kept scheduled and moved to a retry time so
 * it is not permanently consumed by a transient tmux/ssh failure and does not
 * spin in the current tick loop. All state is persisted, so the queue survives a
 * daemon restart.
 */
export async function tick(deps: SchedulerDeps): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const current = now();
  const retryDelayMs = deps.retryDelayMs ?? 60_000;
  const due = deps.store.dueSchedules(current.getTime());
  const fired: ScheduledDispatch[] = [];
  const failed: ScheduledDispatch[] = [];

  for (const sched of due) {
    let lastDispatchId: string | undefined;
    let failedDispatch = false;
    try {
      const rec = await deps.dispatch(sched.options);
      lastDispatchId = rec?.id;
      if (rec?.status === "failed") {
        failedDispatch = true;
        deps.onError?.(sched, new Error(rec.detail ?? `dispatch ${rec.id} failed`));
      }
    } catch (err) {
      failedDispatch = true;
      deps.onError?.(sched, err);
    }

    const firedAt = nowIso();
    if (failedDispatch) {
      const nextRun = sched.cron
        ? computeNextRun({ cron: sched.cron }, now())
        : new Date(current.getTime() + retryDelayMs).toISOString();
      const updated = deps.store.updateSchedule(sched.id, {
        status: "scheduled",
        nextRun,
        lastDispatchId,
        lastFiredAt: firedAt,
      });
      failed.push(updated);
      continue;
    }

    if (sched.cron) {
      // Reschedule for the next cron occurrence after now.
      const nextRun = computeNextRun({ cron: sched.cron }, now());
      const updated = deps.store.updateSchedule(sched.id, {
        status: "scheduled",
        nextRun,
        lastDispatchId,
        lastFiredAt: firedAt,
      });
      fired.push(updated);
    } else {
      const updated = deps.store.updateSchedule(sched.id, {
        status: "fired",
        lastDispatchId,
        lastFiredAt: firedAt,
      });
      fired.push(updated);
    }
  }

  return { fired, failed };
}
