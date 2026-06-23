import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TOOLS, VERBS, type ToolDeps } from "./tools.js";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";
import { Tmux } from "../lib/tmux.js";
import { MockRunner } from "../test/mock-runner.js";
import { buildProgram } from "../cli/index.js";
import type {
  BulkDispatchOptions,
  BulkDispatchResult,
  CaptureOptions,
  DispatchOptions,
  DispatchRecord,
  ExecOptions,
  KeyOptions,
} from "../types.js";

function deps(): ToolDeps {
  const store = new Store(":memory:");
  return { client: new DispatchClient({ store }), store };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe("MCP tool handlers", () => {
  test("status returns the record or a not-found marker", async () => {
    const d = deps();
    const rec = d.store.createDispatch({ target: "s:w", prompt: "hi", status: "delivered" });
    expect(await tool("dispatch_status").handler(d, { id: rec.id })).toMatchObject({ id: rec.id });
    expect(await tool("dispatch_status").handler(d, { id: "nope" })).toMatchObject({ error: "not found" });
  });

  test("list returns recorded dispatches", async () => {
    const d = deps();
    d.store.createDispatch({ target: "s:w", prompt: "a" });
    d.store.createDispatch({ target: "s:w", prompt: "b" });
    expect(await tool("dispatch_list").handler(d, {})).toHaveLength(2);
  });

  test("schedule + schedules + cancel round-trip", async () => {
    const d = deps();
    const sched = (await tool("dispatch_schedule").handler(d, {
      target: "s:w",
      prompt: "later",
      cron: "*/5 * * * *",
    })) as { id: string; status: string };
    expect(sched.status).toBe("scheduled");
    expect(await tool("dispatch_schedules").handler(d, {})).toHaveLength(1);
    expect(await tool("dispatch_cancel").handler(d, { id: sched.id })).toEqual({ cancelled: true });
  });

  test("targets enumerates tmux panes via the injected runner", async () => {
    const d = deps();
    const r = new MockRunner();
    r.queue.push({ stdout: "work:1.0\tagent\t1\nwork:2.0\teditor\t0\n" });
    d.makeTmux = async () => new Tmux(r);
    const targets = (await tool("dispatch_targets").handler(d, {})) as Array<{ target: string; active: boolean }>;
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ target: "work:1.0", window: "agent", active: true } as never);
    expect(targets[1]!.active).toBe(false);
  });

  test("daemon_status reports queue counts", async () => {
    const d = deps();
    d.store.createSchedule({ options: { target: "s:w", prompt: "x" }, nextRun: "2099-01-01T00:00:00Z" });
    const st = (await tool("dispatch_daemon_status").handler(d, {})) as { scheduled: number };
    expect(st.scheduled).toBe(1);
  });

  test("exec loads a reviewed policy file and delegates command dispatch options to the client", async () => {
    const d = deps();
    const dir = mkdtempSync(join(tmpdir(), "dispatch_mcp_policy_"));
    const policyFile = join(dir, "exec-policy.json");
    writeFileSync(policyFile, JSON.stringify({ allowPrefixes: ["mailery status"], allowTargets: ["open-mailery:*"] }));
    let received: ExecOptions | undefined;
    d.client.exec = async (opts: ExecOptions): Promise<DispatchRecord> => {
      received = opts;
      return {
        id: "exec1",
        kind: "exec",
        target: opts.target,
        machine: "local",
        prompt: opts.command,
        status: "skipped",
        detail: "dry run",
        createdAt: "x",
        updatedAt: "x",
      };
    };

    try {
      const result = await tool("dispatch_exec").handler(d, {
        target: "open-mailery:01",
        command: "mailery status",
        dryRun: true,
        forceInterrupt: true,
        policyFile,
      });

      expect(result).toMatchObject({ id: "exec1", kind: "exec" });
      expect(received).toMatchObject({
        target: "open-mailery:01",
        command: "mailery status",
        dryRun: true,
        forceInterrupt: true,
        policy: { allowPrefixes: ["mailery status"], allowTargets: ["open-mailery:*"] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("send forwards goal mode to the client", async () => {
    const d = deps();
    let received: DispatchOptions | undefined;
    d.client.send = async (opts: DispatchOptions): Promise<DispatchRecord> => {
      received = opts;
      return {
        id: "send1",
        kind: "prompt",
        target: opts.target,
        machine: "local",
        prompt: opts.prompt,
        status: "delivered",
        createdAt: "x",
        updatedAt: "x",
      };
    };

    await tool("dispatch_send").handler(d, { target: "work:agent", prompt: "Fix native chat", goal: true });

    expect(received).toMatchObject({ target: "work:agent", prompt: "Fix native chat", goal: true });
  });

  test("send forwards submit-key selection to the client", async () => {
    const d = deps();
    let received: DispatchOptions | undefined;
    d.client.send = async (opts: DispatchOptions): Promise<DispatchRecord> => {
      received = opts;
      return {
        id: "send-tab",
        kind: "prompt",
        target: opts.target,
        machine: "local",
        prompt: opts.prompt,
        status: "skipped",
        detail: "dry run",
        createdAt: "x",
        updatedAt: "x",
      };
    };

    await tool("dispatch_send").handler(d, {
      target: "work:agent",
      prompt: "Queue me",
      submitKey: "Tab",
      dryRun: true,
    });

    expect(received).toMatchObject({ target: "work:agent", submitKey: "Tab", dryRun: true });
  });

  test("send delegates sessions-query bulk orchestration options to the client", async () => {
    const d = deps();
    let received: BulkDispatchOptions | undefined;
    d.client.bulkSend = async (opts: BulkDispatchOptions): Promise<BulkDispatchResult> => {
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
        maxConcurrency: 2,
        jitterMs: 50,
        perMachineLimit: 1,
        records: [],
      };
    };

    const result = await tool("dispatch_send").handler(d, {
      source: "sessions-query",
      sessionsQuery: "open-router",
      prompt: "Fix native chat",
      goal: true,
      ifIdle: true,
      submitKey: undefined,
      dryRun: true,
      captureBeforeLines: 120,
      maxConcurrency: 2,
      jitterMs: 50,
      perMachineLimit: 1,
    });

    expect(result).toMatchObject({ source: "sessions-query", dryRun: true });
    expect(received).toMatchObject({
      source: "sessions-query",
      sessionsQuery: "open-router",
      prompt: "Fix native chat",
      goal: true,
      ifIdle: true,
      dryRun: true,
      captureBeforeLines: 120,
      maxConcurrency: 2,
      jitterMs: 50,
      perMachineLimit: 1,
    });
  });

  test("send rejects missing target when no bulk source is provided", async () => {
    const d = deps();
    await expect(Promise.resolve().then(() => tool("dispatch_send").handler(d, { prompt: "Fix native chat" }))).rejects.toThrow(
      /requires target, targets, or source=sessions-query/,
    );
  });

  test("key delegates allowlisted special-key options to the client", async () => {
    const d = deps();
    let received: KeyOptions | undefined;
    d.client.key = async (opts: KeyOptions): Promise<DispatchRecord> => {
      received = opts;
      return {
        id: "key1",
        kind: "key",
        target: opts.target,
        machine: "local",
        prompt: `<key:${opts.key}>`,
        status: "delivered",
        createdAt: "x",
        updatedAt: "x",
      };
    };

    const result = await tool("dispatch_key").handler(d, { target: "work:agent", key: "Tab" });

    expect(result).toMatchObject({ id: "key1", kind: "key" });
    expect(received).toEqual({ target: "work:agent", key: "Tab", machine: undefined });
  });

  test("capture delegates transcript and AI transform options to the client", async () => {
    const d = deps();
    let received: CaptureOptions | undefined;
    d.client.capture = async (opts: CaptureOptions) => {
      received = opts;
      return {
        status: "captured",
        target: opts.target,
        machine: "local",
        requestedLines: opts.lines ?? 200,
        lines: opts.lines ?? 200,
        maxLines: 2000,
        capturedAt: "x",
        text: "transcript\n",
        redacted: true,
      };
    };

    const result = await tool("dispatch_capture").handler(d, {
      target: "work:agent",
      lines: 120,
      ai: true,
      transform: "blockers",
      provider: "groq",
    });

    expect(result).toMatchObject({ status: "captured", text: "transcript\n" });
    expect(received).toMatchObject({
      target: "work:agent",
      lines: 120,
      ai: { enabled: true, transform: "blockers", provider: "groq" },
    });
  });
});

describe("CLI/MCP parity", () => {
  test("every MCP verb has a matching CLI command and vice versa", () => {
    const program = buildProgram();
    const cliVerbs = new Set<string>();
    for (const cmd of program.commands) {
      if (cmd.name() === "daemon") {
        for (const sub of cmd.commands) {
          if (sub.name() !== "run") cliVerbs.add(`daemon_${sub.name()}`);
        }
      } else {
        cliVerbs.add(cmd.name());
      }
    }
    const mcpVerbs = new Set(VERBS);
    // Each MCP verb is offered by the CLI.
    for (const v of mcpVerbs) expect(cliVerbs.has(v)).toBe(true);
    // Each CLI verb is offered by the MCP.
    for (const v of cliVerbs) expect(mcpVerbs.has(v)).toBe(true);
  });

  test("tool names are dispatch_<verb> and unique", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) expect(t.name).toBe(`dispatch_${t.verb}`);
  });
});
