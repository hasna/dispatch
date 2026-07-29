import { z } from "zod";

/**
 * Response contract for the `/v1` Dispatch authority.
 *
 * Each schema requires exactly the fields its TypeScript return type declares as
 * required — no more, no less. An authority may add fields, but it may not omit
 * one this client hands to callers, because `as T` would otherwise turn an
 * unrecognized 200 into a fabricated success: `dispatch send --json` printing
 * `{}` and exiting 0 for a prompt whose delivery is entirely unknown.
 *
 * Validation is a gate, not a transform. `api-client.ts` returns the authority's
 * original value after a schema passes, so fields this client does not model
 * still reach `--json` output untouched.
 *
 * docs/api-v1.md renders these shapes for authority implementers; keep the two
 * in step when an endpoint's payload changes.
 */

const dispatchStatusSchema = z.enum(["pending", "sending", "delivered", "failed", "scheduled", "cancelled", "skipped"]);
const scheduleStatusSchema = z.enum(["scheduled", "paused", "fired", "cancelled", "failed"]);
const captureStatusSchema = z.enum(["captured", "failed"]);

const agentRecoveryActionSchema = z.object({
  kind: z.enum(["send", "queue", "refuse"]),
  safeToApply: z.boolean(),
  reason: z.string(),
});

/** `DispatchRecord` — the receipt for send/exec/key/status. */
export const dispatchRecordSchema = z.object({
  id: z.string(),
  target: z.string(),
  machine: z.string(),
  prompt: z.string(),
  status: dispatchStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `ScheduledDispatch` — a persisted schedule or loop. */
export const scheduledDispatchSchema = z.object({
  id: z.string(),
  options: z.object({ target: z.string(), prompt: z.string() }),
  nextRun: z.string(),
  status: scheduleStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `BulkDispatchResult` — the fan-out receipt for multi-target sends. */
export const bulkDispatchResultSchema = z.object({
  status: z.enum(["completed", "failed"]),
  source: z.enum(["explicit", "sessions-query"]),
  requested: z.number(),
  planned: z.number(),
  delivered: z.number(),
  skipped: z.number(),
  failed: z.number(),
  dryRun: z.boolean(),
  maxConcurrency: z.number(),
  jitterMs: z.number(),
  perMachineLimit: z.number(),
  records: z.array(dispatchRecordSchema),
});

/** `CaptureResult` — a bounded, redacted pane transcript. */
export const captureResultSchema = z.object({
  status: captureStatusSchema,
  target: z.string(),
  machine: z.string(),
  requestedLines: z.number(),
  lines: z.number(),
  maxLines: z.number(),
  capturedAt: z.string(),
  text: z.string(),
  redacted: z.boolean(),
});

const triageCaptureSchema = z.object({
  status: captureStatusSchema,
  requestedLines: z.number(),
  lines: z.number(),
  maxLines: z.number(),
  maxChars: z.number(),
  textLength: z.number(),
  truncatedChars: z.boolean(),
  redacted: z.boolean(),
  excerptChars: z.number(),
});

/** `AgentTriageResult` — schema-versioned agent state read. */
export const agentTriageResultSchema = z.object({
  schemaVersion: z.literal("dispatch.agentTriage.v1"),
  status: z.enum(["ok", "blocked", "failed"]),
  target: z.string(),
  machine: z.string(),
  generatedAt: z.string(),
  action: agentRecoveryActionSchema,
  capture: triageCaptureSchema,
});

/** `AgentRecoverResult` — schema-versioned guarded recovery plan or outcome. */
export const agentRecoverResultSchema = z.object({
  schemaVersion: z.literal("dispatch.agentRecover.v1"),
  status: z.enum(["planned", "applied", "refused", "failed"]),
  target: z.string(),
  machine: z.string(),
  dryRun: z.boolean(),
  generatedAt: z.string(),
  promptPreview: z.string(),
  promptLength: z.number(),
  triage: agentTriageResultSchema,
  action: agentRecoveryActionSchema,
});

const fleetSummaryItemSchema = z.object({
  backend: z.literal("tmux"),
  target: z.string(),
  machine: z.string(),
  window: z.string(),
  active: z.boolean(),
  classification: z.object({
    state: z.enum(["working", "idle", "stuck", "error", "blocked"]),
    uncertainty: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string()),
  }),
  excerpt: z.string(),
  excerptChars: z.number(),
  excerptTruncated: z.boolean(),
});

/**
 * `FleetSummaryResult`. `totals` is a state→count map rather than a fixed key
 * set, because a summary legitimately omits states it observed zero of.
 */
export const fleetSummaryResultSchema = z.object({
  schemaVersion: z.literal("dispatch.fleet_summary.v1"),
  status: z.enum(["completed", "failed"]),
  machine: z.string(),
  generatedAt: z.string(),
  targetGlobs: z.array(z.string()),
  limit: z.number(),
  maxLimit: z.number(),
  requestedMaxPaneChars: z.number(),
  maxPaneChars: z.number(),
  maxAllowedPaneChars: z.number(),
  totalTargets: z.number(),
  matchedTargets: z.number(),
  inspectedTargets: z.number(),
  omittedTargets: z.number(),
  totals: z.record(z.string(), z.number()),
  items: z.array(fleetSummaryItemSchema),
  compact: z.literal(true),
});

/**
 * A `targets` row. The endpoint's declared return type is `unknown[]`, so only
 * the address the CLI renders is contractual — without it the row would print as
 * the literal string "unknown".
 */
export const dispatchTargetRowSchema = z.object({ target: z.string() });

const daemonQueueItemSchema = z.object({
  id: z.string(),
  status: z.string(),
  target: z.string(),
  nextRun: z.string(),
});

/** `DaemonStatus` — remote daemon + queue health. */
export const daemonStatusSchema = z.object({
  running: z.boolean(),
  stale: z.boolean(),
  health: z.enum(["alive", "stale", "dead"]),
  scheduled: z.number(),
  paused: z.number(),
  fired: z.number(),
  cancelled: z.number(),
  failed: z.number(),
  recentDispatches: z.number(),
  heartbeatStaleMs: z.number(),
  recentFailures: z.array(daemonQueueItemSchema),
  logPath: z.string(),
  pidPath: z.string(),
  statePath: z.string(),
});

/** `StartDaemonResult`. */
export const startDaemonResultSchema = z.object({ started: z.boolean(), alreadyRunning: z.boolean() });

/** `StopDaemonResult`. */
export const stopDaemonResultSchema = z.object({ stopped: z.boolean(), forced: z.boolean(), wasRunning: z.boolean() });

/** `DispatchDaemonEnsureResult`. */
export const daemonEnsureResultSchema = z.object({ ok: z.boolean(), started: z.boolean(), alreadyRunning: z.boolean() });

/** The `daemon/restart` envelope: both halves are objects the CLI dereferences. */
export const daemonRestartResultSchema = z.object({
  ok: z.boolean(),
  stopped: stopDaemonResultSchema,
  started: startDaemonResultSchema,
});

/** `DispatchDaemonDoctorResult`. */
export const daemonDoctorResultSchema = z.object({
  ok: z.boolean(),
  status: daemonStatusSchema,
  findings: z.array(z.string()),
});

/** `ServiceResult` — user-service action outcome. */
export const daemonServiceResultSchema = z.object({
  ok: z.boolean(),
  action: z.enum(["install", "start", "stop", "restart", "status", "uninstall"]),
  detail: z.string(),
});
