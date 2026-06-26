import { readFileSync } from "node:fs";
import type { BulkDispatchResult, CaptureResult, DispatchRecord, FleetSummaryResult, ScheduledDispatch } from "../types.js";

/**
 * Resolve the prompt text from the flags: --prompt wins, else --file, else
 * stdin (when piped). Throws if none is available, or if the resolved prompt is
 * empty/whitespace-only (e.g. an empty --file) — an empty dispatch is never
 * intended and would just press Enter on the target.
 */
export function resolvePrompt(opts: { prompt?: string; file?: string }, stdin?: string): string {
  let prompt: string;
  if (opts.prompt !== undefined) {
    prompt = opts.prompt;
  } else if (opts.file) {
    prompt = readFileSync(opts.file, "utf8");
  } else if (stdin !== undefined && stdin.length > 0) {
    prompt = stdin;
  } else {
    throw new Error("no prompt: pass --prompt <text>, --file <path>, or pipe via stdin");
  }
  if (prompt.trim().length === 0) {
    throw new Error("prompt is empty: provide non-empty text via --prompt, --file, or stdin");
  }
  return prompt;
}

const STATUS_ICON: Record<string, string> = {
  delivered: "✓",
  failed: "✗",
  pending: "·",
  sending: "→",
  scheduled: "⧗",
  paused: "‖",
  cancelled: "⊘",
  skipped: "↷",
};

export interface CompactDispatchRecord {
  id: string;
  kind: string;
  status: string;
  target: string;
  machine: string;
  promptPreview: string;
  promptLength: number;
  detailPreview?: string;
  detailLength?: number;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  commandHash?: string;
  filterCode?: string;
  targetState?: string;
}

export interface CompactScheduledDispatch {
  id: string;
  kind: string;
  name?: string;
  status: string;
  target: string;
  machine: string;
  cadence: string;
  nextRun: string;
  promptPreview: string;
  promptLength: number;
  lastDispatchId?: string;
  lastFiredAt?: string;
  lastFailureAt?: string;
  lastFailureReasonPreview?: string;
  lastFailureReasonLength?: number;
  failureCount?: number;
  createdAt: string;
  updatedAt: string;
}

