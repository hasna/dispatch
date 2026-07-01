import { describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProgram, parseIntegerOption } from "./index.js";
import {
  formatBulk,
  formatRecord,
  formatRecordDetail,
  formatRecordList,
  formatSchedule,
  formatScheduleDetail,
  resolvePrompt,
  summarizeBulk,
  summarizeRecord,
  summarizeSchedule,
} from "./format.js";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";
import { MockRunner } from "../test/mock-runner.js";
import { SELF_HEAL_MAX_DISPLAY_CHARS } from "../lib/self-heal.js";
import type {
  BulkDispatchOptions,
  BulkDispatchResult,
  CaptureOptions,
  DispatchOptions,
  DispatchRecord,
  ExecOptions,
  KeyOptions,
} from "../types.js";

describe("resolvePrompt", () => {
  test("prefers --prompt", () => {
    expect(resolvePrompt({ prompt: "inline", file: "/nope" })).toBe("inline");
  });
  test("reads --file", () => {
    const f = join(tmpdir(), `dispatch_prompt_${process.pid}.txt`);
    writeFileSync(f, "from file");
    expect(resolvePrompt({ file: f })).toBe("from file");
    rmSync(f);
  });
  test("falls back to stdin", () => {
    expect(resolvePrompt({}, "piped prompt")).toBe("piped prompt");
  });
  test("throws when no source", () => {
    expect(() => resolvePrompt({})).toThrow(/no prompt/);
  });
  test("throws on an empty / whitespace-only prompt (e.g. empty file)", () => {
    expect(() => resolvePrompt({ prompt: "" })).toThrow(/empty/);
    expect(() => resolvePrompt({ prompt: "   \n\t " })).toThrow(/empty/);
    expect(() => resolvePrompt({}, "   ")).toThrow(/empty|no prompt/);
  });
});

