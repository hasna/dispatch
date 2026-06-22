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
import type { DispatchRecord, ExecOptions } from "../types.js";

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
    expect(targets[0]).toEqual({ target: "work:1.0", window: "agent", active: true } as never);
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