export function truncateText(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

function quotePreview(text: string, max = 80): string {
  return `"${truncateText(text, max)}"`;
}

function where(machine: string | undefined, target: string): string {
  return machine && machine !== "local" ? `${machine}/${target}` : target;
}

function scheduleKind(s: ScheduledDispatch): string {
  return s.kind ?? (s.intervalMs ? "loop" : "schedule");
}

function scheduleCadence(s: ScheduledDispatch): string {
  return s.every
    ? `every(${s.every})`
    : s.intervalMs
      ? `every(${s.intervalMs}ms)`
      : s.cron
        ? `cron(${s.cron})`
        : `at ${s.at}`;
}

export function summarizeRecord(rec: DispatchRecord, opts: { previewChars?: number } = {}): CompactDispatchRecord {
  return {
    id: rec.id,
    kind: rec.kind ?? "prompt",
    status: rec.status,
    target: rec.target,
    machine: rec.machine ?? "local",
    promptPreview: truncateText(rec.prompt, opts.previewChars ?? 80),
    promptLength: rec.prompt.length,
    detailPreview: rec.detail ? truncateText(rec.detail, opts.previewChars ?? 80) : undefined,
    detailLength: rec.detail?.length,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    deliveredAt: rec.deliveredAt,
    commandHash: rec.commandHash,
    filterCode: rec.filter?.code,
    targetState: rec.targetState,
  };
}

export function summarizeSchedule(s: ScheduledDispatch, opts: { previewChars?: number } = {}): CompactScheduledDispatch {
  return {
    id: s.id,
    kind: scheduleKind(s),
    name: s.name,
    status: s.status,
    target: s.options.target,
    machine: s.options.machine ?? "local",
    cadence: scheduleCadence(s),
    nextRun: s.nextRun,
    promptPreview: truncateText(s.options.prompt, opts.previewChars ?? 80),
    promptLength: s.options.prompt.length,
    lastDispatchId: s.lastDispatchId,
    lastFiredAt: s.lastFiredAt,
    lastFailureAt: s.lastFailureAt,
    lastFailureReasonPreview: s.lastFailureReason ? truncateText(s.lastFailureReason, opts.previewChars ?? 80) : undefined,
    lastFailureReasonLength: s.lastFailureReason?.length,
    failureCount: s.failureCount,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** One-line human summary of a dispatch record. */
export function formatRecord(rec: DispatchRecord): string {
  const icon = STATUS_ICON[rec.status] ?? "?";
  const location = where(rec.machine, rec.target);
  const preview = quotePreview(rec.prompt, 60);
  const detail = rec.detail ? ` — ${truncateText(rec.detail, 160)}` : "";
  if (rec.kind === "exec") {
    const hash = rec.commandHash ? ` sha=${rec.commandHash}` : "";
    const targetKind = rec.targetKind ? ` target=${rec.targetKind}` : "";
    const filter = rec.filter ? ` filter=${rec.filter.code}` : "";
    const dryRun = rec.dryRun ? " dry-run" : "";
    return `${icon} ${rec.id}  ${rec.status.padEnd(9)} exec${dryRun}${hash}${targetKind}${filter} ${location}  ${preview}${detail}`;
  }
  if (rec.kind === "key") {
    return `${icon} ${rec.id}  ${rec.status.padEnd(9)} key ${location}  ${preview}${detail}`;
  }
  return `${icon} ${rec.id}  ${rec.status.padEnd(9)} ${location}  ${preview}${detail}`;
}

export function formatRecordDetail(rec: DispatchRecord): string {
  const summary = summarizeRecord(rec, { previewChars: 500 });
  const lines = [
    formatRecord(rec),
    `  kind: ${summary.kind}`,
    `  machine: ${summary.machine}`,
    `  target: ${summary.target}`,
    `  created: ${rec.createdAt}`,
    `  updated: ${rec.updatedAt}`,
  ];
  if (rec.deliveredAt) lines.push(`  delivered: ${rec.deliveredAt}`);
  if (rec.detail) lines.push(`  detail: ${truncateText(rec.detail, 1_000)} (${rec.detail.length} chars; use --json for the full stored detail)`);
  if (rec.confirm) lines.push(`  confirm: delivered=${rec.confirm.delivered} reason=${rec.confirm.reason}`);
  if (rec.detection) {
    lines.push(
      `  detection: ${rec.detection.agentKind}/${rec.detection.composerState} canReceive=${rec.detection.canReceivePrompt} canQueue=${rec.detection.canQueuePrompt}`,
    );
  }
  if (rec.filter) lines.push(`  filter: ${rec.filter.code} allowed=${rec.filter.allowed} rule=${rec.filter.matchedRule ?? "none"}`);
  if (rec.commandHash) lines.push(`  commandHash: ${rec.commandHash}`);
  lines.push(`  prompt: ${quotePreview(rec.prompt, 500)} (${rec.prompt.length} chars; use --json for the full stored prompt/object)`);
  return lines.join("\n");
}

/** Plain-text output for a pane transcript capture. */
export function formatCapture(result: CaptureResult): string {
  if (result.status === "failed") return `✗ capture failed for ${result.target} — ${result.detail ?? "unknown error"}`;
  const parts = [result.text];
  if (result.ai) {
    const label = result.ai.transform ?? "custom";
    if (result.ai.status === "completed") {
      parts.push(
        `\n--- AI ${label} (${result.ai.provider}${result.ai.model ? `/${result.ai.model}` : ""}) ---\n${result.ai.text ?? ""}`,
      );
    } else {
      parts.push(`\n--- AI ${label} (${result.ai.provider}) ${result.ai.status} ---\n${result.ai.detail ?? "no detail"}`);
    }
  }
  return parts.join("\n");
}

export function formatBulk(result: BulkDispatchResult): string {
  const lines = [
    `${result.status === "completed" ? "✓" : "✗"} bulk ${result.source} requested=${result.requested} planned=${result.planned} delivered=${result.delivered} skipped=${result.skipped} failed=${result.failed}${result.dryRun ? " dry-run" : ""}`,
  ];
  if (result.detail) lines.push(truncateText(result.detail, 1_000));
  const shown = result.records.slice(0, 20);
  for (const rec of shown) lines.push(formatRecord(rec));
  const omitted = result.records.length - shown.length;
  if (omitted > 0) lines.push(`… ${omitted} more record(s) omitted`);
  lines.push("hint: use --json for full records");
  return lines.join("\n");
}

export function formatFleetSummary(result: FleetSummaryResult): string {
  const lines = [
    `${result.status === "completed" ? "OK" : "FAIL"} fleet summary machine=${result.machine} matched=${result.matchedTargets} inspected=${result.inspectedTargets} limit=${result.limit} maxPaneChars=${result.maxPaneChars}`,
    `states working=${result.totals.working} idle=${result.totals.idle} stuck=${result.totals.stuck} error=${result.totals.error} blocked=${result.totals.blocked}`,
  ];
  if (result.preflight) {
    lines.push(
      `preflight ai=${result.preflight.ok ? "ok" : "failed"} provider=${result.preflight.provider}${result.preflight.model ? ` model=${result.preflight.model}` : ""}${result.preflight.detail ? ` detail=${truncateText(result.preflight.detail, 220)}` : ""}`,
    );
  }
  if (result.detail) lines.push(truncateText(result.detail, 500));
  for (const item of result.items) {
    const detection = item.detection
      ? `${item.detection.agentKind}/${item.detection.composerState} receive=${item.detection.canReceivePrompt} queue=${item.detection.canQueuePrompt}`
      : "unknown/unknown receive=false queue=false";
    lines.push(
      `- ${item.target} ${item.classification.state} uncertainty=${item.classification.uncertainty} ${detection} reason=${truncateText(item.classification.reasons.join("; "), 180)}`,
    );
    if (item.excerpt) {
      lines.push(`  excerpt: ${quotePreview(item.excerpt, 180)}${item.excerptTruncated ? " (truncated)" : ""}`);
    }
  }
  if (result.omittedTargets > 0) lines.push(`... ${result.omittedTargets} matched target(s) omitted by limit`);
  lines.push("hint: use --json for the stable compact schema; raise --limit/--max-pane-chars deliberately for more");
  return lines.join("\n");
}

export function summarizeBulk(result: BulkDispatchResult): {
  status: string;
  source: string;
  requested: number;
  planned: number;
  delivered: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  detailPreview?: string;
  detailLength?: number;
  recordCount: number;
  shownRecords: number;
  omittedRecords: number;
  records: CompactDispatchRecord[];
  compact: true;
  hint: string;
} {
  return {
    status: result.status,
    source: result.source,
    requested: result.requested,
    planned: result.planned,
    delivered: result.delivered,
    skipped: result.skipped,
    failed: result.failed,
    dryRun: result.dryRun,
    detailPreview: result.detail ? truncateText(result.detail, 80) : undefined,
    detailLength: result.detail?.length,
    recordCount: result.records.length,
    shownRecords: Math.min(result.records.length, 20),
    omittedRecords: Math.max(0, result.records.length - 20),
    records: result.records.slice(0, 20).map((record) => summarizeRecord(record)),
    compact: true,
    hint: "pass verbose:true for full records",
  };
}

/** One-line human summary of a scheduled dispatch. */
export function formatSchedule(s: ScheduledDispatch): string {
  const icon = STATUS_ICON[s.status] ?? "⧗";
  const kind = scheduleKind(s);
  const label = s.name ? `${kind}:${s.name}` : kind;
  const location = where(s.options.machine, s.options.target);
  const preview = quotePreview(s.options.prompt, 60);
  const failure = s.lastFailureAt ? ` failure=${s.failureCount ?? 1}` : "";
  return `${icon} ${s.id}  ${s.status.padEnd(9)} ${label} ${scheduleCadence(s)} next=${s.nextRun}${failure}  ${location}  ${preview}`;
}

export function formatScheduleDetail(s: ScheduledDispatch): string {
  const summary = summarizeSchedule(s, { previewChars: 500 });
  const lines = [
    formatSchedule(s),
    `  kind: ${summary.kind}`,
    `  machine: ${summary.machine}`,
    `  target: ${summary.target}`,
    `  cadence: ${summary.cadence}`,
    `  nextRun: ${s.nextRun}`,
    `  created: ${s.createdAt}`,
    `  updated: ${s.updatedAt}`,
  ];
  if (s.name) lines.push(`  name: ${s.name}`);
  if (s.lastDispatchId) lines.push(`  lastDispatchId: ${s.lastDispatchId}`);
  if (s.lastFiredAt) lines.push(`  lastFiredAt: ${s.lastFiredAt}`);
  if (s.lastFailureAt) lines.push(`  lastFailureAt: ${s.lastFailureAt}`);
  if (s.lastFailureReason) lines.push(`  lastFailureReason: ${truncateText(s.lastFailureReason, 1_000)} (${s.lastFailureReason.length} chars; use --json for the full stored failure reason)`);
  if (s.failureCount) lines.push(`  failureCount: ${s.failureCount}`);
  lines.push(`  prompt: ${quotePreview(s.options.prompt, 500)} (${s.options.prompt.length} chars; use --json for the full stored prompt/object)`);
  return lines.join("\n");
}

export function formatRecordList(rows: DispatchRecord[], opts: { limit?: number; verbose?: boolean; hasMore?: boolean } = {}): string {
  if (rows.length === 0) return "no dispatches yet";
  const more = opts.hasMore ? "; more available" : "";
  const lines = [`dispatches: showing ${rows.length}${opts.limit ? ` (limit ${opts.limit}${more})` : ""}`];
  for (const row of rows) lines.push(opts.verbose ? formatRecordDetail(row) : formatRecord(row));
  lines.push("hint: use `dispatch show <id>` for details, `--verbose` for expanded text, or `--json` for full records");
  return lines.join("\n");
}

export function formatScheduleList(rows: ScheduledDispatch[], opts: { limit?: number; verbose?: boolean; label?: string; hasMore?: boolean } = {}): string {
  const label = opts.label ?? "scheduled dispatches";
  if (rows.length === 0) return `no ${label}`;
  const more = opts.hasMore ? "; more available" : "";
  const lines = [`${label}: showing ${rows.length}${opts.limit ? ` (limit ${opts.limit}${more})` : ""}`];
  for (const row of rows) lines.push(opts.verbose ? formatScheduleDetail(row) : formatSchedule(row));
  lines.push("hint: use `dispatch show <id>` for details, `--verbose` for expanded text, or `--json` for full records");
  return lines.join("\n");
}
