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
  | "cancelled"
  | "skipped";

/** What kind of payload a dispatch record represents. */
export type DispatchKind = "prompt" | "exec" | "key";

/** Terminal control backend. tmux remains the default. */
export type DispatchBackend = "tmux" | "mosaic";

/** Runtime class of a target pane, based on tmux pane_current_command. */
export type ExecTargetKind = "shell" | "agent" | "unknown";

/** Specific terminal AI agent family detected in a tmux pane. */
export type AgentKind = "codewith" | "codex" | "claude" | "opencode" | "unknown";

/** Visible composer/activity state inferred from the live pane viewport. */
export type ComposerState = "idle" | "active" | "unknown";

/** Prompt submit key supported by send-level delivery. */
export type SubmitKey = "Enter" | "Tab";

/** Structured target detection/capability record exposed in JSON outputs. */
export interface AgentTargetInfo {
  targetKind: ExecTargetKind;
  agentKind: AgentKind;
  composerState: ComposerState;
  canReceivePrompt: boolean;
  canQueuePrompt: boolean;
  submitKeys: SubmitKey[];
  recommendedSubmitKey?: SubmitKey;
  reason: string;
  paneCommand?: string;
  cwd?: string;
}

/** Command filter result recorded before any exec delivery is attempted. */
export interface ExecFilterResult {
  allowed: boolean;
  code: string;
  reason: string;
  commandHash: string;
  normalizedCommand: string;
  targetKind: ExecTargetKind;
  matchedRule?: string;
}

/** Policy additions for exec command allowlists and sensitive operations. */
export interface ExecPolicy {
  /** Command prefixes allowed in addition to the built-in safe prefixes. */
  allowPrefixes?: string[];
  /** Optional target allowlist. Supports `*` wildcards. */
  allowTargets?: string[];
  /** Paths where `git reset --hard` is explicitly permitted. Supports `*`. */
  allowGitResetHardPaths?: string[];
}

/** The exact tmux input plan for a command exec. */
export interface ExecDeliveryPlan {
  interrupt: boolean;
  pasteText: string;
  submitKey: "Enter";
}

/** Options controlling a single shell command exec. */
export interface ExecOptions {
  /** Target tmux address, e.g. "session:window" or "session:window.pane". */
  target: string;
  /** Single-line shell command to submit. */
  command: string;
  /** Optional machine id (local when omitted). Resolved via @hasna/machines. */
  machine?: string;
  /** Validate and record the exact delivery plan without typing anything. */
  dryRun?: boolean;
  /** Send C-c before the command. Off by default and never inferred. */
  forceInterrupt?: boolean;
  /** Additional allow policy, usually loaded from `dispatch exec --allow`. */
  policy?: ExecPolicy;
}

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
  /**
   * True when the prompt was accepted but staged for later submission (the
   * target agent was busy, e.g. "Messages to be submitted after next tool
   * call"). Usually counts as delivered unless actionNeeded is also true.
   */
  queued?: boolean;
  /**
   * True when the prompt reached a state that requires human/operator action
   * before it can be trusted as submitted, for example a Codewith auth-profile
   * auto-switch that leaves follow-up input queued but not draining.
   */
  actionNeeded?: boolean;
  /** True when actionNeeded was caused by an auth/account switch or limit state. */
  authSwitchDetected?: boolean;
  /**
   * True when the target app handled the prompt by rendering an immediate
   * rejection/disabled/unavailable message. Still counts as delivered because
   * the prompt reached the app and should not be retried.
   */
  handledOutput?: boolean;
}

/** Options controlling a single dispatch. */
export interface DispatchOptions {
  /** Target tmux address, e.g. "session:window" or "session:window.pane". */
  target: string;
  /** Backend to use. Defaults to DISPATCH_BACKEND or tmux. */
  backend?: DispatchBackend;
  /** The prompt text to deliver. */
  prompt: string;
  /** Optional original prompt file path; Mosaic can send files natively. */
  promptFile?: string;
  /**
   * Prefix the delivered prompt with `/goal ` unless it already starts with
   * `/goal`. Useful for making Codewith create a durable goal from the prompt.
   */
  goal?: boolean;
  /** Optional machine id (local when omitted). Resolved via @hasna/machines. */
  machine?: string;
  /** Submit key for prompt sends. Enter is default; Tab is only for proven queue support. */
  submitKey?: SubmitKey;
  /** Refuse delivery unless the target looks idle. */
  ifIdle?: boolean;
  /** Queue on active agents that prove Tab queued-message support. */
  queue?: boolean;
  /** Explicit override for active/unknown target state. Use sparingly. */
  forceActive?: boolean;
  /** Validate target, guards, and delivery plan without sending text or Enter. */
  dryRun?: boolean;
  /** Capture this many redacted lines before delivery and attach them to the record. */
  captureBeforeLines?: number;
  /**
   * Override the auto-calculated pre-Enter delay (ms). When omitted, the delay
   * is derived from the prompt's word/char count.
   */
  submitDelayMs?: number;
  /** Press Enter to submit after typing. Default true. */
  submit?: boolean;
  /** Verify delivery after submit. Default true. */
  confirm?: boolean;
  /** Max Enter retries if the first submit did not register. Default derives from DISPATCH_SUBMIT_TIMEOUT_MS. */
  maxSubmitRetries?: number;
  /**
   * How to send the text. "auto" picks paste for long/multiline prompts and
   * literal send-keys for short single-line ones.
   */
  mode?: "auto" | "paste" | "literal";
}

