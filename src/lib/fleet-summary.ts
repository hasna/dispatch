import type {
  AgentTargetInfo,
  FleetPaneClassification,
  FleetPaneState,
  FleetSummaryItem,
  FleetSummaryOptions,
  FleetSummaryResult,
} from "../types.js";
import {
  inspectAgentTarget,
  TARGET_DISCOVERY_CAPTURE_MAX_CHARS,
  TARGET_DISCOVERY_PROCESS_MAX_LINE_CHARS,
  TARGET_DISCOVERY_PROCESS_MAX_LINES,
} from "./agent-target.js";
import { preflightCaptureAi, redactSecrets, stripTerminalControl } from "./capture.js";
import { detectAgentActivity } from "./exec-policy.js";
import { nowIso } from "./ids.js";
import { parseDurationMs } from "./schedule.js";
import { Tmux } from "./tmux.js";

export const DEFAULT_FLEET_SUMMARY_LIMIT = 50;
export const MAX_FLEET_SUMMARY_LIMIT = 200;
export const DEFAULT_FLEET_MAX_PANE_CHARS = 1200;
export const MAX_FLEET_MAX_PANE_CHARS = 12_000;
export const MIN_FLEET_DETECTION_CHARS = 4_000;
export const DEFAULT_FLEET_CAPTURE_LINES = 160;
export const FLEET_SUMMARY_SCHEMA_VERSION = "dispatch.fleet_summary.v1" as const;

export interface FleetSummaryDeps {
  tmux: Tmux;
  env?: NodeJS.ProcessEnv;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value as number)), max);
}

export function normalizeTargetGlobs(input: string | string[] | undefined): string[] {
  const raw = Array.isArray(input) ? input : [input ?? "*"];
  const globs = raw
    .flatMap((part) => String(part ?? "").split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  return globs.length > 0 ? globs : ["*"];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function targetMatchesGlobs(input: { machine: string; target: string; globs: string[] }): boolean {
  const candidates = [input.target, `${input.machine}/${input.target}`];
  return input.globs.some((glob) => {
    const pattern = globToRegExp(glob);
    return candidates.some((candidate) => pattern.test(candidate));
  });
}

function tailChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(-maxChars), truncated: true };
}

function compactWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function observedActivityAgeMs(text: string): number | undefined {
  const normalized = compactWhitespace(text);
  const matches = [...normalized.matchAll(/\b(?:Pursuing goal|Working|Goal active|Goal achieved|Goal blocked|Goal failed|Goal cancelled)\b[^\n()]*\((\d+(?:\.\d+)?\s*[a-z]+)\)/gi)];
  const raw = matches.at(-1)?.[1];
  if (!raw) return undefined;
  try {
    return parseDurationMs(raw);
  } catch {
    return undefined;
  }
}

function hasAny(patterns: RegExp[], text: string): string | undefined {
  return patterns.find((pattern) => pattern.test(text))?.source;
}

const ERROR_PATTERNS = [
  /\b(?:traceback|uncaught exception|unhandled rejection|segmentation fault|panic:|fatal:|npm ERR!|cannot find module|out of memory|allocation failed|ENOMEM)\b/i,
  /\b(?:Goal failed|command failed|build failed|tests failed)\b/i,
];

const BLOCKED_PATTERNS = [
  /\b(?:Goal blocked|blocked|waiting for (?:user|approval|input)|approval required|requires approval|permission denied)\b/i,
  /\b(?:auth(?:entication)? required|login required|switch auth profile|rate limit|quota exceeded|missing .*api key|no credentials)\b/i,
  /\b(?:merge conflict|conflict markers|cannot proceed|needs manual intervention)\b/i,
];

