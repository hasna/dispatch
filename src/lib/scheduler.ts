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
  /** Optional sink for errors (a dispatch failing should not stop the tick). */
  onError?: (schedule: ScheduledDispatch, error: unknown) => void;
}

export interface TickResult {
  fired: ScheduledDispatch[];
}

/**
 * Fire every due schedule once: run its dispatch, then advance it — a one-shot
 * `at` becomes `fired`; a `cron` reschedules to its next run and stays
 * `scheduled`. A failing dispatch is recorded but still advances the schedule
 * so the tick never spins on a broken entry. All state is persisted, so the
 * queue survives a daemon restart.
 */
export async function tick(deps: SchedulerDeps): Promise<TickResult> {
  const now = deps.now ?? (() => new Date());
  const current = now();
  const due = deps.store.dueSchedules(current.getTime());
  const fired: ScheduledDispatch[] = [];

  for (const sched of due) {
    let lastDispatchId: string | undefined;
    try {
      const rec = await deps.dispatch(sched.options);
      lastDispatchId = rec?.id;
    } catch (err) {
      deps.onError?.(sched, err);
    }

    const firedAt = nowIso();
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

  return { fired };
}
