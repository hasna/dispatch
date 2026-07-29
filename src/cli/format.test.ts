import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRecoverResult,
  AgentTargetInfo,
  AgentTriageResult,
  BulkDispatchResult,
  CaptureResult,
  DispatchRecord,
  FleetSummaryResult,
  ScheduledDispatch,
} from "../types.js";
import {
  formatBulk,
  formatCapture,
  formatFleetSummary,
  formatRecord,
  formatRecordDetail,
  formatRecordList,
  formatRecover,
  formatSchedule,
  formatScheduleDetail,
  formatScheduleList,
  formatTriage,
  resolvePrompt,
  summarizeBulk,
  summarizeRecord,
  summarizeSchedule,
  truncateText,
} from "./format.js";

const detection: AgentTargetInfo = {
  targetKind: "agent",
  agentKind: "codewith",
  composerState: "idle",
  canReceivePrompt: true,
  canQueuePrompt: true,
  submitKeys: ["Enter", "Tab"],
  recommendedSubmitKey: "Enter",
  reason: "composer is ready",
};

function record(overrides: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    id: "dispatch-1",
    target: "work:1.0",
    machine: "local",
    prompt: "ship the change",
    status: "delivered",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:01:00.000Z",
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduledDispatch> = {}): ScheduledDispatch {
  return {
    id: "schedule-1",
    options: { target: "work:1.0", prompt: "check the queue" },
    at: "2026-07-30T10:00:00.000Z",
    nextRun: "2026-07-30T10:00:00.000Z",
    status: "scheduled",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:01:00.000Z",
    ...overrides,
  };
}

function triage(overrides: Partial<AgentTriageResult> = {}): AgentTriageResult {
  return {
    schemaVersion: "dispatch.agentTriage.v1",
    status: "ok",
    target: "work:1.0",
    machine: "local",
    generatedAt: "2026-07-29T10:00:00.000Z",
    detection,
    action: { kind: "send", submitKey: "Enter", safeToApply: true, reason: "ready" },
    capture: {
      status: "captured",
      requestedLines: 50,
      lines: 12,
      maxLines: 200,
      maxChars: 4_000,
      textLength: 120,
      truncatedChars: false,
      redacted: true,
      excerptChars: 220,
    },
    ...overrides,
  };
}

function bulk(records: DispatchRecord[] = [], overrides: Partial<BulkDispatchResult> = {}): BulkDispatchResult {
  return {
    status: "completed",
    source: "explicit",
    requested: records.length,
    planned: records.length,
    delivered: records.length,
    skipped: 0,
    failed: 0,
    dryRun: false,
    maxConcurrency: 2,
    jitterMs: 0,
    perMachineLimit: 1,
    records,
    ...overrides,
  };
}

describe("resolvePrompt", () => {
  test("honors source precedence and reads a prompt file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-format-"));
    const file = join(dir, "prompt.txt");
    writeFileSync(file, "from file");
    try {
      expect(resolvePrompt({ prompt: "inline", file }, "stdin")).toBe("inline");
      expect(resolvePrompt({ file }, "stdin")).toBe("from file");
      expect(resolvePrompt({}, "stdin")).toBe("stdin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects missing, blank, and unreadable prompt sources", () => {
    expect(() => resolvePrompt({})).toThrow("no prompt");
    expect(() => resolvePrompt({ prompt: " \n\t" })).toThrow("prompt is empty");
    expect(() => resolvePrompt({}, "")).toThrow("no prompt");
    expect(() => resolvePrompt({ file: "/definitely/missing/dispatch-prompt" })).toThrow();
  });
});