export type AgentActivityState = ComposerState;

export interface DispatchTargetRef {
  target: string;
  machine?: string;
  source?: string;
  state?: AgentActivityState;
}

export type DispatchTargetSource = "explicit" | "sessions-query";

export interface BulkDispatchOptions extends Omit<DispatchOptions, "target" | "machine"> {
  targets?: DispatchTargetRef[];
  /** Fixed target source. `sessions-query` probes `sessions live/status --json` when available. */
  source?: DispatchTargetSource;
  /** Machine on which to resolve a target source such as sessions-query. */
  machine?: string;
  /** Optional text filter for sessions-query target results. */
  sessionsQuery?: string;
  /** Max concurrent dispatches. Default 1. */
  maxConcurrency?: number;
  /** Sleep up to this many ms before each dispatch. Default 0. */
  jitterMs?: number;
  /** Max concurrent dispatches per machine. Default equals maxConcurrency. */
  perMachineLimit?: number;
}

export interface BulkDispatchResult {
  status: "completed" | "failed";
  source: DispatchTargetSource;
  requested: number;
  planned: number;
  delivered: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  maxConcurrency: number;
  jitterMs: number;
  perMachineLimit: number;
  records: DispatchRecord[];
  detail?: string;
}

/** Options controlling a single allowlisted special-key dispatch. */
export interface KeyOptions {
  /** Target tmux address, e.g. "session:window" or "session:window.pane". */
  target: string;
  /** Named key to send, e.g. Enter or Tab. Must be in the built-in allowlist. */
  key: string;
  /** Optional machine id (local when omitted). Resolved via @hasna/machines. */
  machine?: string;
}

/** Safe special keys accepted by dispatch key. */
export type AllowedSpecialKey =
  | "Enter"
  | "Tab"
  | "Escape"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Backspace"
  | "Delete"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";

export type CaptureTransform = "summary" | "blockers" | "changes" | "next-steps";

export type CaptureAiProvider = "groq" | "cerebras" | "openai" | "none";

export interface CaptureAiRequest {
  /** Run an AI transform over the redacted capture. */
  enabled?: boolean;
  /** Provider selection. Defaults to DISPATCH_AI_PROVIDER or detected env keys. */
  provider?: CaptureAiProvider;
  /** Model override. Defaults to DISPATCH_AI_MODEL, provider-specific env, or a provider default. */
  model?: string;
  /** Built-in transform prompt. */
  transform?: CaptureTransform;
  /** Custom transform instruction. */
  prompt?: string;
}

export interface CaptureAiResult {
  status: "completed" | "skipped" | "failed";
  provider: CaptureAiProvider;
  model?: string;
  transform?: CaptureTransform;
  prompt?: string;
  text?: string;
  detail?: string;
}

/** Options for capturing recent target pane output. */
export interface CaptureOptions {
  target: string;
  /** Backend to use. Defaults to DISPATCH_BACKEND or tmux. */
  backend?: DispatchBackend;
  machine?: string;
  /** Requested recent line count. Defaults and maximum are enforced by the library. */
  lines?: number;
  ai?: CaptureAiRequest;
}

/** Result of a bounded pane transcript capture. */
export interface CaptureResult {
  status: "captured" | "failed";
  backend?: DispatchBackend;
  target: string;
  machine: string;
  requestedLines: number;
  lines: number;
  maxLines: number;
  maxChars?: number;
  truncatedChars?: boolean;
  capturedAt: string;
  text: string;
  redacted: boolean;
  detection?: AgentTargetInfo;
  detail?: string;
  ai?: CaptureAiResult;
}

export type AgentRecoveryActionKind = "send" | "queue" | "refuse";

export interface AgentRecoveryAction {
  kind: AgentRecoveryActionKind;
  submitKey?: SubmitKey;
  safeToApply: boolean;
  reason: string;
}

export interface AgentTriageOptions {
  target: string;
  machine?: string;
  /** Bounded recent transcript lines to inspect and optionally archive. */
  lines?: number;
  /** Max redacted transcript chars included directly in the result. */
  excerptChars?: number;
  /** Omit the bounded excerpt from compact output. */
  includeExcerpt?: boolean;
  /** Optional relative path under the dispatch artifacts directory for the full bounded redacted capture. */
  artifactPath?: string;
  /** Whether active queue-capable agents may be recommended for Tab queue recovery. */
  queue?: boolean;
}

export interface AgentCaptureArtifact {
  path: string;
  bytes: number;
  lines: number;
  redacted: true;
}

