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

const codewithComposerCapture = `
╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (v0.1.42)                             │
│ model:       gpt-5.5 xhigh   fast   /model to change    │
│ directory:   ~/workspace/hasna/opensource/open-dispatch │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
› Fix native chat
`;

const codexComposerCapture = `
╭────────────────────────────────────────╮
│ ✦ OpenAI Codex                         │
│ model:       gpt-5.1-codex             │
│ directory:   /home/hasna/workspace/app │
│ permissions: workspace-write           │
╰────────────────────────────────────────╯
› Add a regression test
`;

describe("MCP tool handlers", () => {
  test("status returns the record or a not-found marker", async () => {
    const d = deps();
    const rec = d.store.createDispatch({ target: "s:w", prompt: "hi", status: "delivered" });
    expect(await tool("dispatch_status").handler(d, { id: rec.id })).toMatchObject({
      kind: "prompt",
      resultKind: "dispatch",
      compact: true,
      record: { id: rec.id, promptPreview: "hi", promptLength: 2 },
    });
    expect(await tool("dispatch_status").handler(d, { id: rec.id, verbose: true })).toMatchObject({ id: rec.id, prompt: "hi" });
    expect(await tool("dispatch_status").handler(d, { id: "nope" })).toMatchObject({ error: "not found" });
  });

  test("list returns recorded dispatches", async () => {
    const d = deps();
    d.store.createDispatch({ target: "s:w", prompt: "a" });
    d.store.createDispatch({ target: "s:w", prompt: "b" });
    expect(await tool("dispatch_list").handler(d, {})).toMatchObject({
      count: 2,
      limit: 20,
      compact: true,
      items: [{ promptPreview: "b", promptLength: 1 }, { promptPreview: "a", promptLength: 1 }],
    });
    expect(await tool("dispatch_list").handler(d, { verbose: true })).toHaveLength(2);
  });

  test("schedule + schedules + cancel round-trip", async () => {
    const d = deps();
    const sched = (await tool("dispatch_schedule").handler(d, {
      target: "s:w",
      prompt: "later",
      in: "30m",
      name: "reminder",
    })) as { schedule: { id: string; status: string; name: string }; compact: true };
    expect(sched.schedule.status).toBe("scheduled");
    expect(sched.schedule.name).toBe("reminder");
    expect(await tool("dispatch_schedules").handler(d, {})).toMatchObject({ count: 1, compact: true });
    expect(await tool("dispatch_schedules").handler(d, { verbose: true })).toHaveLength(1);
    expect(await tool("dispatch_cancel").handler(d, { id: sched.schedule.id })).toEqual({ cancelled: true });
  });

  test("loop + status + pause + resume + clear round-trip", async () => {
    const d = deps();
    const loop = (await tool("dispatch_loop").handler(d, {
      target: "s:w",
      prompt: "poll",
      every: "5m",
      name: "poller",
    })) as { schedule: { id: string; kind: string; cadence: string }; compact: true };
    expect(loop.schedule).toMatchObject({ kind: "loop", cadence: "every(5m)" });
    expect(await tool("dispatch_loops").handler(d, {})).toMatchObject({ count: 1, compact: true });
    expect(await tool("dispatch_status").handler(d, { id: loop.schedule.id })).toMatchObject({
      kind: "loop",
      resultKind: "schedule",
      compact: true,
      schedule: { id: loop.schedule.id, kind: "loop" },
    });
    expect(await tool("dispatch_status").handler(d, { id: loop.schedule.id, verbose: true })).toMatchObject({
      id: loop.schedule.id,
      kind: "loop",
    });
    expect(await tool("dispatch_pause").handler(d, { id: loop.schedule.id })).toEqual({ paused: true });
    expect(await tool("dispatch_resume").handler(d, { id: loop.schedule.id })).toEqual({ resumed: true });
    expect(await tool("dispatch_clear").handler(d, { id: loop.schedule.id })).toEqual({ cleared: true });
    expect(await tool("dispatch_loops").handler(d, {})).toMatchObject({ count: 0, items: [] });
  });

  test("targets enumerates tmux panes via the injected runner", async () => {
    const d = deps();
    const r = new MockRunner();
    r.queue.push({ stdout: "work:1.0\tagent\t1\nwork:2.0\teditor\t0\n" });
    d.makeTmux = async () => new Tmux(r);
    const targets = (await tool("dispatch_targets").handler(d, {})) as {
      items: Array<{ target: string; active: boolean }>;
      count: number;
      total: number;
      compact: boolean;
    };
    expect(targets).toMatchObject({ count: 2, total: 2, compact: true });
    expect(targets.items[0]).toMatchObject({ target: "work:1.0", window: "agent", active: true } as never);
    expect(targets.items[1]!.active).toBe(false);
  });

  test("targets exposes wrapper Codewith/Codex detection and refuses arbitrary node panes", async () => {
    const d = deps();
    const r = new MockRunner();
    r.responder = (argv) => {
      if (argv[1] === "list-panes") {
        return {
          stdout: [
            "work:1.0\tcodewith\t1\tnode\t/repo\t1111",
            "work:2.0\tcodex\t0\tbun\t/repo\t2222",
            "work:3.0\tserver\t0\tnode\t/srv\t3333",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      if (argv[1] === "capture-pane") {
        const target = argv[argv.indexOf("-t") + 1];
        if (target === "work:1.0") return { stdout: codewithComposerCapture, stderr: "", exitCode: 0, source: "local" };
        if (target === "work:2.0") return { stdout: codexComposerCapture, stderr: "", exitCode: 0, source: "local" };
        return { stdout: "node server.js\nListening on http://127.0.0.1:3000\n", stderr: "", exitCode: 0, source: "local" };
      }
      if (argv[0] === "sh" && argv[2]?.includes("ps -o pid=,ppid=,stat=,command=")) {
        const pid = argv[4];
        if (pid === "1111") {
          return {
            stdout:
              "1111 1 Ss /usr/bin/bash\n1112 1111 Sl+ node --max-old-space-size=6144 /home/hasna/.bun/bin/codewith --auth-profile account005\n",
            stderr: "",
            exitCode: 0,
            source: "local",
          };
        }
        if (pid === "2222") {
          return { stdout: "2222 1 Sl+ bun /home/hasna/.bun/bin/codex\n", stderr: "", exitCode: 0, source: "local" };
        }
        return { stdout: "3333 1 Sl+ node /srv/server.js codewith\n", stderr: "", exitCode: 0, source: "local" };
      }
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };
    d.makeTmux = async () => new Tmux(r);

    const result = (await tool("dispatch_targets").handler(d, { verbose: true })) as {
      items: Array<{
        target: string;
        detection?: { agentKind: string; canReceivePrompt: boolean };
      }>;
    };
    const targets = result.items;

    expect(targets.find((t) => t.target === "work:1.0")?.detection).toMatchObject({
      agentKind: "codewith",
      canReceivePrompt: true,
    });
    expect(targets.find((t) => t.target === "work:2.0")?.detection).toMatchObject({
      agentKind: "codex",
      canReceivePrompt: true,
    });
    expect(targets.find((t) => t.target === "work:3.0")?.detection).toMatchObject({
      agentKind: "unknown",
      canReceivePrompt: false,
    });
    expect(r.argvs().some((a) => a[0] === "ps")).toBe(false);
    expect(r.argvs().some((a) => a[0] === "sh" && a[2]?.includes("head -n") && a[2]?.includes("cut -c"))).toBe(true);
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

      expect(result).toMatchObject({ compact: true, record: { id: "exec1", kind: "exec" } });
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
        planned: 25,
        delivered: 20,
        skipped: 1,
        failed: 0,
        dryRun: true,
        maxConcurrency: 2,
        jitterMs: 50,
        perMachineLimit: 1,
        records: Array.from({ length: 25 }, (_, i) => ({
          id: `bulk-${i}`,
          kind: "prompt",
          target: `work:${i}`,
          machine: "local",
          prompt: `prompt ${i}`,
          status: "delivered",
          createdAt: "x",
          updatedAt: "x",
        })),
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

    expect(result).toMatchObject({ source: "sessions-query", dryRun: true, compact: true, recordCount: 25, shownRecords: 20, omittedRecords: 5 });
    expect((result as { records: unknown[] }).records).toHaveLength(20);
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

    expect(result).toMatchObject({ compact: true, record: { id: "key1", kind: "key" } });
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