describe("text and record formatting", () => {
  test("truncateText normalizes whitespace and respects its truncation boundary", () => {
    expect(truncateText("  alpha\n\tbeta  ")).toBe("alpha beta");
    expect(truncateText("abcde", 5)).toBe("abcde");
    expect(truncateText("abcdef", 5)).toBe("abcd…");
    expect(truncateText("", 0)).toBe("");
    expect(truncateText("x", 0)).toBe("…");
  });

  test("summarizeRecord applies defaults, bounds text, and retains audit fields", () => {
    const rec = record({
      kind: undefined,
      machine: undefined as unknown as string,
      prompt: "one two three",
      detail: "detail words",
      deliveredAt: "2026-07-29T10:02:00.000Z",
      commandHash: "abc123",
      filter: {
        allowed: false,
        code: "DENIED",
        reason: "blocked",
        commandHash: "abc123",
        normalizedCommand: "rm file",
        targetKind: "shell",
      },
      targetState: "active",
    });

    expect(summarizeRecord(rec, { previewChars: 8 })).toEqual({
      id: "dispatch-1",
      kind: "prompt",
      status: "delivered",
      target: "work:1.0",
      machine: "local",
      promptPreview: "one two…",
      promptLength: 13,
      detailPreview: "detail …",
      detailLength: 12,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      deliveredAt: "2026-07-29T10:02:00.000Z",
      commandHash: "abc123",
      filterCode: "DENIED",
      targetState: "active",
    });
    expect(summarizeRecord(record()).detailPreview).toBeUndefined();
  });

  test("formatRecord distinguishes prompt, key, exec, remote, and unknown statuses", () => {
    expect(formatRecord(record())).toContain("✓ dispatch-1  delivered work:1.0");
    expect(formatRecord(record({ kind: "key", machine: "remote-1", status: "pending" }))).toContain(
      "· dispatch-1  pending   key remote-1/work:1.0",
    );
    const exec = formatRecord(
      record({
        kind: "exec",
        status: "failed",
        dryRun: true,
        commandHash: "beef",
        targetKind: "shell",
        filter: {
          allowed: true,
          code: "ALLOW",
          reason: "safe",
          commandHash: "beef",
          normalizedCommand: "git status",
          targetKind: "shell",
        },
        detail: "policy checked",
      }),
    );
    expect(exec).toContain("✗ dispatch-1  failed    exec dry-run sha=beef target=shell filter=ALLOW");
    expect(exec).toContain("— policy checked");
    expect(formatRecord(record({ status: "mystery" as DispatchRecord["status"] }))).toStartWith("?");
  });

  test("formatRecordDetail includes optional delivery, confirmation, detection, filter, and hash metadata", () => {
    const output = formatRecordDetail(
      record({
        deliveredAt: "2026-07-29T10:02:00.000Z",
        detail: "sent successfully",
        confirm: { delivered: true, reason: "composer cleared" },
        detection,
        commandHash: "beef",
        filter: {
          allowed: true,
          code: "ALLOW",
          reason: "safe",
          commandHash: "beef",
          normalizedCommand: "git status",
          targetKind: "shell",
        },
      }),
    );
    expect(output).toContain("delivered: 2026-07-29T10:02:00.000Z");
    expect(output).toContain("confirm: delivered=true reason=composer cleared");
    expect(output).toContain("detection: codewith/idle canReceive=true canQueue=true");
    expect(output).toContain("filter: ALLOW allowed=true rule=none");
    expect(output).toContain("commandHash: beef");
    expect(formatRecordDetail(record())).not.toContain("confirm:");
  });

  test("formatRecordList handles empty, compact, and verbose lists", () => {
    expect(formatRecordList([])).toBe("no dispatches yet");
    expect(formatRecordList([record()], { limit: 1, hasMore: true })).toContain("limit 1; more available");
    const verbose = formatRecordList([record()], { verbose: true });
    expect(verbose).toContain("kind: prompt");
    expect(verbose).toContain("prompt: \"ship the change\"");
  });
});

