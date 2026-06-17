/**
 * Core types for @hasna/dispatch.
 */

/** Lifecycle status of a dispatch. */
export type DispatchStatus =
  | "pending"
  | "sending"
  | "delivered"
  | "failed"
  | "scheduled"
  | "cancelled";

/**
 * A parsed tmux target: session, optional window, optional pane.
 * Rendered back to tmux as `session[:window[.pane]]`.
 */
export interface TmuxTarget {
  session: string;
  window?: string;
  pane?: string;
}

/** Outcome of a delivery-confirmation check against a pane. */
export interface ConfirmResult {
  /** True when we observed evidence the prompt was submitted/registered. */
  delivered: boolean;
  /** Human-readable explanation of the verdict. */
  reason: string;
  /** Whether the composer appeared to clear after submit. */
  composerCleared?: boolean;
  /** Whether a working/processing indicator appeared after submit. */
  workingDetected?: boolean;
}

/** Options controlling a single dispatch. */
export interface DispatchOptions {
  /** Target tmux address, e.g. "session:window" or "session:window.pane". */
  target: string;
  /** The prompt text to deliver. */
  prompt: string;
  /** Optional machine id (local when omitted). Resolved via @hasna/machines. */
  machine?: string;
  /**
   * Override the auto-calculated pre-Enter delay (ms). When omitted, the delay
   * is derived from the prompt's word/char count.
   */
  submitDelayMs?: number;
  /** Press Enter to submit after typing. Default true. */
  submit?: boolean;
  /** Verify delivery after submit. Default true. */
  confirm?: boolean;
  /** Max Enter retries if the first submit did not register. Default 2. */
  maxSubmitRetries?: number;
  /**
   * How to send the text. "auto" picks paste for long/multiline prompts and
   * literal send-keys for short single-line ones.
   */
  mode?: "auto" | "paste" | "literal";
}

/** A persisted dispatch record. */
export interface DispatchRecord {
  id: string;
  target: string;
  machine: string;
  prompt: string;
  status: DispatchStatus;
  /** Reason / detail for the current status. */
  detail?: string;
  /** Confirmation result, when a confirmation pass ran. */
  confirm?: ConfirmResult;
  /** Computed submit delay used (ms). */
  submitDelayMs?: number;
  createdAt: string;
  deliveredAt?: string;
  updatedAt: string;
}

/** A scheduled dispatch (fires later, once or on a cron). */
export interface ScheduledDispatch {
  id: string;
  options: DispatchOptions;
  /** One-shot fire time (ISO 8601). Mutually used with `cron`. */
  at?: string;
  /** Recurring cron expression (5-field). */
  cron?: string;
  /** Next computed fire time (ISO 8601). */
  nextRun: string;
  status: "scheduled" | "fired" | "cancelled";
  /** Id of the last dispatch this schedule produced. */
  lastDispatchId?: string;
  lastFiredAt?: string;
  createdAt: string;
  updatedAt: string;
}
