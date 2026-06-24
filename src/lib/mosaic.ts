import type { CaptureOptions, CaptureResult, DispatchOptions, DispatchRecord, MosaicPromptReceipt } from "../types.js";
import type { Store } from "./store.js";
import type { RunResult, Runner } from "./runner.js";
import { applyGoalPrefix } from "./engine.js";
import { genId, nowIso } from "./ids.js";
import { MAX_CAPTURE_LINES, normalizeCaptureLines, redactSecrets, stripTerminalControl } from "./capture.js";

export const MOSAIC_SCHEMA_VERSION = "mosaic.control.v1";

export interface MosaicSessionInfo {
  session: string;
  name?: string;
}

export interface MosaicPaneInfo {
  session: string;
  paneId: string;
  tabId?: string;
  tabName?: string;
  title?: string;
  active?: boolean;
  raw?: unknown;
}

export interface MosaicTabInfo {
  session: string;
  tabId: string;
  name?: string;
  active?: boolean;
  raw?: unknown;
}

export interface MosaicTargetInfo {
  backend: "mosaic";
  target: string;
  session: string;
  paneId: string;
  tabId?: string;
  window: string;
  active: boolean;
  raw?: unknown;
}

export interface MosaicPromptResult {
  receipt: MosaicPromptReceipt;
  argv: string[];
}

export interface ValidatedMosaicReceipt {
  receipt: MosaicPromptReceipt;
  status: string;
  queued: boolean;
  dryRun: boolean;
}

export class MosaicControlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly result?: RunResult,
  ) {
    super(message);
    this.name = "MosaicControlError";
  }
}

export function parseMosaicTarget(target: string): { session: string; paneId: string } {
  const trimmed = target.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) {
    throw new Error("Mosaic targets must use <session>:<pane_id>");
  }
  return { session: trimmed.slice(0, colon), paneId: trimmed.slice(colon + 1) };
}

function parseJson(text: string, context: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`${context} returned no JSON`);
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`${context} returned invalid JSON: ${(err as Error).message}`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, keys: string[]): string | undefined {
  const obj = objectRecord(value);
  if (!obj) return undefined;
  for (const key of keys) {
    const field = obj[key];
    if (typeof field === "string" && field.trim()) return field;
    if (typeof field === "number") return String(field);
  }
  return undefined;
}

function boolField(value: unknown, keys: string[]): boolean | undefined {
  const obj = objectRecord(value);
  if (!obj) return undefined;
  for (const key of keys) {
    const field = obj[key];
    if (typeof field === "boolean") return field;
    if (typeof field === "number") return field !== 0;
  }
  return undefined;
}

function envelopeData(value: unknown): unknown {
  return objectRecord(value)?.data ?? value;
}

function arrayFromEnvelope(value: unknown, keys: string[]): unknown[] {
  const data = envelopeData(value);
  if (Array.isArray(data)) return data;
  const obj = objectRecord(data);
  if (!obj) return [];
  for (const key of keys) {
    const field = obj[key];
    if (Array.isArray(field)) return field;
  }
  return [];
}

function errorFromResult(result: RunResult, context: string): MosaicControlError {
  let code: string | undefined;
  let message = result.stderr.trim() || result.stdout.trim() || `${context} failed`;
  const payloadText = result.stderr.trim() || result.stdout.trim();
  if (payloadText.startsWith("{")) {
    try {
      const payload = objectRecord(JSON.parse(payloadText));
      code = typeof payload?.code === "string" ? payload.code : undefined;
      message = typeof payload?.message === "string" ? payload.message : message;
    } catch {
      // Keep the raw stderr/stdout message.
    }
  }
  return new MosaicControlError(`${context} failed: ${message}`, code, result);
}