describe("capture and recovery formatting", () => {
  test("formatCapture reports failures and appends completed or failed AI transforms", () => {
    const failed: CaptureResult = {
      status: "failed",
      target: "work:1.0",
      machine: "local",
      requestedLines: 20,
      lines: 0,
      maxLines: 200,
      capturedAt: "2026-07-29T10:00:00.000Z",
      text: "",
      redacted: true,
    };
    expect(formatCapture(failed)).toBe("✗ capture failed for work:1.0 — unknown error");

    const captured = { ...failed, status: "captured" as const, text: "pane text" };
    expect(formatCapture(captured)).toBe("pane text");
    expect(
      formatCapture({
        ...captured,
        ai: { status: "completed", provider: "openai", model: "gpt-test", transform: "summary", text: "short" },
      }),
    ).toContain("--- AI summary (openai/gpt-test) ---\nshort");
    expect(
      formatCapture({ ...captured, ai: { status: "failed", provider: "groq", detail: "provider unavailable" } }),
    ).toContain("--- AI custom (groq) failed ---\nprovider unavailable");
  });

  test("formatTriage renders actionable metadata and safe unknown fallbacks", () => {
    const rich = formatTriage(
      triage({
        status: "blocked",
        action: { kind: "queue", submitKey: "Tab", safeToApply: false, reason: "busy" },
        detail: "target is active",
        capture: {
          ...triage().capture,
          truncatedChars: true,
          excerpt: "recent pane output",
          artifact: { path: "triage.txt", bytes: 120, lines: 12, redacted: true },
        },
      }),
    );
    expect(rich).toContain("↷ triage work:1.0  action=queue/Tab");
    expect(rich).toContain("truncated artifact=triage.txt");
    expect(rich).toContain("detail: target is active");
    expect(rich).toContain("excerpt: \"recent pane output\"");

    const fallback = formatTriage(triage({ status: "failed", detection: undefined, machine: "remote" }));
    expect(fallback).toContain("✗ triage remote/work:1.0");
    expect(fallback).toContain("target: unknown/unknown state=unknown receive=false queue=false");
  });

  test("formatRecover distinguishes applied, planned, and refused outcomes", () => {
    const applied: AgentRecoverResult = {
      schemaVersion: "dispatch.agentRecover.v1",
      status: "applied",
      target: "work:1.0",
      machine: "local",
      dryRun: false,
      generatedAt: "2026-07-29T10:00:00.000Z",
      promptPreview: "continue safely",
      promptLength: 15,
      triage: triage(),
      action: { kind: "send", submitKey: "Enter", safeToApply: true, reason: "ready" },
      dispatch: { id: "dispatch-2", status: "delivered", detail: "accepted" },
      detail: "recovery sent",
    };
    const output = formatRecover(applied);
    expect(output).toContain("✓ recover work:1.0  applied action=send/Enter");
    expect(output).toContain("dispatch: dispatch-2 delivered - accepted");
    expect(output).toContain("detail: recovery sent");
    expect(output).toContain("hint: use --json");

    expect(formatRecover({ ...applied, status: "planned", dryRun: true, dispatch: undefined })).toContain(
      "↷ recover work:1.0  planned dry-run",
    );
    expect(formatRecover({ ...applied, status: "refused", triage: triage({ detection: undefined }) })).toContain(
      "✗ recover work:1.0  refused",
    );
  });
});

describe("bulk and fleet formatting", () => {
  test("formatBulk limits displayed records and reports failed dry runs", () => {
    const records = Array.from({ length: 21 }, (_, index) => record({ id: `dispatch-${index}` }));
    const output = formatBulk(
      bulk(records, { status: "failed", delivered: 0, failed: 21, dryRun: true, detail: "validation failed" }),
    );
    expect(output).toStartWith("✗ bulk explicit requested=21 planned=21 delivered=0 skipped=0 failed=21 dry-run");
    expect(output).toContain("validation failed");
    expect(output).toContain("dispatch-19");
    expect(output).not.toContain("dispatch-20");
    expect(output).toContain("… 1 more record(s) omitted");
    expect(formatBulk(bulk())).toContain("✓ bulk explicit requested=0");
  });

  test("summarizeBulk returns compact counts and optional bounded detail", () => {
    const records = Array.from({ length: 21 }, (_, index) => record({ id: `dispatch-${index}` }));
    const summary = summarizeBulk(bulk(records, { detail: "x".repeat(100) }));
    expect(summary).toMatchObject({
      recordCount: 21,
      shownRecords: 20,
      omittedRecords: 1,
      detailLength: 100,
      compact: true,
    });
    expect(summary.detailPreview).toHaveLength(80);
    expect(summary.records).toHaveLength(20);
    expect(summarizeBulk(bulk())).toMatchObject({ shownRecords: 0, omittedRecords: 0, detailPreview: undefined });
  });

  test("formatFleetSummary renders preflight, item fallbacks, excerpts, and omissions", () => {
    const result: FleetSummaryResult = {
      schemaVersion: "dispatch.fleet_summary.v1",
      status: "completed",
      machine: "local",
      generatedAt: "2026-07-29T10:00:00.000Z",
      targetGlobs: ["*"],
      limit: 2,
      maxLimit: 100,
      requestedMaxPaneChars: 500,
      maxPaneChars: 500,
      maxAllowedPaneChars: 4_000,
      totalTargets: 3,
      matchedTargets: 3,
      inspectedTargets: 2,
      omittedTargets: 1,
      totals: { working: 0, idle: 1, stuck: 0, error: 1, blocked: 0 },
      preflight: { ok: false, provider: "openai", model: "gpt-test", detail: "missing key" },
      detail: "classification incomplete",
      items: [
        {
          backend: "tmux",
          target: "work:1.0",
          machine: "local",
          window: "agent",
          active: true,
          detection,
          classification: { state: "idle", uncertainty: "low", reasons: ["composer ready"] },
          excerpt: "ready prompt",
          excerptChars: 12,
          excerptTruncated: true,
        },
        {
          backend: "tmux",
          target: "work:2.0",
          machine: "local",
          window: "unknown",
          active: false,
          classification: { state: "error", uncertainty: "high", reasons: [] },
          excerpt: "",
          excerptChars: 0,
          excerptTruncated: false,
        },
      ],
      compact: true,
    };

    const output = formatFleetSummary(result);
    expect(output).toContain("OK fleet summary machine=local matched=3 inspected=2 limit=2 maxPaneChars=500");
    expect(output).toContain("preflight ai=failed provider=openai model=gpt-test detail=missing key");
    expect(output).toContain("codewith/idle receive=true queue=true reason=composer ready");
    expect(output).toContain('excerpt: "ready prompt" (truncated)');
    expect(output).toContain("unknown/unknown receive=false queue=false reason=");
    expect(output).toContain("... 1 matched target(s) omitted by limit");
    expect(formatFleetSummary({ ...result, status: "failed", items: [], omittedTargets: 0 })).toStartWith("FAIL");
  });
});