const WORKING_PATTERNS = [
  /\b(?:Pursuing goal|Working \(|esc to interrupt|background terminal running|Goal active Objective:|running tool|executing|thinking)\b/i,
  /[✶✻●]\s*Working/i,
];

const IDLE_PATTERNS = [
  /^\s*[›❯>](?:\s|$).*/m,
  /\b(?:awaiting prompt|idle composer|Goal achieved)\b/i,
];

function nonAgentClassification(detection: AgentTargetInfo | undefined): FleetPaneClassification {
  if (detection?.targetKind === "shell") {
    return {
      state: "blocked",
      uncertainty: "low",
      reasons: [detection.reason || "target is a shell, not an agent composer"],
    };
  }
  return {
    state: "blocked",
    uncertainty: "medium",
    reasons: [detection?.reason || "target is not a proven agent composer"],
  };
}

export function classifyFleetPane(input: {
  detection?: AgentTargetInfo;
  excerpt: string;
  changedSinceMs?: number;
}): FleetPaneClassification {
  const text = compactWhitespace(input.excerpt);
  const ageMs = observedActivityAgeMs(text);
  const reasons: string[] = [];

  const blocked = hasAny(BLOCKED_PATTERNS, text);
  if (blocked) {
    return { state: "blocked", uncertainty: "low", reasons: [`matched blocked pattern: ${blocked}`], observedActivityAgeMs: ageMs };
  }

  const error = hasAny(ERROR_PATTERNS, text);
  if (error) {
    return { state: "error", uncertainty: "low", reasons: [`matched error pattern: ${error}`], observedActivityAgeMs: ageMs };
  }

  const detection = input.detection;
  if (detection?.targetKind !== "agent" || detection.agentKind === "unknown") {
    return { ...nonAgentClassification(detection), observedActivityAgeMs: ageMs };
  }

  if (detection.composerState === "idle" && detection.canReceivePrompt) {
    return {
      state: "idle",
      uncertainty: "low",
      reasons: [detection.reason || "agent composer is idle"],
      observedActivityAgeMs: ageMs,
    };
  }

  if (detection.composerState === "active") {
    if (input.changedSinceMs !== undefined && ageMs !== undefined && ageMs >= input.changedSinceMs) {
      return {
        state: "stuck",
        uncertainty: "medium",
        reasons: [
          `visible active status age ${ageMs}ms is at or above changed-since threshold ${input.changedSinceMs}ms`,
          "tmux does not expose a durable last-output timestamp, so this is inferred from visible agent status text",
        ],
        observedActivityAgeMs: ageMs,
      };
    }
    return {
      state: "working",
      uncertainty: hasAny(WORKING_PATTERNS, text) ? "low" : "medium",
      reasons: [detection.reason || "agent composer appears active"],
      observedActivityAgeMs: ageMs,
    };
  }

  const visibleActivity = detectAgentActivity(text);
  if (visibleActivity === "idle" || hasAny(IDLE_PATTERNS, text)) {
    reasons.push("visible prompt-like idle UI, but target detection was not fully certain");
    return { state: "idle", uncertainty: "high", reasons, observedActivityAgeMs: ageMs };
  }
  if (visibleActivity === "active" || hasAny(WORKING_PATTERNS, text)) {
    reasons.push("visible working signal, but target detection was not fully certain");
    return { state: "working", uncertainty: "high", reasons, observedActivityAgeMs: ageMs };
  }

  return {
    state: "stuck",
    uncertainty: "high",
    reasons: [detection.reason || "no clear idle, working, blocked, or error signal in bounded excerpt"],
    observedActivityAgeMs: ageMs,
  };
}

function emptyTotals(): Record<FleetPaneState, number> {
  return { working: 0, idle: 0, stuck: 0, error: 0, blocked: 0 };
}

export function performFleetSummary(options: FleetSummaryOptions, deps: FleetSummaryDeps): FleetSummaryResult {
  const env = deps.env ?? process.env;
  const tmux = deps.tmux;
  const machine = tmux.machine;
  const limit = normalizePositiveInteger(options.limit, DEFAULT_FLEET_SUMMARY_LIMIT, MAX_FLEET_SUMMARY_LIMIT);
  const requestedMaxPaneChars = Number.isFinite(options.maxPaneChars)
    ? Math.max(1, Math.trunc(options.maxPaneChars as number))
    : DEFAULT_FLEET_MAX_PANE_CHARS;
  const maxPaneChars = normalizePositiveInteger(
    options.maxPaneChars,
    DEFAULT_FLEET_MAX_PANE_CHARS,
    MAX_FLEET_MAX_PANE_CHARS,
  );
  const targetGlobs = normalizeTargetGlobs(options.targets);
  let changedSinceMs: number | undefined;
  try {
    changedSinceMs =
      options.changedSinceMs !== undefined
        ? normalizePositiveInteger(options.changedSinceMs, options.changedSinceMs, Number.MAX_SAFE_INTEGER)
        : options.changedSince
          ? parseDurationMs(options.changedSince)
          : undefined;
  } catch (err) {
    return {
      schemaVersion: FLEET_SUMMARY_SCHEMA_VERSION,
      status: "failed",
      machine,
      generatedAt: nowIso(),
      targetGlobs,
      limit,
      maxLimit: MAX_FLEET_SUMMARY_LIMIT,
      requestedMaxPaneChars,
      maxPaneChars,
      maxAllowedPaneChars: MAX_FLEET_MAX_PANE_CHARS,
      totalTargets: 0,
      matchedTargets: 0,
      inspectedTargets: 0,
      omittedTargets: 0,
      totals: emptyTotals(),
      items: [],
      detail: `invalid changed-since: ${(err as Error).message}`,
      compact: true,
    };
  }

  const preflight = options.preflightAi ? preflightCaptureAi({ enabled: true, ...options.ai }, env) : undefined;
  if (preflight && !preflight.ok) {
    return {
      schemaVersion: FLEET_SUMMARY_SCHEMA_VERSION,
      status: "failed",
      machine,
      generatedAt: nowIso(),
      targetGlobs,
      changedSinceMs,
      limit,
      maxLimit: MAX_FLEET_SUMMARY_LIMIT,
      requestedMaxPaneChars,
      maxPaneChars,
      maxAllowedPaneChars: MAX_FLEET_MAX_PANE_CHARS,
      totalTargets: 0,
      matchedTargets: 0,
      inspectedTargets: 0,
      omittedTargets: 0,
      totals: emptyTotals(),
      preflight,
      items: [],
      detail: preflight.detail ?? "AI preflight failed",
      compact: true,
    };
  }

  const allTargets = tmux.listTargets();
  const matched = allTargets.filter((target) => targetMatchesGlobs({ machine, target: target.target, globs: targetGlobs }));
  const selected = matched.slice(0, limit);
  const totals = emptyTotals();
  const internalCaptureChars = Math.min(
    TARGET_DISCOVERY_CAPTURE_MAX_CHARS,
    Math.max(maxPaneChars, MIN_FLEET_DETECTION_CHARS),
  );

  const items: FleetSummaryItem[] = selected.map((target) => {
    let visible = "";
    let detection: AgentTargetInfo | undefined;
    let error: string | undefined;
    try {
      const inspected = inspectAgentTarget(tmux, target.target, {
        assumeExists: true,
        paneCommand: target.paneCommand,
        cwd: target.cwd,
        panePid: target.panePid,
        maxCaptureChars: internalCaptureChars,
        maxProcessTreeLines: TARGET_DISCOVERY_PROCESS_MAX_LINES,
        maxProcessTreeLineChars: TARGET_DISCOVERY_PROCESS_MAX_LINE_CHARS,
      });
      detection = inspected.detection;
      visible = inspected.visible ?? "";
      if (!visible) {
        visible = tmux.capturePane(target.target, { start: DEFAULT_FLEET_CAPTURE_LINES, maxChars: maxPaneChars });
      }
    } catch (err) {
      error = (err as Error).message;
    }

    const redacted = redactSecrets(stripTerminalControl(visible));
    const excerpt = tailChars(redacted, maxPaneChars);
    const classification = error
      ? ({
          state: "error",
          uncertainty: "low",
          reasons: [`target inspection failed: ${error}`],
        } satisfies FleetPaneClassification)
      : classifyFleetPane({ detection, excerpt: excerpt.text, changedSinceMs });
    totals[classification.state] += 1;
    return {
      backend: "tmux",
      target: target.target,
      machine,
      window: target.window,
      active: target.active,
      paneCommand: target.paneCommand,
      cwd: target.cwd,
      detection,
      classification,
      excerpt: excerpt.text,
      excerptChars: excerpt.text.length,
      excerptTruncated: excerpt.truncated,
      error,
    };
  });

  return {
    schemaVersion: FLEET_SUMMARY_SCHEMA_VERSION,
    status: "completed",
    machine,
    generatedAt: nowIso(),
    targetGlobs,
    changedSinceMs,
    limit,
    maxLimit: MAX_FLEET_SUMMARY_LIMIT,
    requestedMaxPaneChars,
    maxPaneChars,
    maxAllowedPaneChars: MAX_FLEET_MAX_PANE_CHARS,
    totalTargets: allTargets.length,
    matchedTargets: matched.length,
    inspectedTargets: items.length,
    omittedTargets: Math.max(0, matched.length - items.length),
    totals,
    preflight,
    items,
    compact: true,
  };
}
