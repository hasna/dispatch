import { z } from "zod";
import type { ZodRawShape } from "zod";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";
import { Tmux } from "../lib/tmux.js";
import { createRunner } from "../lib/runner.js";
import { daemonStatus, stopDaemon } from "../daemon/control.js";
import { startDaemon } from "../daemon/daemon.js";

export interface ToolDeps {
  client: DispatchClient;
  store: Store;
  /** Build a Tmux for a machine (defaults to a real runner). */
  makeTmux?: (machine?: string) => Promise<Tmux>;
  /** Resolve the entry used to launch the daemon (defaults to the daemon bin). */
  daemonEntry?: () => string;
}

export interface ToolDef {
  /** Tool name as exposed over MCP (dispatch_<verb>). */
  name: string;
  /** The underlying verb, shared with the CLI for parity. */
  verb: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (deps: ToolDeps, args: Record<string, unknown>) => Promise<unknown>;
}

async function tmuxFor(deps: ToolDeps, machine?: string): Promise<Tmux> {
  if (deps.makeTmux) return deps.makeTmux(machine);
  return new Tmux(await createRunner(machine));
}

export const TOOLS: ToolDef[] = [
  {
    name: "dispatch_send",
    verb: "send",
    title: "Dispatch a prompt",
    description:
      "Type a prompt into a tmux target and reliably auto-submit it (auto-delay + Enter with retry), then confirm delivery. Supports long/multiline prompts and remote machines.",
    inputSchema: {
      target: z.string().describe("tmux target, e.g. session:window or session:window.pane"),
      prompt: z.string().describe("the prompt text to deliver"),
      machine: z.string().optional().describe("target machine id (local when omitted)"),
      submit: z.boolean().optional().describe("press Enter to submit (default true)"),
      confirm: z.boolean().optional().describe("verify delivery (default true)"),
      delayMs: z.number().optional().describe("override the auto-computed pre-Enter delay"),
      retries: z.number().optional().describe("max Enter retries if not confirmed"),
      mode: z.enum(["auto", "paste", "literal"]).optional().describe("delivery mode"),
    },
    handler: (deps, a) =>
      deps.client.send({
        target: a.target as string,
        prompt: a.prompt as string,
        machine: a.machine as string | undefined,
        submit: a.submit as boolean | undefined,
        confirm: a.confirm as boolean | undefined,
        submitDelayMs: a.delayMs as number | undefined,
        maxSubmitRetries: a.retries as number | undefined,
        mode: a.mode as "auto" | "paste" | "literal" | undefined,
      }),
  },
  {
    name: "dispatch_status",
    verb: "status",
    title: "Get a dispatch",
    description: "Look up a previously-recorded dispatch by id.",
    inputSchema: { id: z.string().describe("dispatch id") },
    handler: async (deps, a) => deps.client.status(a.id as string) ?? { error: "not found", id: a.id },
  },
  {
    name: "dispatch_list",
    verb: "list",
    title: "List dispatches",
    description: "List recorded dispatches, newest first.",
    inputSchema: {
      status: z.string().optional().describe("filter by status"),
      limit: z.number().optional().describe("max rows (default 20)"),
    },
    handler: async (deps, a) =>
      deps.client.list({ status: a.status as never, limit: (a.limit as number | undefined) ?? 20 }),
  },
  {
    name: "dispatch_schedule",
    verb: "schedule",
    title: "Schedule a dispatch",
    description: "Queue a dispatch to fire later: one-shot `at` (ISO time) or recurring `cron` (5-field).",
    inputSchema: {
      target: z.string(),
      prompt: z.string(),
      machine: z.string().optional(),
      at: z.string().optional().describe("one-shot ISO 8601 time"),
      cron: z.string().optional().describe("5-field cron expression"),
    },
    handler: async (deps, a) =>
      deps.client.schedule({
        options: { target: a.target as string, prompt: a.prompt as string, machine: a.machine as string | undefined },
        at: a.at as string | undefined,
        cron: a.cron as string | undefined,
      }),
  },
  {
    name: "dispatch_schedules",
    verb: "schedules",
    title: "List scheduled dispatches",
    description: "List scheduled dispatches (optionally filter by status).",
    inputSchema: { status: z.enum(["scheduled", "fired", "cancelled"]).optional() },
    handler: async (deps, a) => deps.client.listSchedules({ status: a.status as never }),
  },
  {
    name: "dispatch_cancel",
    verb: "cancel",
    title: "Cancel a scheduled dispatch",
    description: "Cancel a scheduled dispatch by id.",
    inputSchema: { id: z.string() },
    handler: async (deps, a) => ({ cancelled: deps.client.cancelSchedule(a.id as string) }),
  },
  {
    name: "dispatch_targets",
    verb: "targets",
    title: "List tmux targets",
    description: "Enumerate dispatchable tmux targets (panes) on a machine, so you can discover where to send.",
    inputSchema: { machine: z.string().optional() },
    handler: async (deps, a) => {
      const tmux = await tmuxFor(deps, a.machine as string | undefined);
      return tmux.listTargets();
    },
  },
  {
    name: "dispatch_daemon_start",
    verb: "daemon_start",
    title: "Start the daemon",
    description: "Start the dispatch daemon (scheduled-dispatch queue) in the background.",
    inputSchema: {},
    handler: async (deps) => {
      const entry = deps.daemonEntry ? deps.daemonEntry() : defaultDaemonEntry();
      return startDaemon({ cliEntry: entry, args: [] });
    },
  },
  {
    name: "dispatch_daemon_stop",
    verb: "daemon_stop",
    title: "Stop the daemon",
    description: "Stop the running dispatch daemon.",
    inputSchema: {},
    handler: async () => stopDaemon(),
  },
  {
    name: "dispatch_daemon_status",
    verb: "daemon_status",
    title: "Daemon status",
    description: "Report daemon + queue status (running, scheduled, fired, dispatch counts).",
    inputSchema: {},
    handler: async (deps) => daemonStatus(deps.store),
  },
];

/** Canonical verb set, shared with the CLI for parity checks. */
export const VERBS = TOOLS.map((t) => t.verb);

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the daemon entry next to this module (dev .ts / dist .js). */
export function defaultDaemonEntry(): string {
  const here = fileURLToPath(import.meta.url); // .../mcp/tools.(ts|js)
  const ext = here.endsWith(".ts") ? ".ts" : ".js";
  return join(dirname(dirname(here)), "daemon", `index${ext}`);
}