describe("schedule formatting", () => {
  test("summarizeSchedule covers every cadence and kind fallback", () => {
    expect(summarizeSchedule(schedule())).toMatchObject({ kind: "schedule", cadence: "at 2026-07-30T10:00:00.000Z" });
    expect(summarizeSchedule(schedule({ cron: "*/5 * * * *", at: undefined })).cadence).toBe("cron(*/5 * * * *)");
    expect(summarizeSchedule(schedule({ intervalMs: 5_000, at: undefined }))).toMatchObject({
      kind: "loop",
      cadence: "every(5000ms)",
    });
    const named = summarizeSchedule(
      schedule({
        kind: "loop",
        name: "poller",
        every: "5m",
        intervalMs: 300_000,
        at: undefined,
        options: { target: "work:1.0", machine: "remote", prompt: "one two three" },
        lastFailureReason: "timeout waiting",
        failureCount: 2,
      }),
      { previewChars: 8 },
    );
    expect(named).toMatchObject({
      kind: "loop",
      name: "poller",
      machine: "remote",
      cadence: "every(5m)",
      promptPreview: "one two…",
      lastFailureReasonPreview: "timeout…",
      lastFailureReasonLength: 15,
      failureCount: 2,
    });
  });

  test("formatSchedule includes names, remote location, failures, and fallback icons", () => {
    const output = formatSchedule(
      schedule({
        kind: "loop",
        name: "poller",
        every: "5m",
        intervalMs: 300_000,
        at: undefined,
        options: { target: "work:1.0", machine: "remote", prompt: "poll" },
        status: "paused",
        lastFailureAt: "2026-07-29T09:00:00.000Z",
        failureCount: 3,
      }),
    );
    expect(output).toContain("‖ schedule-1  paused    loop:poller every(5m)");
    expect(output).toContain("failure=3  remote/work:1.0");
    expect(formatSchedule(schedule({ status: "mystery" as ScheduledDispatch["status"] }))).toStartWith("⧗");
  });

  test("formatScheduleDetail includes all optional history metadata", () => {
    const output = formatScheduleDetail(
      schedule({
        name: "nightly",
        lastDispatchId: "dispatch-9",
        lastFiredAt: "2026-07-29T08:00:00.000Z",
        lastFailureAt: "2026-07-29T09:00:00.000Z",
        lastFailureReason: "timeout",
        failureCount: 2,
      }),
    );
    expect(output).toContain("name: nightly");
    expect(output).toContain("lastDispatchId: dispatch-9");
    expect(output).toContain("lastFiredAt: 2026-07-29T08:00:00.000Z");
    expect(output).toContain("lastFailureReason: timeout (7 chars");
    expect(output).toContain("failureCount: 2");
    expect(formatScheduleDetail(schedule())).not.toContain("lastDispatchId:");
  });

  test("formatScheduleList handles empty labels, limits, and verbose rows", () => {
    expect(formatScheduleList([], { label: "loops" })).toBe("no loops");
    expect(formatScheduleList([schedule()], { label: "loops", limit: 1, hasMore: true })).toContain(
      "loops: showing 1 (limit 1; more available)",
    );
    const verbose = formatScheduleList([schedule()], { verbose: true });
    expect(verbose).toContain("kind: schedule");
    expect(verbose).toContain("cadence: at 2026-07-30T10:00:00.000Z");
  });
});