function captureTextFromPayload(value: unknown): string {
  const data = envelopeData(value);
  if (typeof data === "string") return data;
  const obj = objectRecord(data);
  if (!obj) return "";
  for (const key of ["text", "content", "output", "scrollback", "viewport"]) {
    const field = obj[key];
    if (typeof field === "string") return field;
  }
  for (const key of ["lines", "scrollback_lines"]) {
    const field = obj[key];
    if (Array.isArray(field)) return field.map(String).join("\n");
  }
  return "";
}

function tailLines(text: string, lines: number): string {
  const parts = text.split("\n");
  const hadTrailingNewline = parts.at(-1) === "";
  const body = hadTrailingNewline ? parts.slice(0, -1) : parts;
  const tailed = body.slice(-lines).join("\n");
  return hadTrailingNewline && tailed.length > 0 ? `${tailed}\n` : tailed;
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  const obj = objectRecord(error);
  if (!obj) return String(error);
  const code = typeof obj.code === "string" ? obj.code : undefined;
  const message = typeof obj.message === "string" ? obj.message : undefined;
  return [code, message].filter(Boolean).join(": ") || JSON.stringify(error);
}

export function validateMosaicReceipt(receipt: MosaicPromptReceipt, expected: { session: string; paneId: string }): ValidatedMosaicReceipt {
  if (receipt.schema_version !== MOSAIC_SCHEMA_VERSION) {
    throw new Error(`unexpected Mosaic receipt schema: ${receipt.schema_version ?? "missing"}`);
  }
  if (receipt.event !== "receipt") {
    throw new Error(`unexpected Mosaic receipt event: ${receipt.event ?? "missing"}`);
  }
  if (receipt.operation !== "prompt.send") {
    throw new Error(`unexpected Mosaic receipt operation: ${receipt.operation ?? "missing"}`);
  }
  if (receipt.session !== expected.session) {
    throw new Error(`Mosaic receipt session mismatch: expected ${expected.session}, got ${receipt.session ?? "missing"}`);
  }
  if (receipt.pane_id !== expected.paneId) {
    throw new Error(`Mosaic receipt pane mismatch: expected ${expected.paneId}, got ${receipt.pane_id ?? "missing"}`);
  }
  if (receipt.error) {
    throw new Error(`Mosaic receipt error: ${errorText(receipt.error) ?? "unknown error"}`);
  }
  const status = receipt.status;
  if (status !== "accepted" && status !== "queued" && status !== "dry_run" && status !== "dry-run") {
    throw new Error(`Mosaic receipt was not accepted: ${status ?? "missing"}`);
  }
  return {
    receipt,
    status,
    queued: status === "queued" || /queued/i.test(String(receipt.ack ?? "")),
    dryRun: status === "dry_run" || status === "dry-run",
  };
}

export class Mosaic {
  constructor(
    private readonly runner: Runner,
    private readonly bin = process.env.DISPATCH_MOSAIC_BIN || "mosaic",
  ) {}

  get machine(): string {
    return this.runner.machine;
  }

  private run(args: string[], input?: string): RunResult {
    return this.runner.run([this.bin, ...args], input);
  }

  private runJson(args: string[], context: string): unknown {
    const result = this.run(args);
    if (result.exitCode !== 0) throw errorFromResult(result, context);
    return parseJson(result.stdout, context);
  }

  listSessions(): MosaicSessionInfo[] {
    const payload = this.runJson(["sessions", "list"], "mosaic sessions list");
    return arrayFromEnvelope(payload, ["sessions"]).flatMap((item): MosaicSessionInfo[] => {
      const session = stringField(item, ["session", "name", "id"]);
      return session ? [{ session, name: stringField(item, ["name"]) ?? session }] : [];
    });
  }

  listPanes(session: string): MosaicPaneInfo[] {
    const payload = this.runJson(["--session", session, "panes", "list", "--all"], `mosaic panes list ${session}`);
    return arrayFromEnvelope(payload, ["panes"]).flatMap((item): MosaicPaneInfo[] => {
      const paneId = stringField(item, ["pane_id", "paneId", "id"]);
      if (!paneId) return [];
      return [
        {
          session,
          paneId,
          tabId: stringField(item, ["tab_id", "tabId", "tab"]),
          title: stringField(item, ["title", "name", "command"]),
          active: boolField(item, ["active", "is_active", "focused"]),
          raw: item,
        },
      ];
    });
  }

