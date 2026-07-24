import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type {
  AgentRecoverOptions,
  AgentRecoverResult,
  AgentRecoveryAction,
  AgentRecoveryDispatchSummary,
  AgentTriageOptions,
  AgentTriageResult,
  DispatchOptions,
} from "../types.js";
import type { Store } from "./store.js";
import {
  inspectAgentTarget,
  TARGET_DISCOVERY_CAPTURE_MAX_CHARS,
  TARGET_DISCOVERY_PROCESS_MAX_LINE_CHARS,
  TARGET_DISCOVERY_PROCESS_MAX_LINES,
} from "./agent-target.js";
import { DEFAULT_CAPTURE_LINES, MAX_CAPTURE_CHARS, MAX_CAPTURE_LINES, normalizeCaptureLines, performCapture, redactSecrets } from "./capture.js";
import { applyGoalPrefix, performDispatch } from "./engine.js";
import { nowIso } from "./ids.js";
import { artifactsDir } from "./paths.js";
import { Tmux } from "./tmux.js";

export const AGENT_TRIAGE_SCHEMA_VERSION = "dispatch.agentTriage.v1";
export const AGENT_RECOVER_SCHEMA_VERSION = "dispatch.agentRecover.v1";
export const DEFAULT_TRIAGE_EXCERPT_CHARS = 1200;
export const MAX_TRIAGE_EXCERPT_CHARS = 4000;

export interface AgentRecoveryDeps {
  tmux: Tmux;
  store?: Store;
  sleep?: (ms: number) => Promise<void>;
}

export function normalizeTriageExcerptChars(chars: number | undefined): { requested: number; effective: number } {
  const requested = Number.isFinite(chars) ? Math.trunc(chars as number) : DEFAULT_TRIAGE_EXCERPT_CHARS;
  const positive = Math.max(0, requested);
  return { requested, effective: Math.min(positive, MAX_TRIAGE_EXCERPT_CHARS) };
}

function tailChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function lineCount(text: string): number {
  if (!text) return 0;
  const parts = text.split("\n");
  return parts.at(-1) === "" ? parts.length - 1 : parts.length;
}

function promptPreview(prompt: string): string {
  const normalized = redactSecrets(prompt).replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119)}...`;
}

function resolveArtifactPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("artifact path must be a non-empty relative path");
  if (isAbsolute(trimmed)) throw new Error("artifact path must be relative to the dispatch artifacts directory");
  const normalized = normalize(trimmed);
  if (normalized === "." || normalized.startsWith("..") || normalized.split(/[\\/]+/).includes("..")) {
    throw new Error("artifact path must not contain parent-directory segments");
  }
  const root = resolve(artifactsDir());
  const fullPath = resolve(root, normalized);
  if (fullPath !== root && fullPath.startsWith(`${root}${sep}`)) return fullPath;
  throw new Error("artifact path escapes the dispatch artifacts directory");
}

function ensureSafeArtifactParent(root: string, fullPath: string): void {
  mkdirSync(root, { recursive: true });
  const parent = dirname(fullPath);
  const relParent = relative(root, parent);
  if (!relParent) return;
  let current = root;
  for (const segment of relParent.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`artifact parent path contains a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`artifact parent path is not a directory: ${current}`);
  }
}

function writeArtifact(path: string, text: string): { path: string; bytes: number; lines: number; redacted: true } {
  const safePath = resolveArtifactPath(path);
  const root = resolve(artifactsDir());
  ensureSafeArtifactParent(root, safePath);
  if (existsSync(safePath) && lstatSync(safePath).isSymbolicLink()) {
    throw new Error(`artifact path is a symlink: ${safePath}`);
  }
  const fd = openSync(
    safePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    writeFileSync(fd, text, "utf8");
  } finally {
    closeSync(fd);
  }
  return {
    path: safePath,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: lineCount(text),
    redacted: true,
  };
}

export function recommendRecoveryAction(
  detection: AgentTriageResult["detection"],
  opts: { queue?: boolean } = {},
): AgentRecoveryAction {
  if (!detection || detection.targetKind !== "agent" || detection.agentKind === "unknown") {
    return {
      kind: "refuse",
      safeToApply: false,
      reason: detection?.reason ?? "target is not a recognized agent composer",
    };
  }
  if (detection.canReceivePrompt) {
    return {
      kind: "send",
      submitKey: "Enter",
      safeToApply: true,
      reason: "idle agent composer can receive an Enter recovery prompt",
    };
  }
  if (opts.queue !== false && detection.canQueuePrompt) {
    return {
      kind: "queue",
      submitKey: "Tab",
      safeToApply: true,
      reason: "active agent composer advertises queued Tab prompt support",
    };
  }
  return {
    kind: "refuse",
    safeToApply: false,
    reason: detection.canQueuePrompt
      ? "target is active; pass queue=true to allow queued Tab recovery"
      : detection.reason,
  };
}

