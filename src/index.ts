/**
 * @hasna/dispatch — programmatic root exports.
 *
 * Dispatch prompts to coding agents running in tmux windows, locally and across
 * machines, with reliable auto-submit, long-prompt support, delivery
 * confirmation, scheduled dispatches, and a live daemon.
 */
export * from "./types.js";
export { DispatchClient, dispatch, dispatchExec, dispatchKey, dispatchCapture, dispatchBulk } from "./sdk/index.js";
export type { DispatchClientOptions } from "./sdk/index.js";

// Building blocks (advanced / programmatic use).
export { performDispatch, chooseMode, applyGoalPrefix, PASTE_LENGTH_THRESHOLD } from "./lib/engine.js";
export { performExec, buildExecPlan } from "./lib/exec.js";
export { performKeyDispatch, normalizeSpecialKey, ALLOWED_SPECIAL_KEYS } from "./lib/key.js";
export {
  performCapture,
  normalizeCaptureLines,
  stripTerminalControl,
  redactSecrets,
  buildAiTransformPrompt,
  DEFAULT_CAPTURE_LINES,
  MAX_CAPTURE_LINES,
} from "./lib/capture.js";
export { performBulkDispatch } from "./lib/bulk.js";
export { parseSessionsTargets, resolveSessionsTargets } from "./lib/sessions-source.js";
export {
  classifyPaneCommand,
  detectAgentActivity,
  detectAgentKindFromCommand,
  detectAgentKindFromProcessTree,
  detectAgentKindFromText,
  detectAgentTargetFromSignals,
  evaluateExecPolicy,
  hashCommand,
  loadExecPolicy,
} from "./lib/exec-policy.js";
export { inspectAgentTarget, validateAgentComposerTarget } from "./lib/agent-target.js";
export { computeSubmitDelay, countWords } from "./lib/delay.js";
export {
  evaluateDelivery,
  confirmDelivery,
  detectWorking,
  detectQueued,
  detectActionNeeded,
  DEFAULT_WORKING_PATTERNS,
  DEFAULT_QUEUED_PATTERNS,
  DEFAULT_ACTION_NEEDED_PATTERNS,
} from "./lib/confirm.js";
export { computeNextRun, parseCron, nextCronRun } from "./lib/schedule.js";
export { tick } from "./lib/scheduler.js";
export type { SchedulerDeps, TickResult } from "./lib/scheduler.js";
export { Tmux, parseTarget, formatTarget } from "./lib/tmux.js";
export { Store } from "./lib/store.js";
export { createRunner, LocalRunner, RemoteRunner } from "./lib/runner.js";
export { getPackageVersion } from "./lib/version.js";
