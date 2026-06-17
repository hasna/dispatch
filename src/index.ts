/**
 * @hasna/dispatch — programmatic root exports.
 *
 * Dispatch prompts to coding agents running in tmux windows, locally and across
 * machines, with reliable auto-submit, long-prompt support, delivery
 * confirmation, scheduled dispatches, and a live daemon.
 */
export * from "./types.js";
export { DispatchClient, dispatch } from "./sdk/index.js";
export type { DispatchClientOptions } from "./sdk/index.js";

// Building blocks (advanced / programmatic use).
export { performDispatch, chooseMode, PASTE_LENGTH_THRESHOLD } from "./lib/engine.js";
export { computeSubmitDelay, countWords } from "./lib/delay.js";
export { evaluateDelivery, confirmDelivery, detectWorking, DEFAULT_WORKING_PATTERNS } from "./lib/confirm.js";
export { computeNextRun, parseCron, nextCronRun } from "./lib/schedule.js";
export { Tmux, parseTarget, formatTarget } from "./lib/tmux.js";
export { Store } from "./lib/store.js";
export { createRunner, LocalRunner, RemoteRunner } from "./lib/runner.js";
export { getPackageVersion } from "./lib/version.js";