  listTabs(session: string): MosaicTabInfo[] {
    const payload = this.runJson(["--session", session, "tabs", "list", "--all"], `mosaic tabs list ${session}`);
    return arrayFromEnvelope(payload, ["tabs"]).flatMap((item): MosaicTabInfo[] => {
      const tabId = stringField(item, ["tab_id", "tabId", "id"]);
      if (!tabId) return [];
      return [
        {
          session,
          tabId,
          name: stringField(item, ["name", "title"]),
          active: boolField(item, ["active", "is_active", "focused"]),
          raw: item,
        },
      ];
    });
  }

  listTargets(): MosaicTargetInfo[] {
    const targets: MosaicTargetInfo[] = [];
    for (const session of this.listSessions()) {
      const tabs = new Map(this.listTabs(session.session).map((tab) => [tab.tabId, tab]));
      for (const pane of this.listPanes(session.session)) {
        const tab = pane.tabId ? tabs.get(pane.tabId) : undefined;
        targets.push({
          backend: "mosaic",
          target: `${session.session}:${pane.paneId}`,
          session: session.session,
          paneId: pane.paneId,
          tabId: pane.tabId,
          window: pane.tabName ?? tab?.name ?? pane.title ?? pane.tabId ?? "mosaic",
          active: pane.active ?? tab?.active ?? false,
          raw: pane.raw,
        });
      }
    }
    return targets;
  }

  buildPromptSendArgs(options: DispatchOptions, prompt: string): string[] {
    const { session, paneId } = parseMosaicTarget(options.target);
    const args = ["--session", session];
    if (options.dryRun === true) args.push("--dry-run");
    args.push("prompt", "send", "--pane-id", paneId);
    if (options.queue === true || options.submitKey === "Tab") args.push("--queue");
    if (options.submit === false) args.push("--no-submit");
    args.push("--text", prompt);
    return args;
  }

  sendPrompt(options: DispatchOptions, prompt: string): MosaicPromptResult {
    const args = this.buildPromptSendArgs(options, prompt);
    const result = this.run(args);
    if (result.exitCode !== 0) throw errorFromResult(result, "mosaic prompt send");
    return { receipt: parseJson(result.stdout, "mosaic prompt send") as MosaicPromptReceipt, argv: [this.bin, ...args] };
  }

  capture(target: string): string {
    const { session, paneId } = parseMosaicTarget(target);
    const payload = this.runJson(["--session", session, "capture", "--pane-id", paneId, "--scrollback"], "mosaic capture");
    return captureTextFromPayload(payload);
  }

  subscribeArgv(target: string, format: "ndjson" | "raw" = "ndjson"): string[] {
    const { session, paneId } = parseMosaicTarget(target);
    return [this.bin, "--session", session, "subscribe", "--pane-id", paneId, "--format", format];
  }
}

export interface MosaicDispatchDeps {
  mosaic: Mosaic;
  store?: Store;
}