describe("formatters", () => {
  test("formatRecord shows icon, id, status, target, preview", () => {
    const line = formatRecord({
      id: "abc123abc123",
      target: "work:agent",
      machine: "local",
      prompt: "do the thing",
      status: "delivered",
      detail: "working detected",
      createdAt: "x",
      updatedAt: "x",
    });
    expect(line).toContain("✓");
    expect(line).toContain("abc123abc123");
    expect(line).toContain("work:agent");
    expect(line).toContain("do the thing");
  });
  test("formatRecord truncates long prompts in compact output", () => {
    const prompt = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const line = formatRecord({
      id: "long123",
      target: "work:agent",
      machine: "local",
      prompt,
      status: "delivered",
      createdAt: "x",
      updatedAt: "x",
    });
    expect(line).toContain("word0");
    expect(line).toContain("…");
    expect(line).not.toContain("word39");
  });
  test("detail output still caps prompt text and points to JSON for the full object", () => {
    const prompt = `${"a".repeat(650)} TAIL_MARKER`;
    const detail = formatRecordDetail({
      id: "detail123",
      target: "work:agent",
      machine: "local",
      prompt,
      status: "delivered",
      createdAt: "x",
      updatedAt: "x",
    });
    expect(detail).toContain("prompt:");
    expect(detail).toContain("use --json for the full stored prompt/object");
    expect(detail).not.toContain("TAIL_MARKER");
  });
  test("compact outputs truncate free-text detail and failure fields", () => {
    const detail = `${"failure detail ".repeat(80)}DETAIL_TAIL`;
    const rec = {
      id: "detail-row",
      target: "work:agent",
      machine: "local",
      prompt: "short",
      detail,
      status: "failed" as const,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(formatRecord(rec)).not.toContain("DETAIL_TAIL");
    expect(formatRecordDetail(rec)).not.toContain("DETAIL_TAIL");
    expect(summarizeRecord(rec)).toMatchObject({ detailLength: detail.length });
    expect(summarizeRecord(rec).detailPreview).not.toContain("DETAIL_TAIL");

    const failureReason = `${"schedule failure ".repeat(80)}FAILURE_TAIL`;
    const sched = {
      id: "sched-detail",
      options: { target: "work:agent", prompt: "poll" },
      every: "5m",
      intervalMs: 5 * 60_000,
      nextRun: "2026-06-17T10:05:00.000Z",
      status: "scheduled" as const,
      lastFailureAt: "x",
      lastFailureReason: failureReason,
      createdAt: "x",
      updatedAt: "x",
    };
    expect(formatScheduleDetail(sched)).not.toContain("FAILURE_TAIL");
    expect(summarizeSchedule(sched)).toMatchObject({ lastFailureReasonLength: failureReason.length });
    expect(summarizeSchedule(sched).lastFailureReasonPreview).not.toContain("FAILURE_TAIL");
  });
  test("record lists include a compact hint instead of dumping full prompts", () => {
    const longPrompt = `${Array.from({ length: 80 }, (_, i) => `token${i}`).join(" ")} END_MARKER`;
    const output = formatRecordList(
      [
        {
          id: "list123",
          target: "work:agent",
          machine: "local",
          prompt: longPrompt,
          status: "delivered",
          createdAt: "x",
          updatedAt: "x",
        },
      ],
      { limit: 20 },
    );
    expect(output).toContain("dispatches: showing 1 (limit 20)");
    expect(output).toContain("dispatch show <id>");
    expect(output).not.toContain("END_MARKER");
  });
  test("bulk summaries cap record rows", () => {
    const detail = `${"bulk detail ".repeat(120)}BULK_TAIL`;
    const result = {
      status: "completed",
      source: "explicit",
      requested: 25,
      planned: 25,
      delivered: 25,
      skipped: 0,
      failed: 0,
      dryRun: false,
      maxConcurrency: 1,
      jitterMs: 0,
      perMachineLimit: 1,
      detail,
      records: Array.from({ length: 25 }, (_, i) => ({
        id: `bulk-${i}`,
        target: `s:${i}`,
        machine: "local",
        prompt: `prompt ${i}`,
        status: "delivered" as const,
        createdAt: "x",
        updatedAt: "x",
      })),
    } satisfies BulkDispatchResult;
    const output = formatBulk(result);
    expect(output).toContain("bulk-19");
    expect(output).not.toContain("bulk-20");
    expect(output).toContain("5 more record(s) omitted");
    expect(output).toContain("use --json for full records");
    expect(output).not.toContain("BULK_TAIL");
    expect(summarizeBulk(result)).toMatchObject({ detailLength: detail.length, omittedRecords: 5 });
    expect(summarizeBulk(result).detailPreview).not.toContain("BULK_TAIL");
  });
  test("formatSchedule shows cron and next run", () => {
    const line = formatSchedule({
      id: "s1",
      options: { target: "work:agent", prompt: "later" },
      cron: "*/5 * * * *",
      nextRun: "2026-06-17T10:05:00.000Z",
      status: "scheduled",
      createdAt: "x",
      updatedAt: "x",
    });
    expect(line).toContain("cron(*/5 * * * *)");
    expect(line).toContain("2026-06-17T10:05:00.000Z");
  });

  test("formatSchedule shows named loops", () => {
    const line = formatSchedule({
      id: "loop1",
      kind: "loop",
      name: "poller",
      options: { target: "work:agent", prompt: "poll" },
      every: "5m",
      intervalMs: 5 * 60_000,
      nextRun: "2026-06-17T10:05:00.000Z",
      status: "paused",
      createdAt: "x",
      updatedAt: "x",
    });
    expect(line).toContain("paused");
    expect(line).toContain("loop:poller");
    expect(line).toContain("every(5m)");
  });
});

function runner() {
  const store = new Store(":memory:");
  const client = new DispatchClient({ store });
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    clientFactory: () => client,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { store, client, out, err, program };
}

const codewithComposerCapture = `
╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (v0.1.42)                             │
│ model:       gpt-5.5 xhigh   fast   /model to change    │
│ directory:   ~/workspace/hasna/opensource/open-dispatch │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
› Fix native chat
`;

describe("CLI read/schedule commands (in-memory client)", () => {
  test("status: found and not-found", async () => {
    const { store, program, out, err } = runner();
    const rec = store.createDispatch({ target: "s:w", prompt: "hi", status: "delivered" });
    await program.parseAsync(["status", rec.id], { from: "user" });
    expect(out.join("\n")).toContain(rec.id);
    expect(out.join("\n")).toContain("dispatch show");

    process.exitCode = 0;
    await program.parseAsync(["status", "missing"], { from: "user" });
    expect(err.join("\n")).toMatch(/not found/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("show prints expanded details without requiring raw JSON", async () => {
    const { store, program, out } = runner();
    const rec = store.createDispatch({ target: "s:w", prompt: "hi", status: "delivered" });
    await program.parseAsync(["show", rec.id], { from: "user" });
    expect(out.join("\n")).toContain("kind: prompt");
    expect(out.join("\n")).toContain("prompt: \"hi\"");
  });

  test("list defaults to compact capped output while --json preserves the historical default limit", async () => {
    const { store, program, out } = runner();
    for (let i = 0; i < 25; i += 1) {
      store.createDispatch({
        target: "s:w",
        prompt: `dispatch ${i} ${"x".repeat(120)} END_MARKER_${i}`,
        status: "delivered",
      });
    }

    await program.parseAsync(["list"], { from: "user" });
    const compact = out.join("\n");
    expect(compact).toContain("dispatches: showing 20 (limit 20; more available)");
    expect(compact).toContain("dispatch show <id>");
    expect(compact).not.toContain("END_MARKER_");
    out.length = 0;

    await program.parseAsync(["list", "--json"], { from: "user" });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveLength(20);
    out.length = 0;

    await program.parseAsync(["list", "--limit", "25", "--json"], { from: "user" });
    const expanded = JSON.parse(out.join("\n"));
    expect(expanded).toHaveLength(25);
    expect(expanded.some((row: { prompt: string }) => row.prompt.includes("END_MARKER_24"))).toBe(true);
  });

  test("list --json returns recorded dispatches", async () => {
    const { store, program, out } = runner();
    store.createDispatch({ target: "s:w", prompt: "a", status: "delivered" });
    store.createDispatch({ target: "s:w", prompt: "b", status: "failed" });
    await program.parseAsync(["list", "--json"], { from: "user" });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveLength(2);
  });

  test("schedule then schedules then cancel", async () => {
    const { program, out } = runner();
    await program.parseAsync(
      ["schedule", "--to", "work:agent", "--prompt", "later", "--cron", "*/5 * * * *", "--json"],
      { from: "user" },
    );
    const sched = JSON.parse(out.join("\n"));
    expect(sched.status).toBe("scheduled");
    out.length = 0;

    await program.parseAsync(["schedules", "--json"], { from: "user" });
    expect(JSON.parse(out.join("\n"))).toHaveLength(1);
    out.length = 0;

    await program.parseAsync(["cancel", sched.id], { from: "user" });
    expect(out.join("\n")).toContain("cancelled");
  });

  test("schedule --in creates a relative one-shot", async () => {
    const { program, out } = runner();
    await program.parseAsync(
      ["schedule", "--to", "work:agent", "--prompt", "later", "--in", "30m", "--name", "reminder", "--json"],
      { from: "user" },
    );
    const sched = JSON.parse(out.join("\n"));
    expect(sched.status).toBe("scheduled");
    expect(sched.name).toBe("reminder");
    expect(sched.at).toBeDefined();
    expect(sched.cron).toBeUndefined();
  });

  test("loop command creates, lists, inspects, pauses, resumes, and clears", async () => {
    const { program, out } = runner();
    await program.parseAsync(
      ["loop", "--to", "work:agent", "--prompt", "check status", "--every", "5m", "--name", "status-loop", "--json"],
      { from: "user" },
    );
    const loop = JSON.parse(out.join("\n"));
    expect(loop).toMatchObject({ status: "scheduled", kind: "loop", name: "status-loop", every: "5m" });
    out.length = 0;

    await program.parseAsync(["loops", "--json"], { from: "user" });
    expect(JSON.parse(out.join("\n"))).toHaveLength(1);
    out.length = 0;

    await program.parseAsync(["status", loop.id, "--json"], { from: "user" });
    expect(JSON.parse(out.join("\n")).kind).toBe("loop");
    out.length = 0;

    await program.parseAsync(["pause", loop.id], { from: "user" });
    expect(out.join("\n")).toContain("paused");
    out.length = 0;

    await program.parseAsync(["resume", loop.id], { from: "user" });
    expect(out.join("\n")).toContain("resumed");
    out.length = 0;

    await program.parseAsync(["clear", loop.id], { from: "user" });
    expect(out.join("\n")).toContain("cleared");
  });

  test("targets --json reports bounded wrapper detection for Codewith and refuses arbitrary node", async () => {
    const out: string[] = [];
    const r = new MockRunner();
    r.responder = (argv) => {
      if (argv[1] === "list-panes") {
        return {
          stdout: ["work:1.0\tcodewith\t1\tnode\t/repo\t1111", "work:2.0\tserver\t0\tnode\t/srv\t2222"].join("\n"),
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      if (argv[1] === "capture-pane") {
        const target = argv[argv.indexOf("-t") + 1];
        return {
          stdout: target === "work:1.0" ? codewithComposerCapture : "node server.js\nListening\n",
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      if (argv[0] === "sh" && argv[2]?.includes("ps -o pid=,ppid=,stat=,command=")) {
        const pid = argv[4];
        return {
          stdout:
            pid === "1111"
              ? "1111 1 Sl+ node --max-old-space-size=6144 /home/hasna/.bun/bin/codewith --auth-profile account005\n"
              : "2222 1 Sl+ node /srv/server.js codewith\n",
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };
    const program = buildProgram({
      runnerFactory: async () => r,
      out: (s) => out.push(s),
    });

    await program.parseAsync(["targets", "--json"], { from: "user" });

    const targets = JSON.parse(out.join("\n"));
    expect(targets.find((t: { target: string }) => t.target === "work:1.0").detection).toMatchObject({
      agentKind: "codewith",
      canReceivePrompt: true,
    });
    expect(targets.find((t: { target: string }) => t.target === "work:2.0").detection).toMatchObject({
      agentKind: "unknown",
      canReceivePrompt: false,
    });
    expect(r.argvs().some((a) => a[0] === "ps")).toBe(false);
    expect(r.argvs().some((a) => a[0] === "sh" && a[2]?.includes("head -n") && a[2]?.includes("cut -c"))).toBe(true);
  });

  test("self-heal diagnose emits redacted read-only JSON guidance", async () => {
    const { program, out } = runner();
    const apiKey = "sk-" + "proj-" + "secret";

    await program.parseAsync(
      [
        "self-heal",
        "diagnose",
        "--to",
        "work:agent",
        "--machine",
        "spark01",
        "--route",
        "sessions-query:open-router",
        "--error",
        `unknown option --from with Authorization: Bearer ${apiKey}`,
        "--json",
      ],
      { from: "user" },
    );

    const diagnosis = JSON.parse(out.join("\n"));
    expect(diagnosis).toMatchObject({
      dryRun: true,
      mutates: false,
      category: "stale_package",
      fallbackPolicy: { tmuxPasteFallbackAllowed: false },
    });
    expect(JSON.stringify(diagnosis)).not.toContain(apiKey);
    expect(diagnosis.fallbackPolicy.detail).toMatch(/tmux prompt paste fallback is forbidden/i);
    expect(diagnosis.affectedMachineChecks.check).toEqual(["spark01", "spark02", "apple03"]);
  });

  test("self-heal diagnose bounds oversized file evidence without echoing the tail", async () => {
    const { program, out } = runner();
    const tailPayload = "CLI_TAIL_PAYLOAD_SHOULD_NOT_BE_RETURNED";
    const file = join(tmpdir(), `dispatch_self_heal_${process.pid}.txt`);
    writeFileSync(file, ["large prompt body", "x".repeat(12000), `dispatch: unknown option --from ${tailPayload}`].join("\n"));
    try {
      await program.parseAsync(["self-heal", "diagnose", "--error-file", file, "--json"], { from: "user" });
    } finally {
      rmSync(file, { force: true });
    }

    const diagnosis = JSON.parse(out.join("\n"));
    expect(diagnosis.category).toBe("stale_package");
    expect(diagnosis.redacted.errorText).toContain("self-heal redacted text truncated");
    expect(diagnosis.redacted.errorText.length).toBeLessThanOrEqual(SELF_HEAL_MAX_DISPLAY_CHARS);
    expect(JSON.stringify(diagnosis)).not.toContain(tailPayload);
    expect(diagnosis.inputLimits.fields.errorText.truncatedForDisplay).toBe(true);
  });

  test("loops defaults to compact capped output", async () => {
    const { store, program, out } = runner();
    for (let i = 0; i < 25; i += 1) {
      store.createSchedule({
        kind: "loop",
        name: `loop-${i}`,
        options: { target: "s:w", prompt: `poll ${i} ${"x".repeat(120)} END_MARKER_${i}` },
        every: "5m",
        intervalMs: 5 * 60_000,
        nextRun: `2099-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }

    await program.parseAsync(["loops"], { from: "user" });
    const compact = out.join("\n");
    expect(compact).toContain("dispatch loops: showing 20 (limit 20; more available)");
    expect(compact).toContain("dispatch show <id>");
    expect(compact).not.toContain("END_MARKER_");
    out.length = 0;

    await program.parseAsync(["loops", "--limit", "25", "--json"], { from: "user" });
    expect(JSON.parse(out.join("\n"))).toHaveLength(25);
  });

  test("schedule rejects missing timing mode and invalid combinations", async () => {
    const { program } = runner();
    await expect(
      program.parseAsync(["schedule", "--to", "s:w", "--prompt", "x"], { from: "user" }),
    ).rejects.toThrow(/exactly one/);
    await expect(
      program.parseAsync(["schedule", "--to", "s:w", "--prompt", "x", "--in", "30m", "--cron", "* * * * *"], {
        from: "user",
      }),
    ).rejects.toThrow(/exactly one/);
  });

  test("exec --dry-run prints the exact paste plan", async () => {
    const out: string[] = [];
    let received: ExecOptions | undefined;
    const fakeClient = {
      exec: async (opts: ExecOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "exec123",
          kind: "exec",
          target: opts.target,
          machine: "local",
          prompt: opts.command,
          status: "skipped",
          detail: "dry run: command would be submitted",
          commandHash: "0123456789abcdef",
          targetKind: "shell",
          dryRun: true,
          filter: {
            allowed: true,
            code: "allowed_prefix",
            reason: "command prefix is allowlisted",
            commandHash: "0123456789abcdef",
            normalizedCommand: opts.command,
            targetKind: "shell",
            matchedRule: "mailery status",
          },
          execPlan: { interrupt: false, pasteText: opts.command, submitKey: "Enter" },
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({
      clientFactory: () => fakeClient,
      out: (s) => out.push(s),
    });

    await program.parseAsync(["exec", "--to", "open-mailery:01", "--command", "mailery status", "--dry-run"], {
      from: "user",
    });

    expect(received).toMatchObject({ target: "open-mailery:01", command: "mailery status", dryRun: true });
    expect(out.join("\n")).toContain("would paste: \"mailery status\"");
    expect(out.join("\n")).toContain("would send key: Enter");
  });

  test("send --goal delegates goal mode with inline prompts", async () => {
    const out: string[] = [];
    let received: DispatchOptions | undefined;
    const fakeClient = {
      send: async (opts: DispatchOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "send-goal",
          kind: "prompt",
          target: opts.target,
          machine: "local",
          prompt: "/goal Fix native chat",
          status: "delivered",
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: (s) => out.push(s) });

    await program.parseAsync(["send", "--to", "open-browser:1.1", "--prompt", "Fix native chat", "--goal", "--json"], {
      from: "user",
    });

    expect(received).toMatchObject({ target: "open-browser:1.1", prompt: "Fix native chat", goal: true });
    expect(JSON.parse(out.join("\n")).prompt).toBe("/goal Fix native chat");
  });

  test("send --goal works with --file input", async () => {
    const f = join(tmpdir(), `dispatch_goal_prompt_${process.pid}.txt`);
    writeFileSync(f, "Line one\nLine two");
    let received: DispatchOptions | undefined;
    const fakeClient = {
      send: async (opts: DispatchOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "send-goal-file",
          kind: "prompt",
          target: opts.target,
          machine: "local",
          prompt: `/goal ${opts.prompt}`,
          status: "delivered",
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: () => undefined });

    try {
      await program.parseAsync(["send", "--to", "open-browser:1.1", "--file", f, "--goal"], { from: "user" });
      expect(received).toMatchObject({ prompt: "Line one\nLine two", goal: true });
    } finally {
      rmSync(f, { force: true });
    }
  });

  test("send --backend mosaic forwards backend and prompt file path", async () => {
    const f = join(tmpdir(), `dispatch_mosaic_prompt_${process.pid}.txt`);
    writeFileSync(f, "Mosaic prompt");
    let received: DispatchOptions | undefined;
    const fakeClient = {
      send: async (opts: DispatchOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "send-mosaic",
          kind: "prompt",
          backend: "mosaic",
          target: opts.target,
          machine: "local",
          prompt: opts.prompt,
          status: "skipped",
          dryRun: true,
          detail: "dry run",
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: () => undefined });

    try {
      await program.parseAsync(["send", "--backend", "mosaic", "--to", "work:terminal_1", "--file", f, "--dry-run"], {
        from: "user",
      });
      expect(received).toMatchObject({
        backend: "mosaic",
        target: "work:terminal_1",
        prompt: "Mosaic prompt",
        promptFile: f,
        dryRun: true,
      });
    } finally {
      rmSync(f, { force: true });
      process.exitCode = 0;
    }
  });

  test("send forwards idle guard, dry-run, and capture-before options", async () => {
    let received: DispatchOptions | undefined;
    const fakeClient = {
      send: async (opts: DispatchOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "send-guard",
          kind: "prompt",
          target: opts.target,
          machine: "local",
          prompt: opts.prompt,
          status: "skipped",
          dryRun: opts.dryRun,
          targetState: "active",
          detail: "target is active; refusing because --if-idle was requested",
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: () => undefined });

    process.exitCode = 0;
    await program.parseAsync(
      [
        "send",
        "--to",
        "open-sessions:2.1",
        "--prompt",
        "Inspect",
        "--if-idle",
        "--dry-run",
        "--capture-before",
        "80",
        "--json",
      ],
      { from: "user" },
    );

    expect(received).toMatchObject({
      target: "open-sessions:2.1",
      prompt: "Inspect",
      ifIdle: true,
      dryRun: true,
      captureBeforeLines: 80,
    });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("send dry-run plans exit successfully when the target would be used", async () => {
    let received: DispatchOptions | undefined;
    const fakeClient = {
      send: async (opts: DispatchOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "send-dry-plan",
          kind: "prompt",
          target: opts.target,
          machine: "local",
          prompt: opts.prompt,
          status: "skipped",
          dryRun: true,
          detail: "dry run: prompt would be submitted using literal delivery",
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: () => undefined });

    process.exitCode = 0;
    await program.parseAsync(["send", "--to", "work:agent", "--prompt", "Inspect", "--dry-run"], { from: "user" });

    expect(received).toMatchObject({ target: "work:agent", dryRun: true });
    expect(process.exitCode).toBe(0);
  });

  test("send --submit-key delegates Enter/Tab selection", async () => {
    let received: DispatchOptions | undefined;
    const fakeClient = {
      send: async (opts: DispatchOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "send-tab",
          kind: "prompt",
          target: opts.target,
          machine: "local",
          prompt: opts.prompt,
          status: "skipped",
          dryRun: true,
          detail: "dry run: prompt would be submitted with Tab using literal delivery",
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: () => undefined });

    await program.parseAsync(
      ["send", "--to", "work:agent", "--prompt", "Queue me", "--submit-key", "Tab", "--dry-run"],
      { from: "user" },
    );

    expect(received).toMatchObject({ target: "work:agent", submitKey: "Tab", dryRun: true });
  });

  test("send --from sessions-query delegates bulk-safe defaults", async () => {
    const out: string[] = [];
    let received: BulkDispatchOptions | undefined;
    const fakeClient = {
      bulkSend: async (opts: BulkDispatchOptions): Promise<BulkDispatchResult> => {
        received = opts;
        return {
          status: "completed",
          source: "sessions-query",
          requested: 1,
          planned: 1,
          delivered: 0,
          skipped: 1,
          failed: 0,
          dryRun: true,
          maxConcurrency: 3,
          jitterMs: 25,
          perMachineLimit: 1,
          records: [],
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: (s) => out.push(s) });

    await program.parseAsync(
      [
        "send",
        "--from",
        "sessions-query",
        "--sessions-query",
        "open-router",
        "--prompt",
        "Fix native chat",
        "--goal",
        "--dry-run",
        "--max-concurrency",
        "3",
        "--jitter",
        "25",
        "--per-machine-limit",
        "1",
        "--json",
      ],
      { from: "user" },
    );

    expect(received).toMatchObject({
      source: "sessions-query",
      sessionsQuery: "open-router",
      prompt: "Fix native chat",
      goal: true,
      ifIdle: true,
      submitKey: undefined,
      dryRun: true,
      maxConcurrency: 3,
      jitterMs: 25,
      perMachineLimit: 1,
    });
    expect(JSON.parse(out.join("\n"))).toMatchObject({ source: "sessions-query", dryRun: true });
  });

  test("comma-separated --to targets use explicit bulk dispatch", async () => {
    let received: BulkDispatchOptions | undefined;
    const fakeClient = {
      bulkSend: async (opts: BulkDispatchOptions): Promise<BulkDispatchResult> => {
        received = opts;
        return {
          status: "completed",
          source: "explicit",
          requested: 2,
          planned: 2,
          delivered: 2,
          skipped: 0,
          failed: 0,
          dryRun: false,
          maxConcurrency: 1,
          jitterMs: 0,
          perMachineLimit: 1,
          records: [],
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: () => undefined });

    await program.parseAsync(["send", "--to", "open-a:1.1,open-b:1.1", "--prompt", "Bulk"], { from: "user" });

    expect(received).toMatchObject({
      source: "explicit",
      targets: [
        { target: "open-a:1.1", machine: undefined },
        { target: "open-b:1.1", machine: undefined },
      ],
      prompt: "Bulk",
      ifIdle: true,
    });
  });

  test("send rejects invalid capture-before values", async () => {
    expect(() => parseIntegerOption("capture-before", 1)("abc")).toThrow(/capture-before.*integer/i);
    expect(() => parseIntegerOption("capture-before", 1)("0")).toThrow(/capture-before.*integer/i);
    expect(parseIntegerOption("capture-before", 1)("120")).toBe(120);
  });

  test("key delegates allowlisted special-key dispatch", async () => {
    const out: string[] = [];
    let received: KeyOptions | undefined;
    const fakeClient = {
      key: async (opts: KeyOptions): Promise<DispatchRecord> => {
        received = opts;
        return {
          id: "key1",
          kind: "key",
          target: opts.target,
          machine: "local",
          prompt: "<key:Tab>",
          status: "delivered",
          createdAt: "x",
          updatedAt: "x",
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: (s) => out.push(s) });

    await program.parseAsync(["key", "--to", "open-browser:1.1", "--key", "Tab", "--json"], { from: "user" });

    expect(received).toEqual({ target: "open-browser:1.1", key: "Tab", machine: undefined });
    expect(JSON.parse(out.join("\n"))).toMatchObject({ kind: "key", prompt: "<key:Tab>" });
  });

  test("capture --json delegates bounded capture and reports AI failure with exit code 1", async () => {
    const out: string[] = [];
    let received: CaptureOptions | undefined;
    const fakeClient = {
      capture: async (opts: CaptureOptions) => {
        received = opts;
        return {
          status: "captured",
          target: opts.target,
          machine: "local",
          requestedLines: opts.lines ?? 200,
          lines: opts.lines ?? 200,
          maxLines: 2000,
          capturedAt: "x",
          text: "safe transcript\n",
          redacted: true,
          ai: { status: "failed", provider: "groq", detail: "Missing AI credentials" },
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: (s) => out.push(s) });

    process.exitCode = 0;
    await program.parseAsync(
      ["capture", "--to", "open-browser:1.1", "--lines", "120", "--ai", "--transform", "summary", "--json"],
      { from: "user" },
    );

    expect(received).toMatchObject({
      target: "open-browser:1.1",
      lines: 120,
      ai: { enabled: true, transform: "summary" },
    });
    expect(JSON.parse(out.join("\n"))).toMatchObject({ status: "captured", text: "safe transcript\n" });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("capture --backend mosaic forwards backend selection", async () => {
    let received: CaptureOptions | undefined;
    const fakeClient = {
      capture: async (opts: CaptureOptions) => {
        received = opts;
        return {
          status: "captured",
          backend: "mosaic",
          target: opts.target,
          machine: "local",
          requestedLines: opts.lines ?? 200,
          lines: opts.lines ?? 200,
          maxLines: 2000,
          capturedAt: "x",
          text: "safe transcript\n",
          redacted: true,
        };
      },
    } as DispatchClient;
    const program = buildProgram({ clientFactory: () => fakeClient, out: () => undefined });

    await program.parseAsync(["capture", "--backend", "mosaic", "--to", "work:terminal_1", "--lines", "50"], {
      from: "user",
    });

    expect(received).toMatchObject({ backend: "mosaic", target: "work:terminal_1", lines: 50 });
  });

  test("blocked exec --dry-run does not print a send plan", async () => {
    const out: string[] = [];
    const fakeClient = {
      exec: async (opts: ExecOptions): Promise<DispatchRecord> => ({
        id: "exec-blocked",
        kind: "exec",
        target: opts.target,
        machine: "local",
        prompt: "<exec-command sha256:blocked>",
        status: "skipped",
        detail: "destructive root/home removal is blocked",
        commandHash: "blocked",
        targetKind: "shell",
        dryRun: true,
        filter: {
          allowed: false,
          code: "blocked_destructive",
          reason: "destructive root/home removal is blocked",
          commandHash: "blocked",
          normalizedCommand: "<redacted>",
          targetKind: "shell",
        },
        execPlan: { interrupt: false, pasteText: "<redacted>", submitKey: "Enter" },
        createdAt: "x",
        updatedAt: "x",
      }),
    } as DispatchClient;
    const program = buildProgram({
      clientFactory: () => fakeClient,
      out: (s) => out.push(s),
    });

    await program.parseAsync(["exec", "--to", "open-mailery:01", "--command", "rm -rf /", "--dry-run"], {
      from: "user",
    });

    const text = out.join("\n");
    expect(text).toContain("blocked_destructive");
    expect(text).not.toContain("would paste");
    expect(text).not.toContain("would send key");
    process.exitCode = 0;
  });
});