export interface AgentTriageResult {
  schemaVersion: "dispatch.agentTriage.v1";
  status: "ok" | "blocked" | "failed";
  target: string;
  machine: string;
  generatedAt: string;
  detection?: AgentTargetInfo;
  action: AgentRecoveryAction;
  capture: {
    status: CaptureResult["status"];
    requestedLines: number;
    lines: number;
    maxLines: number;
    maxChars: number;
    textLength: number;
    truncatedChars: boolean;
    redacted: boolean;
    excerpt?: string;
    excerptChars: number;
    artifact?: AgentCaptureArtifact;
    artifactError?: string;
    detail?: string;
  };
  detail?: string;
}

export interface AgentRecoverOptions extends AgentTriageOptions {
  prompt: string;
  promptFile?: string;
  goal?: boolean;
  /** Apply the guarded recovery. Defaults to false, returning only a dry-run plan. */
  apply?: boolean;
  confirm?: boolean;
  submitDelayMs?: number;
  maxSubmitRetries?: number;
  mode?: DispatchOptions["mode"];
}

export interface AgentRecoveryDispatchSummary {
  id: string;
  status: DispatchStatus;
  detail?: string;
  targetState?: AgentActivityState;
  deliveredAt?: string;
}

export interface AgentRecoverResult {
  schemaVersion: "dispatch.agentRecover.v1";
  status: "planned" | "applied" | "refused" | "failed";
  target: string;
  machine: string;
  dryRun: boolean;
  generatedAt: string;
  promptPreview: string;
  promptLength: number;
  triage: AgentTriageResult;
  action: AgentRecoveryAction;
  dispatch?: AgentRecoveryDispatchSummary;
  detail?: string;
}

/** Public Mosaic prompt receipt, schema_version mosaic.control.v1. */
export interface MosaicPromptReceipt {
  schema_version?: "mosaic.control.v1" | string;
  event?: "receipt" | string;
  id?: string;
  operation?: string;
  session?: string;
  pane_id?: string;
  status?: string;
  ack?: string;
  timestamp_ms?: number;
  error?: unknown;
}

/** User-facing kind of a persisted scheduled prompt. */
export type ScheduleKind = "schedule" | "loop";

/** Lifecycle status of a scheduled prompt or loop. */
export type ScheduleStatus = "scheduled" | "paused" | "fired" | "cancelled" | "failed";

/** A persisted dispatch record. */
export interface DispatchRecord {
  id: string;
  /** `prompt` for agent prompts, `exec` for shell command records. Defaults to `prompt` for older records. */
  kind?: DispatchKind;
  /** Backend used for this record. Older records default to tmux. */
  backend?: DispatchBackend;
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
  /** Short SHA-256 hash of the command for exec audit logs. */
  commandHash?: string;
  /** Security filter result for exec records. */
  filter?: ExecFilterResult;
  /** Detected target class for exec records. */
  targetKind?: ExecTargetKind;
  /** True when exec only validated and recorded the delivery plan. */
  dryRun?: boolean;
  /** Detected agent activity before prompt delivery. */
  targetState?: AgentActivityState;
  /** Structured target detection/capability metadata before delivery. */
  detection?: AgentTargetInfo;
  /** Optional pre-delivery transcript capture requested by `captureBeforeLines`. */
  captureBefore?: CaptureResult;
  /** Native backend receipt, currently used by Mosaic prompt delivery. */
  receipt?: MosaicPromptReceipt;
  /** Exact tmux input that would be or was sent for exec records. */
  execPlan?: ExecDeliveryPlan;
  createdAt: string;
  deliveredAt?: string;
  updatedAt: string;
}

/** A scheduled dispatch (fires later, once or on a cron). */
export interface ScheduledDispatch {
  id: string;
  options: DispatchOptions;
  /** User-facing kind. `loop` means recurring interval/loop workflow. */
  kind?: ScheduleKind;
  /** Optional human label for list/status output. */
  name?: string;
  /** One-shot fire time (ISO 8601). Mutually used with `cron`. */
  at?: string;
  /** Recurring cron expression (5-field). */
  cron?: string;
  /** Recurring interval duration as provided by the user, e.g. `5m`. */
  every?: string;
  /** Recurring interval duration in milliseconds. */
  intervalMs?: number;
  /** Next computed fire time (ISO 8601). */
  nextRun: string;
  /**
   * `scheduled` — waiting to fire (or retrying). `paused` — stopped until
   * resumed. `fired` — a one-shot completed. `cancelled` — cancelled by a user.
   * `failed` — a one-shot gave up after exhausting its retry window.
   */
  status: ScheduleStatus;
  /** Id of the last dispatch this schedule produced. */
  lastDispatchId?: string;
  lastFiredAt?: string;
  /** Last failed attempt timestamp, if any. Kept as audit metadata. */
  lastFailureAt?: string;
  /** Last failed attempt reason, if any. */
  lastFailureReason?: string;
  /** Number of failed attempts recorded for this schedule/loop. */
  failureCount?: number;
  createdAt: string;
  updatedAt: string;
}