export async function performMosaicDispatch(options: DispatchOptions, deps: MosaicDispatchDeps): Promise<DispatchRecord> {
  const { mosaic, store } = deps;
  const machine = mosaic.machine;
  const prompt = applyGoalPrefix(options.prompt, options.goal === true);
  const dryRun = options.dryRun === true;
  const { session, paneId } = parseMosaicTarget(options.target);

  let record: DispatchRecord = store
    ? store.createDispatch({ backend: "mosaic", target: options.target, machine, prompt, status: "sending", dryRun })
    : {
        id: genId(),
        kind: "prompt",
        backend: "mosaic",
        target: options.target,
        machine,
        prompt,
        status: "sending",
        dryRun,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

  const finish = (patch: Partial<DispatchRecord>): DispatchRecord => {
    record = { ...record, ...patch, updatedAt: nowIso() };
    if (store) {
      record = store.updateDispatch(record.id, {
        status: record.status,
        detail: record.detail,
        confirm: record.confirm,
        deliveredAt: record.deliveredAt,
        dryRun: record.dryRun,
        captureBefore: record.captureBefore,
        receipt: record.receipt,
      });
    }
    return record;
  };

  let captureBefore: CaptureResult | undefined;
  if (options.captureBeforeLines) {
    captureBefore = await performMosaicCapture({ target: options.target, backend: "mosaic", lines: options.captureBeforeLines }, { mosaic });
  }

  if (options.ifIdle === true && options.queue !== true && options.forceActive !== true) {
    return finish({
      status: "skipped",
      detail: "Mosaic backend cannot prove target idleness in this slice; omit --if-idle, pass --queue, or pass --force-active intentionally",
      captureBefore,
      dryRun,
    });
  }

  try {
    const { receipt } = mosaic.sendPrompt(options, prompt);
    let validated: ValidatedMosaicReceipt;
    try {
      validated = validateMosaicReceipt(receipt, { session, paneId });
    } catch (err) {
      return finish({
        status: "failed",
        detail: (err as Error).message,
        receipt,
        captureBefore,
      });
    }
    const queued = options.queue === true || options.submitKey === "Tab" || validated.queued;
    if (dryRun) {
      return finish({
        status: "skipped",
        detail: `dry run: mosaic accepted prompt.send validation${receipt.id ? ` receipt=${receipt.id}` : ""}`,
        dryRun: true,
        receipt,
        captureBefore,
      });
    }
    const reason = queued
      ? `mosaic accepted prompt.send as queued${receipt.id ? ` receipt=${receipt.id}` : ""}`
      : options.submit === false
        ? `mosaic accepted prompt without submitting${receipt.id ? ` receipt=${receipt.id}` : ""}`
        : `mosaic accepted prompt.send${receipt.id ? ` receipt=${receipt.id}` : ""}`;
    return finish({
      status: "delivered",
      detail: reason,
      confirm: { delivered: true, reason, queued: queued || undefined },
      deliveredAt: nowIso(),
      receipt,
      captureBefore,
    });
  } catch (err) {
    return finish({
      status: "failed",
      detail: err instanceof MosaicControlError ? err.message : `mosaic prompt send failed: ${(err as Error).message}`,
      captureBefore,
    });
  }
}

export interface MosaicCaptureDeps {
  mosaic: Mosaic;
}

export async function performMosaicCapture(options: CaptureOptions, deps: MosaicCaptureDeps): Promise<CaptureResult> {
  const { mosaic } = deps;
  const { requested, effective } = normalizeCaptureLines(options.lines);
  const base = {
    backend: "mosaic" as const,
    target: options.target,
    machine: mosaic.machine,
    requestedLines: requested,
    lines: effective,
    maxLines: MAX_CAPTURE_LINES,
    capturedAt: nowIso(),
    redacted: true,
  };

  try {
    const text = tailLines(stripTerminalControl(mosaic.capture(options.target)), effective);
    const result: CaptureResult = {
      ...base,
      status: "captured",
      text: redactSecrets(text),
    };
    if (options.ai?.enabled || options.ai?.transform || options.ai?.prompt) {
      result.ai = {
        status: "failed",
        provider: options.ai.provider ?? "none",
        transform: options.ai.transform,
        prompt: options.ai.prompt ? redactSecrets(options.ai.prompt) : undefined,
        detail: "AI transforms for Mosaic capture are not implemented in this backend slice; omit --ai or use the tmux backend.",
      };
    }
    return result;
  } catch (err) {
    return {
      ...base,
      status: "failed",
      lines: 0,
      text: "",
      detail: err instanceof MosaicControlError ? err.message : `mosaic capture failed: ${(err as Error).message}`,
    };
  }
}
