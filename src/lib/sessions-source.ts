import type { DispatchTargetRef } from "../types.js";
import type { Runner } from "./runner.js";

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function candidateArrays(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = asObject(value);
  if (!obj) return [];
  for (const key of ["targets", "sessions", "panes", "items", "rows", "data"]) {
    const nested = obj[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function textField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseSessionsTargets(jsonText: string, fallbackMachine?: string, query?: string): DispatchTargetRef[] {
  const parsed = JSON.parse(jsonText) as unknown;
  const items = candidateArrays(parsed);
  const normalizedQuery = query?.trim().toLowerCase();
  const targets: DispatchTargetRef[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const obj = asObject(item);
    if (!obj) continue;
    const target = textField(obj, ["target", "tmuxTarget", "tmux_target", "tmux", "pane", "paneTarget"]);
    if (!target) continue;
    const machine = textField(obj, ["machine", "machineId", "machine_id", "host"]) ?? fallbackMachine;
    const haystack = JSON.stringify(obj).toLowerCase();
    if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
    const key = `${machine ?? "local"}\0${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      target,
      machine,
      source: "sessions-query",
      state: textField(obj, ["state", "status", "activity"]) as DispatchTargetRef["state"],
    });
  }

  return targets;
}

export async function resolveSessionsTargets(input: {
  runner: Runner;
  machine?: string;
  query?: string;
}): Promise<DispatchTargetRef[]> {
  const attempts = [
    ["sessions", "live", "--json", "--once"],
    ["sessions", "status", "--json"],
  ];
  const errors: string[] = [];
  for (const argv of attempts) {
    const result = input.runner.run(argv);
    if (result.exitCode !== 0) {
      errors.push(`${argv.join(" ")}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`);
      continue;
    }
    try {
      return parseSessionsTargets(result.stdout, input.machine, input.query);
    } catch (err) {
      errors.push(`${argv.join(" ")}: invalid JSON (${(err as Error).message})`);
    }
  }
  throw new Error(
    `could not resolve targets from sessions-query; expected sessions live/status JSON output. ${errors.join("; ")}`,
  );
}