/** Classify a tmux target and capture a bounded redacted excerpt for agent recovery decisions. */
export async function performAgentTriage(options: AgentTriageOptions, deps: AgentRecoveryDeps): Promise<AgentTriageResult> {
  const { tmux } = deps;
  const machine = tmux.machine;
  const { requested: requestedLines, effective: effectiveLines } = normalizeCaptureLines(options.lines ?? DEFAULT_CAPTURE_LINES);
  const { requested: requestedExcerpt, effective: excerptChars } = normalizeTriageExcerptChars(options.excerptChars);

  const inspected = inspectAgentTarget(tmux, options.target, {
    maxCaptureChars: TARGET_DISCOVERY_CAPTURE_MAX_CHARS,
    maxProcessTreeLines: TARGET_DISCOVERY_PROCESS_MAX_LINES,
    maxProcessTreeLineChars: TARGET_DISCOVERY_PROCESS_MAX_LINE_CHARS,
  });
  const capture = await performCapture({ target: options.target, lines: effectiveLines }, { tmux });
  const detection = capture.detection ?? inspected.detection;
  const action = recommendRecoveryAction(detection, { queue: options.queue });
  const text = capture.status === "captured" ? capture.text : "";
  let artifact: AgentTriageResult["capture"]["artifact"] | undefined;
  let artifactError: string | undefined;
  if (options.artifactPath && capture.status === "captured") {
    try {
      artifact = writeArtifact(options.artifactPath, text);
    } catch (err) {
      artifactError = `artifact write failed: ${(err as Error).message}`;
    }
  }
  const failed = capture.status === "failed" || artifactError !== undefined;
  const status = failed ? "failed" : action.safeToApply ? "ok" : "blocked";

  return {
    schemaVersion: AGENT_TRIAGE_SCHEMA_VERSION,
    status,
    target: options.target,
    machine,
    generatedAt: nowIso(),
    detection,
    action,
    capture: {
      status: capture.status,
      requestedLines,
      lines: capture.status === "captured" ? capture.lines : 0,
      maxLines: MAX_CAPTURE_LINES,
      maxChars: capture.maxChars ?? MAX_CAPTURE_CHARS,
      textLength: text.length,
      truncatedChars: capture.truncatedChars === true,
      redacted: capture.redacted,
      excerpt: options.includeExcerpt === false ? undefined : tailChars(text, excerptChars),
      excerptChars: requestedExcerpt,
      artifact,
      artifactError,
      detail: capture.detail,
    },
    detail: artifactError ?? (capture.status === "failed" ? capture.detail : inspected.detail),
  };
}

function summarizeDispatch(record: AgentRecoveryDispatchSummary): AgentRecoveryDispatchSummary {
  return {
    id: record.id,
    status: record.status,
    detail: record.detail,
    targetState: record.targetState,
    deliveredAt: record.deliveredAt,
  };
}

function dispatchOptionsForRecovery(options: AgentRecoverOptions, action: AgentRecoveryAction, dryRun: boolean): DispatchOptions {
  return {
    target: options.target,
    machine: options.machine,
    prompt: options.prompt,
    promptFile: options.promptFile,
    goal: options.goal,
    submitKey: action.submitKey,
    ifIdle: action.kind === "send",
    queue: action.kind === "queue",
    forceActive: false,
    dryRun,
    captureBeforeLines: options.lines,
    submit: true,
    confirm: options.confirm,
    submitDelayMs: options.submitDelayMs,
    maxSubmitRetries: options.maxSubmitRetries,
    mode: options.mode,
  };
}

/** Plan or apply a guarded recovery prompt through the existing dispatch send path. */
export async function performAgentRecovery(options: AgentRecoverOptions, deps: AgentRecoveryDeps): Promise<AgentRecoverResult> {
  if (options.prompt.trim().length === 0) {
    throw new Error("recovery prompt is empty");
  }

  const triage = await performAgentTriage(options, deps);
  const action = triage.action;
  const dryRun = options.apply !== true;
  const base = {
    schemaVersion: AGENT_RECOVER_SCHEMA_VERSION,
    target: options.target,
    machine: triage.machine,
    dryRun,
    generatedAt: nowIso(),
    promptPreview: promptPreview(applyGoalPrefix(options.prompt, options.goal === true)),
    promptLength: applyGoalPrefix(options.prompt, options.goal === true).length,
    triage,
    action,
  } satisfies Omit<AgentRecoverResult, "status">;

  if (!action.safeToApply) {
    return {
      ...base,
      status: "refused",
      detail: action.reason,
    };
  }

  if (dryRun) {
    const record = await performDispatch(dispatchOptionsForRecovery(options, action, true), deps);
    const plannedDryRun = record.status === "skipped" && record.dryRun === true && /^dry run:/i.test(record.detail ?? "");
    return {
      ...base,
      status: plannedDryRun ? "planned" : record.status === "failed" ? "failed" : "refused",
      dispatch: summarizeDispatch(record),
      detail: record.detail,
    };
  }

  const record = await performDispatch(dispatchOptionsForRecovery(options, action, false), deps);
  return {
    ...base,
    dryRun: false,
    status: record.status === "delivered" ? "applied" : "failed",
    dispatch: summarizeDispatch(record),
    detail: record.detail,
  };
}
