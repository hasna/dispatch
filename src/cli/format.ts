import { readFileSync } from "node:fs";
import type { DispatchRecord, ScheduledDispatch } from "../types.js";

/**
 * Resolve the prompt text from the flags: --prompt wins, else --file, else
 * stdin (when piped). Throws if none is available.
 */
export function resolvePrompt(opts: { prompt?: string; file?: string }, stdin?: string): string {
  if (opts.prompt !== undefined) return opts.prompt;
  if (opts.file) return readFileSync(opts.file, "utf8");
  if (stdin !== undefined && stdin.length > 0) return stdin;
  throw new Error("no prompt: pass --prompt <text>, --file <path>, or pipe via stdin");
}

const STATUS_ICON: Record<string, string> = {
  delivered: "✓",
  failed: "✗",
  pending: "·",
  sending: "→",
  scheduled: "⧗",
  cancelled: "⊘",
};

/** One-line human summary of a dispatch record. */
export function formatRecord(rec: DispatchRecord): string {
  const icon = STATUS_ICON[rec.status] ?? "?";
  const where = rec.machine && rec.machine !== "local" ? `${rec.machine}/${rec.target}` : rec.target;
  const preview = rec.prompt.replace(/\s+/g, " ").slice(0, 50);
  const detail = rec.detail ? ` — ${rec.detail}` : "";
  return `${icon} ${rec.id}  ${rec.status.padEnd(9)} ${where}  "${preview}"${detail}`;
}

/** One-line human summary of a scheduled dispatch. */
export function formatSchedule(s: ScheduledDispatch): string {
  const when = s.cron ? `cron(${s.cron})` : `at ${s.at}`;
  const where = s.options.machine && s.options.machine !== "local"
    ? `${s.options.machine}/${s.options.target}`
    : s.options.target;
  const preview = s.options.prompt.replace(/\s+/g, " ").slice(0, 40);
  return `⧗ ${s.id}  ${s.status.padEnd(9)} ${when} next=${s.nextRun}  ${where}  "${preview}"`;
}
