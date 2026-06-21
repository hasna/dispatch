import { readFileSync } from "node:fs";
import type { DispatchRecord, ScheduledDispatch } from "../types.js";

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
