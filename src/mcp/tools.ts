import { z } from "zod";
import type { ZodRawShape } from "zod";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";
import { Tmux } from "../lib/tmux.js";
import { createRunner } from "../lib/runner.js";
import { loadExecPolicy } from "../lib/exec-policy.js";
import { inspectListedAgentTarget } from "../lib/agent-target.js";
import { daemonStatus, stopDaemon } from "../daemon/control.js";
import { startDaemon } from "../daemon/daemon.js";
import { serviceAction } from "../daemon/service.js";
import { summarizeBulk, summarizeRecord, summarizeSchedule } from "../cli/format.js";

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

function compactRecordResult(record: Awaited<ReturnType<DispatchClient["send"]>>, hint = "pass verbose:true for the full record") {
  const summary = summarizeRecord(record);
  return { id: summary.id, kind: summary.kind, status: summary.status, record: summary, compact: true, hint };
}

function compactScheduleResult(schedule: ReturnType<DispatchClient["schedule"]>, hint = "pass verbose:true for the full schedule") {
  const summary = summarizeSchedule(schedule);
  return { id: summary.id, kind: summary.kind, status: summary.status, schedule: summary, compact: true, hint };
}

export const TOOLS: ToolDef[] = [
  {
    name: "dispatch_send",
    verb: "send",
    title: "Dispatch a prompt",
    description:
      "Type a prompt into a tmux target and reliably auto-submit it (auto-delay + Enter with retry), then confirm delivery. Supports long/multiline prompts and remote machines.",
    inputSchema: {
      target: z.string().optional().describe("tmux target, e.g. session:window or session:window.pane"),
      prompt: z.string().describe("the prompt text to deliver"),
      machine: z.string().optional().describe("target machine id (local when omitted)"),
      source: z.enum(["sessions-query"]).optional().describe("target source; sessions-query probes sessions live/status JSON"),
      sessionsQuery: z.string().optional().describe("filter sessions-query target JSON by text"),
      targets: z.array(z.object({ target: z.string(), machine: z.string().optional() })).optional(),
      ifIdle: z.boolean().optional().describe("refuse delivery unless target looks idle"),
      queue: z.boolean().optional().describe("allow active targets and rely on the agent queue"),
      forceActive: z.boolean().optional().describe("explicitly override active/unknown target refusal"),
      submitKey: z.enum(["Enter", "Tab"]).optional().describe("prompt submit key"),
      dryRun: z.boolean().optional().describe("validate target/guards without typing"),
      captureBeforeLines: z.number().optional().describe("capture redacted transcript lines before delivery"),
      maxConcurrency: z.number().optional().describe("bulk max concurrent dispatches"),
      jitterMs: z.number().optional().describe("bulk random delay before each dispatch"),
      perMachineLimit: z.number().optional().describe("bulk max concurrent dispatches per machine"),
      submit: z.boolean().optional().describe("press Enter to submit (default true)"),
      confirm: z.boolean().optional().describe("verify delivery (default true)"),
      delayMs: z.number().optional().describe("override the auto-computed pre-Enter delay"),
      retries: z.number().optional().describe("max Enter retries if not confirmed; queued Tab delivery is single-shot"),
      mode: z.enum(["auto", "paste", "literal"]).optional().describe("delivery mode"),
      goal: z.boolean().optional().describe("prefix prompt with /goal unless it already starts with /goal"),
      verbose: z.boolean().optional().describe("return full records instead of compact summaries"),
    },
    handler: (deps, a) => {
      if (a.source || a.targets) {
        return deps.client.bulkSend({
          source: a.source as never,
          targets: a.targets as never,
          sessionsQuery: a.sessionsQuery as string | undefined,
          prompt: a.prompt as string,
          goal: a.goal as boolean | undefined,
          machine: a.machine as string | undefined,
          submit: a.submit as boolean | undefined,
          submitKey: a.submitKey as "Enter" | "Tab" | undefined,
          confirm: a.confirm as boolean | undefined,
          submitDelayMs: a.delayMs as number | undefined,
          maxSubmitRetries: a.retries as number | undefined,
          mode: a.mode as "auto" | "paste" | "literal" | undefined,
          ifIdle: (a.ifIdle as boolean | undefined) ?? (a.queue !== true && a.forceActive !== true),
          queue: a.queue as boolean | undefined,
          forceActive: a.forceActive as boolean | undefined,
          dryRun: a.dryRun as boolean | undefined,
          captureBeforeLines: a.captureBeforeLines as number | undefined,
          maxConcurrency: a.maxConcurrency as number | undefined,
          jitterMs: a.jitterMs as number | undefined,
          perMachineLimit: a.perMachineLimit as number | undefined,
        }).then((result) => (a.verbose === true ? result : summarizeBulk(result)));
      }
      if (typeof a.target !== "string" || a.target.trim().length === 0) {
        throw new Error("dispatch_send requires target, targets, or source=sessions-query");
      }
      return deps.client.send({
        target: a.target as string,
        prompt: a.prompt as string,
        goal: a.goal as boolean | undefined,
        machine: a.machine as string | undefined,
        submitKey: a.submitKey as "Enter" | "Tab" | undefined,
        ifIdle: a.ifIdle as boolean | undefined,
        queue: a.queue as boolean | undefined,
        forceActive: a.forceActive as boolean | undefined,
        dryRun: a.dryRun as boolean | undefined,
        captureBeforeLines: a.captureBeforeLines as number | undefined,
        submit: a.submit as boolean | undefined,
        confirm: a.confirm as boolean | undefined,
        submitDelayMs: a.delayMs as number | undefined,
        maxSubmitRetries: a.retries as number | undefined,
        mode: a.mode as "auto" | "paste" | "literal" | undefined,
      }).then((record) => (a.verbose === true ? record : compactRecordResult(record)));
    },
  },
  {
    name: "dispatch_key",
    verb: "key",
    title: "Dispatch a special key",
    description:
      "Send one allowlisted special key (Enter, Tab, Escape, arrows, Backspace/Delete, Home/End, PageUp/PageDown) to a recognized agent composer. Refuses shells and arbitrary node/bun panes.",
    inputSchema: {
      target: z.string().describe("tmux target, e.g. session:window or session:window.pane"),
      key: z.string().describe("allowlisted special key name"),
      machine: z.string().optional().describe("target machine id (local when omitted)"),
      verbose: z.boolean().optional().describe("return the full record instead of a compact summary"),
    },
    handler: (deps, a) =>
      deps.client.key({
        target: a.target as string,
        key: a.key as string,
        machine: a.machine as string | undefined,
      }).then((record) => (a.verbose === true ? record : compactRecordResult(record))),
  },
  {
    name: "dispatch_capture",
    verb: "capture",
    title: "Capture a pane transcript",
    description:
      "Capture a bounded, redacted tmux pane transcript locally or on a remote machine. Optionally run a provider-configured AI transform over the redacted text.",
    inputSchema: {
      target: z.string().describe("tmux target, e.g. session:window or session:window.pane"),
      machine: z.string().optional().describe("target machine id (local when omitted)"),
      lines: z.number().optional().describe("recent line count (default 200, max 2000)"),
      ai: z.boolean().optional().describe("run an AI transform"),
      transform: z.enum(["summary", "blockers", "changes", "next-steps"]).optional(),
      prompt: z.string().optional().describe("custom AI transform prompt"),
      provider: z.enum(["groq", "cerebras", "openai", "none"]).optional(),
      model: z.string().optional(),
    },
    handler: (deps, a) =>
      deps.client.capture({
        target: a.target as string,
        machine: a.machine as string | undefined,
        lines: a.lines as number | undefined,
        ai:
          a.ai || a.transform || a.prompt
            ? {
                enabled: true,
                transform: a.transform as never,
                prompt: a.prompt as string | undefined,
                provider: a.provider as never,
                model: a.model as string | undefined,
              }
            : undefined,
      }),
  },
  {
    name: "dispatch_exec",
    verb: "exec",
    title: "Dispatch a shell command",
    description:
      "Validate a single-line shell command with the exec security filter, require a detected shell tmux target, then submit it safely via tmux paste-buffer + Enter. Supports dry-run and explicit force-interrupt.",
    inputSchema: {
      target: z.string().describe("tmux target, e.g. session:window or session:window.pane"),
      command: z.string().describe("single-line shell command to deliver"),
      machine: z.string().optional().describe("target machine id (local when omitted)"),
      dryRun: z.boolean().optional().describe("validate and record without sending tmux input"),
      forceInterrupt: z.boolean().optional().describe("send C-c before the command (default false)"),
      policyFile: z.string().optional().describe("reviewed JSON exec policy file, equivalent to CLI --allow"),
      verbose: z.boolean().optional().describe("return the full record instead of a compact summary"),
    },
    handler: (deps, a) =>
      deps.client.exec({
        target: a.target as string,
        command: a.command as string,
        machine: a.machine as string | undefined,
        dryRun: a.dryRun as boolean | undefined,
        forceInterrupt: a.forceInterrupt as boolean | undefined,
        policy: a.policyFile ? loadExecPolicy(a.policyFile as string) : undefined,
      }).then((record) => (a.verbose === true ? record : compactRecordResult(record))),
  },
  {
    name: "dispatch_status",
    verb: "status",
    title: "Get a dispatch",
    description: "Look up a previously-recorded dispatch or scheduled dispatch/loop by id.",
    inputSchema: {
      id: z.string().describe("dispatch id"),
      verbose: z.boolean().optional().describe("return the full stored object instead of a compact summary"),
    },
    handler: async (deps, a) => {
      const rec = deps.client.status(a.id as string);
      if (rec) return a.verbose === true ? rec : { ...compactRecordResult(rec), resultKind: "dispatch" };
      const sched = deps.client.scheduleStatus(a.id as string);
      if (sched) return a.verbose === true ? sched : { ...compactScheduleResult(sched), resultKind: "schedule" };
      return { error: "not found", id: a.id };
    },
  },
  {
    name: "dispatch_show",
    verb: "show",
    title: "Show dispatch details",
    description: "Show a dispatch/schedule/loop by id. Compact by default; pass verbose=true for the full stored object.",
    inputSchema: {
      id: z.string().describe("dispatch or schedule id"),
      verbose: z.boolean().optional().describe("return the full stored object instead of compact details"),
    },
    handler: async (deps, a) => {
      const rec = deps.client.status(a.id as string);
      if (rec) {
        const summary = summarizeRecord(rec, { previewChars: 500 });
        return a.verbose === true ? rec : { id: summary.id, kind: summary.kind, status: summary.status, resultKind: "dispatch", record: summary, compact: true, hint: "pass verbose:true for the full record including full prompt" };
      }
      const sched = deps.client.scheduleStatus(a.id as string);
      if (sched) {
        const summary = summarizeSchedule(sched, { previewChars: 500 });
        return a.verbose === true ? sched : { id: summary.id, kind: summary.kind, status: summary.status, resultKind: "schedule", schedule: summary, compact: true, hint: "pass verbose:true for the full schedule including full prompt" };
      }
      return { error: "not found", id: a.id };
    },
  },
  {
    name: "dispatch_list",
    verb: "list",
    title: "List dispatches",
    description: "List recorded dispatches, newest first.",
    inputSchema: {
      status: z.string().optional().describe("filter by status"),
      limit: z.number().optional().describe("max rows (default 20)"),
      verbose: z.boolean().optional().describe("return full records instead of compact summaries"),
    },
    handler: async (deps, a) => {
      const limit = (a.limit as number | undefined) ?? 20;
      const rows = deps.client.list({ status: a.status as never, limit: a.verbose === true ? limit : limit + 1 });
      const shown = rows.slice(0, limit);
      return a.verbose === true
        ? rows
        : { items: shown.map((row) => summarizeRecord(row)), count: shown.length, limit, hasMore: rows.length > limit, compact: true, hint: "pass verbose:true for full records" };
    },
  },
  {
    name: "dispatch_schedule",
    verb: "schedule",
    title: "Schedule a dispatch",
    description: "Queue a dispatch to fire later: one-shot `at`/`in`, recurring `cron`, or interval `every`.",
    inputSchema: {
      target: z.string(),
      prompt: z.string(),
      machine: z.string().optional(),
      goal: z.boolean().optional(),
      name: z.string().optional(),
      at: z.string().optional().describe("one-shot ISO 8601 time"),
      in: z.string().optional().describe("one-shot relative delay, e.g. 30m or 5 minutes"),
      cron: z.string().optional().describe("5-field cron expression"),
      every: z.string().optional().describe("recurring interval, e.g. 5m or 1 hour"),
      ifIdle: z.boolean().optional().describe("refuse delivery unless target looks idle when fired"),
      queue: z.boolean().optional().describe("queue on active agents that prove Tab queued-message support when fired"),
      forceActive: z.boolean().optional().describe("explicitly override active/unknown target refusal when fired"),
      verbose: z.boolean().optional().describe("return the full schedule instead of a compact summary"),
    },
    handler: async (deps, a) => {
      const sched = deps.client.schedule({
        options: {
          target: a.target as string,
          prompt: a.prompt as string,
          goal: a.goal as boolean | undefined,
          machine: a.machine as string | undefined,
          ifIdle: a.ifIdle as boolean | undefined,
          queue: a.queue as boolean | undefined,
          forceActive: a.forceActive as boolean | undefined,
        },
        name: a.name as string | undefined,
        at: a.at as string | undefined,
        in: a.in as string | undefined,
        cron: a.cron as string | undefined,
        every: a.every as string | undefined,
      });
      return a.verbose === true ? sched : compactScheduleResult(sched);
    },
  },
  {
    name: "dispatch_loop",
    verb: "loop",
    title: "Create a dispatch loop",
    description: "Create a recurring interval dispatch loop such as every 5 minutes.",
    inputSchema: {
      target: z.string(),
      prompt: z.string(),
      every: z.string().describe("recurring interval, e.g. 5m or 1 hour"),
      machine: z.string().optional(),
      goal: z.boolean().optional(),
      name: z.string().optional(),
      ifIdle: z.boolean().optional(),
      queue: z.boolean().optional(),
      forceActive: z.boolean().optional(),
      verbose: z.boolean().optional().describe("return the full loop instead of a compact summary"),
    },
    handler: async (deps, a) => {
      const loop = deps.client.loop({
        options: {
          target: a.target as string,
          prompt: a.prompt as string,
          goal: a.goal as boolean | undefined,
          machine: a.machine as string | undefined,
          ifIdle: a.ifIdle as boolean | undefined,
          queue: a.queue as boolean | undefined,
          forceActive: a.forceActive as boolean | undefined,
        },
        every: a.every as string,
        name: a.name as string | undefined,
      });
      return a.verbose === true ? loop : compactScheduleResult(loop, "pass verbose:true for the full loop");
    },
  },
  {
    name: "dispatch_schedules",
    verb: "schedules",
    title: "List scheduled dispatches",
    description: "List scheduled dispatches (optionally filter by status).",
    inputSchema: {
      status: z.enum(["scheduled", "paused", "fired", "cancelled", "failed"]).optional(),
      kind: z.enum(["schedule", "loop"]).optional(),
      limit: z.number().optional().describe("max rows (default 20)"),
      verbose: z.boolean().optional().describe("return full schedules instead of compact summaries"),
    },
    handler: async (deps, a) => {
      const limit = (a.limit as number | undefined) ?? 20;
      const rows = deps.client.listSchedules({ status: a.status as never, kind: a.kind as never, limit: a.verbose === true ? limit : limit + 1 });
      const shown = rows.slice(0, limit);
      return a.verbose === true
        ? rows
        : { items: shown.map((row) => summarizeSchedule(row)), count: shown.length, limit, hasMore: rows.length > limit, compact: true, hint: "pass verbose:true for full schedules" };
    },
  },
  {
    name: "dispatch_loops",
    verb: "loops",
    title: "List dispatch loops",
    description: "List recurring interval dispatch loops.",
    inputSchema: {
      status: z.enum(["scheduled", "paused", "cancelled", "failed"]).optional(),
      limit: z.number().optional().describe("max rows (default 20)"),
      verbose: z.boolean().optional().describe("return full loops instead of compact summaries"),
    },
    handler: async (deps, a) => {
      const limit = (a.limit as number | undefined) ?? 20;
      const rows = deps.client.listLoops({ status: a.status as never, limit: a.verbose === true ? limit : limit + 1 });
      const shown = rows.slice(0, limit);
      return a.verbose === true
        ? rows
        : { items: shown.map((row) => summarizeSchedule(row)), count: shown.length, limit, hasMore: rows.length > limit, compact: true, hint: "pass verbose:true for full loops" };
    },
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
    name: "dispatch_pause",
    verb: "pause",
    title: "Pause a scheduled dispatch or loop",
    description: "Pause a scheduled dispatch or loop so it will not fire until resumed.",
    inputSchema: { id: z.string() },
    handler: async (deps, a) => ({ paused: deps.client.pauseSchedule(a.id as string) }),
  },
  {
    name: "dispatch_resume",
    verb: "resume",
    title: "Resume a scheduled dispatch or loop",
    description: "Resume a paused scheduled dispatch or loop.",
    inputSchema: { id: z.string() },
    handler: async (deps, a) => ({ resumed: deps.client.resumeSchedule(a.id as string) }),
  },
  {
    name: "dispatch_clear",
    verb: "clear",
    title: "Clear a scheduled dispatch or loop",
    description: "Delete a scheduled dispatch or loop from the store.",
    inputSchema: { id: z.string() },
    handler: async (deps, a) => ({ cleared: deps.client.clearSchedule(a.id as string) }),
  },
  {
    name: "dispatch_targets",
    verb: "targets",
    title: "List tmux targets",
    description: "Enumerate dispatchable tmux targets (panes) on a machine, so you can discover where to send.",
    inputSchema: {
      machine: z.string().optional(),
      limit: z.number().optional().describe("max rows (default 50)"),
      verbose: z.boolean().optional().describe("include full detection metadata"),
    },
    handler: async (deps, a) => {
      const tmux = await tmuxFor(deps, a.machine as string | undefined);
      const limit = (a.limit as number | undefined) ?? 50;
      const targets = tmux.listTargets();
      const items = targets.slice(0, limit).map((target) => {
        const detection = inspectListedAgentTarget(tmux, target.target, {
          assumeExists: true,
          paneCommand: target.paneCommand,
          cwd: target.cwd,
          panePid: target.panePid,
        }).detection;
        return a.verbose === true
          ? { ...target, detection }
          : {
              target: target.target,
              window: target.window,
              active: target.active,
              paneCommand: target.paneCommand,
              agentKind: detection?.agentKind,
              composerState: detection?.composerState,
              canReceivePrompt: detection?.canReceivePrompt,
              canQueuePrompt: detection?.canQueuePrompt,
            };
      });
      return { items, count: items.length, total: targets.length, limit, compact: a.verbose !== true, hint: "pass verbose:true for full target detection metadata" };
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
    name: "dispatch_daemon_ensure",
    verb: "daemon_ensure",
    title: "Ensure the daemon",
    description: "Idempotently ensure the dispatch daemon is running; recover stale state.",
    inputSchema: {},
    handler: async (deps) => {
      const before = daemonStatus(deps.store);
      if (before.health === "alive") return { ok: true, started: false, alreadyRunning: true, before, after: before };
      if (before.running || before.stale) await stopDaemon();
      const entry = deps.daemonEntry ? deps.daemonEntry() : defaultDaemonEntry();
      const started = await startDaemon({ cliEntry: entry, args: [] });
      const after = daemonStatus(deps.store);
      return { ok: after.running, started: started.started, alreadyRunning: started.alreadyRunning, before, after };
    },
  },
  {
    name: "dispatch_daemon_restart",
    verb: "daemon_restart",
    title: "Restart the daemon",
    description: "Stop and restart the dispatch daemon.",
    inputSchema: {},
    handler: async (deps) => {
      const stopped = await stopDaemon();
      const entry = deps.daemonEntry ? deps.daemonEntry() : defaultDaemonEntry();
      const started = await startDaemon({ cliEntry: entry, args: [] });
      return { ok: started.started || started.alreadyRunning, stopped, started };
    },
  },
  {
    name: "dispatch_daemon_status",
    verb: "daemon_status",
    title: "Daemon status",
    description: "Report daemon + queue status (running, scheduled, fired, dispatch counts).",
    inputSchema: {},
    handler: async (deps) => daemonStatus(deps.store),
  },
  {
    name: "dispatch_daemon_doctor",
    verb: "daemon_doctor",
    title: "Daemon doctor",
    description: "Return lightweight daemon health diagnostics.",
    inputSchema: {},
    handler: async (deps) => {
      const status = daemonStatus(deps.store);
      const findings: string[] = [];
      if (status.health === "dead") findings.push("daemon is not running");
      if (status.health === "stale") findings.push("daemon health is stale");
      if (status.scheduled > 0 && status.health !== "alive") findings.push("scheduled items cannot fire until daemon is alive");
      if (status.recentFailures.length > 0) findings.push("recent schedule/loop failures recorded");
      return { ok: findings.length === 0, status, findings };
    },
  },
  {
    name: "dispatch_daemon_service",
    verb: "daemon_service",
    title: "Manage daemon service",
    description: "Manage the user-level systemd service for the dispatch daemon.",
    inputSchema: {
      action: z.enum(["install", "start", "stop", "restart", "status", "uninstall"]),
      start: z.boolean().optional(),
    },
    handler: async (deps, a) =>
      serviceAction(a.action as never, {
        execPath: process.execPath,
        cliEntry: deps.daemonEntry ? deps.daemonEntry() : defaultDaemonEntry(),
        startAfterInstall: a.start === true,
      }),
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
