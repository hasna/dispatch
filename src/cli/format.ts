import { readFileSync } from "node:fs";
import type { BulkDispatchResult, CaptureResult, DispatchRecord, ScheduledDispatch } from "../types.js";

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

/** One-line human summary of a dispatch record. */
export function formatRecord(rec: DispatchRecord): string {
  const icon = STATUS_ICON[rec.status] ?? "?";
  const where = rec.machine && rec.machine !== "local" ? `${rec.machine}/${rec.target}` : rec.target;
  const preview = rec.prompt.replace(/\s+/g, " ").slice(0, 50);
  const detail = rec.detail ? ` — ${rec.detail}` : "";
  if (rec.kind === "exec") {
    const hash = rec.commandHash ? ` sha=${rec.commandHash}` : "";
    const targetKind = rec.targetKind ? ` target=${rec.targetKind}` : "";
    const filter = rec.filter ? ` filter=${rec.filter.code}` : "";
    const dryRun = rec.dryRun ? " dry-run" : "";
    return `${icon} ${rec.id}  ${rec.status.padEnd(9)} exec${dryRun}${hash}${targetKind}${filter} ${where}  "${preview}"${detail}`;
  }
  if (rec.kind === "key") {
    return `${icon} ${rec.id}  ${rec.status.padEnd(9)} key ${where}  "${preview}"${detail}`;
  }
  return `${icon} ${rec.id}  ${rec.status.padEnd(9)} ${where}  "${preview}"${detail}`;
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
  if (result.detail) lines.push(result.detail);
  for (const rec of result.records) lines.push(formatRecord(rec));
  return lines.join("\n");
}

/** One-line human summary of a scheduled dispatch. */
export function formatSchedule(s: ScheduledDispatch): string {
  const icon = STATUS_ICON[s.status] ?? "⧗";
  const kind = s.kind ?? (s.intervalMs ? "loop" : "schedule");
  const label = s.name ? `${kind}:${s.name}` : kind;
  const when = s.every
    ? `every(${s.every})`
    : s.intervalMs
      ? `every(${s.intervalMs}ms)`
      : s.cron
        ? `cron(${s.cron})`
        : `at ${s.at}`;
  const where = s.options.machine && s.options.machine !== "local"
    ? `${s.options.machine}/${s.options.target}`
    : s.options.target;
  const preview = s.options.prompt.replace(/\s+/g, " ").slice(0, 40);
  return `${icon} ${s.id}  ${s.status.padEnd(9)} ${label} ${when} next=${s.nextRun}  ${where}  "${preview}"`;
}
