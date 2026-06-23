import { describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProgram, parseIntegerOption } from "./index.js";
import { formatRecord, formatSchedule, resolvePrompt } from "./format.js";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";
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

describe("CLI read/schedule commands (in-memory client)", () => {
  test("status: found and not-found", async () => {
    const { store, program, out, err } = runner();
    const rec = store.createDispatch({ target: "s:w", prompt: "hi", status: "delivered" });
    await program.parseAsync(["status", rec.id], { from: "user" });
    expect(out.join("\n")).toContain(rec.id);

    process.exitCode = 0;
    await program.parseAsync(["status", "missing"], { from: "user" });
    expect(err.join("\n")).toMatch(/not found/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
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

  test("schedule rejects missing at/cron", async () => {
    const { program } = runner();
    await expect(
      program.parseAsync(["schedule", "--to", "s:w", "--prompt", "x"], { from: "user" }),
    ).rejects.toThrow(/at.*cron/);
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
