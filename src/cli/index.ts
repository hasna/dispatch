#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import { getPackageVersion } from "../lib/version.js";
import { DispatchClient } from "../sdk/index.js";
import type { AgentTargetInfo, BulkDispatchOptions, CaptureOptions, CaptureTransform, DispatchOptions, ExecOptions, KeyOptions } from "../types.js";
import {
  formatBulk,
  formatCapture,
  formatRecord,
  formatRecordDetail,
  formatRecordList,
  formatSchedule,
  formatScheduleDetail,
  formatScheduleList,
  resolvePrompt,
} from "./format.js";
import { registerDaemonCommands } from "./daemon-commands.js";
import { Tmux } from "../lib/tmux.js";
import { createRunner } from "../lib/runner.js";
import { loadExecPolicy } from "../lib/exec-policy.js";
import { inspectAgentTarget } from "../lib/agent-target.js";

export interface CliDeps {
  /** Factory for the client; when provided, the CLI will NOT close it (tests own it). */
  clientFactory?: () => DispatchClient;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Pre-read stdin content (piped prompt). */
  stdin?: string;
}

export function parseIntegerOption(label: string, min: number) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      throw new InvalidArgumentError(`${label} must be an integer >= ${min}`);
    }
    return parsed;
  };
}

function normalizeSubmitKeyOption(value: string | undefined): "Enter" | "Tab" | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "enter" || normalized === "return") return "Enter";
  if (normalized === "tab") return "Tab";
  throw new InvalidArgumentError("submit-key must be Enter or Tab");
}

export function buildProgram(deps: CliDeps = {}): Command {
  const out = deps.out ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const ownClient = !deps.clientFactory;
  const makeClient = deps.clientFactory ?? (() => new DispatchClient());

  async function withClient<T>(fn: (c: DispatchClient) => T | Promise<T>): Promise<T> {
    const client = makeClient();
    try {
      return await fn(client);
    } finally {
      if (ownClient) client.close();
    }
  }

  const program = new Command();
  program
    .name("dispatch")
    .description("Dispatch prompts to coding agents running in tmux windows — reliably")
    .version(getPackageVersion());

  program
    .command("send")
    .description("Dispatch a prompt to a tmux target and auto-submit it")
    .option("-t, --to <target>", "tmux target, e.g. session:window or session:window.pane. Comma-separate for bulk.")
    .option("-p, --prompt <text>", "prompt text (or use --file / stdin)")
    .option("-f, --file <path>", "read the prompt from a file")
    .option("--goal", "prefix the delivered prompt with /goal unless it already starts with /goal")
    .option("--from <source>", "target source: sessions-query")
    .option("--sessions-query <query>", "filter sessions-query target JSON by text")
    .option("--if-idle", "refuse delivery unless the target looks idle")
    .option("--queue", "allow active targets and rely on the agent queue")
    .option("--submit-key <key>", "prompt submit key: Enter | Tab")
    .option("--force-active", "explicitly override active/unknown target refusal")
    .option("--capture-before <lines>", "capture redacted transcript lines before delivery", parseIntegerOption("capture-before", 1))
    .option("--dry-run", "validate targets/guards and show what would be sent without typing")
    .option("--max-concurrency <n>", "bulk max concurrent dispatches", parseIntegerOption("max-concurrency", 1), 1)
    .option("--jitter <ms>", "bulk random delay before each dispatch", parseIntegerOption("jitter", 0), 0)
    .option("--per-machine-limit <n>", "bulk max concurrent dispatches per machine", parseIntegerOption("per-machine-limit", 1))
    .option("-m, --machine <id>", "target machine (via @hasna/machines); local when omitted")
    .option("--no-submit", "type into the composer but do not press Enter")
    .option("--no-confirm", "skip delivery confirmation")
    .option("--delay <ms>", "override the auto-computed pre-Enter delay", (v) => parseInt(v, 10))
    .option("--retries <n>", "max Enter retries if not confirmed; queued Tab delivery is single-shot", (v) => parseInt(v, 10))
    .option("--mode <mode>", "delivery mode: auto | paste | literal", "auto")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const stdin = opts.prompt || opts.file ? deps.stdin : deps.stdin ?? (await readStdinIfPiped());
      const prompt = resolvePrompt(opts, stdin);
      const targets = String(opts.to ?? "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean)
        .map((target) => ({ target, machine: opts.machine }));
      if (opts.from && opts.from !== "sessions-query") {
        throw new Error(`unsupported target source: ${opts.from}`);
      }
      if (opts.from === "sessions-query" || targets.length > 1) {
        const submitKey = normalizeSubmitKeyOption(opts.submitKey);
        const options: BulkDispatchOptions = {
          source: opts.from === "sessions-query" ? "sessions-query" : "explicit",
          targets: opts.from === "sessions-query" ? undefined : targets,
          sessionsQuery: opts.sessionsQuery,
          prompt,
          goal: opts.goal === true,
          machine: opts.machine,
          submit: opts.submit,
          submitKey,
          confirm: opts.confirm,
          submitDelayMs: opts.delay,
          maxSubmitRetries: opts.retries,
          mode: opts.mode,
          ifIdle: opts.ifIdle === true || (opts.queue !== true && opts.forceActive !== true),
          queue: opts.queue === true,
          forceActive: opts.forceActive === true,
          dryRun: opts.dryRun === true,
          captureBeforeLines: opts.captureBefore,
          maxConcurrency: opts.maxConcurrency,
          jitterMs: opts.jitter,
          perMachineLimit: opts.perMachineLimit,
        };
        const result = await withClient((c) => c.bulkSend(options));
        out(opts.json ? JSON.stringify(result, null, 2) : formatBulk(result));
        if (result.status === "failed") process.exitCode = 1;
        return;
      }
      if (targets.length === 0) {
        throw new Error("no target: pass --to <target> or --from sessions-query");
      }
      const options: DispatchOptions = {
        target: targets[0]!.target,
        prompt,
        goal: opts.goal === true,
        machine: opts.machine,
        submitKey: normalizeSubmitKeyOption(opts.submitKey),
        ifIdle: opts.ifIdle === true,
        queue: opts.queue === true,
        forceActive: opts.forceActive === true,
        dryRun: opts.dryRun === true,
        captureBeforeLines: opts.captureBefore,
        submit: opts.submit,
        confirm: opts.confirm,
        submitDelayMs: opts.delay,
        maxSubmitRetries: opts.retries,
        mode: opts.mode,
      };
      const rec = await withClient((c) => c.send(options));
      out(opts.json ? JSON.stringify(rec, null, 2) : formatRecord(rec));
      const plannedDryRun = rec.status === "skipped" && rec.dryRun === true && /^dry run:/i.test(rec.detail ?? "");
      if (rec.status === "failed" || (rec.status === "skipped" && !plannedDryRun)) process.exitCode = 1;
    });

  program
    .command("key")
    .description("Send an allowlisted special key to a recognized agent composer")
    .requiredOption("-t, --to <target>", "tmux target, e.g. session:window or session:window.pane")
    .requiredOption("-k, --key <key>", "special key: Enter, Tab, Escape, arrows, Backspace/Delete, Home/End, PageUp/PageDown")
    .option("-m, --machine <id>", "target machine (via @hasna/machines); local when omitted")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const options: KeyOptions = {
        target: opts.to,
        key: opts.key,
        machine: opts.machine,
      };
      const rec = await withClient((c) => c.key(options));
      out(opts.json ? JSON.stringify(rec, null, 2) : formatRecord(rec));
      if (rec.status === "failed" || rec.status === "skipped") process.exitCode = 1;
    });

  program
    .command("capture")
    .description("Capture a bounded, redacted tmux pane transcript, optionally with an AI transform")
    .requiredOption("-t, --to <target>", "tmux target, e.g. session:window or session:window.pane")
    .option("-n, --lines <n>", "recent line count to capture (default 200, max 2000)", (v) => parseInt(v, 10))
    .option("-m, --machine <id>", "target machine (via @hasna/machines); local when omitted")
    .option("--ai", "run an optional AI transform over the redacted capture")
    .option("--transform <name>", "built-in AI transform: summary | blockers | changes | next-steps")
    .option("--prompt <text>", "custom AI transform prompt")
    .option("--provider <name>", "AI provider: groq | cerebras | openai | none")
    .option("--model <model>", "AI model override")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const aiRequested = opts.ai === true || opts.transform !== undefined || opts.prompt !== undefined;
      const options: CaptureOptions = {
        target: opts.to,
        machine: opts.machine,
        lines: opts.lines,
        ai: aiRequested
          ? {
              enabled: true,
              transform: opts.transform as CaptureTransform | undefined,
              prompt: opts.prompt,
              provider: opts.provider,
              model: opts.model,
            }
          : undefined,
      };
      const result = await withClient((c) => c.capture(options));
      out(opts.json ? JSON.stringify(result, null, 2) : formatCapture(result));
      if (result.status === "failed" || result.ai?.status === "failed") process.exitCode = 1;
    });

  program
    .command("exec")
    .description("Dispatch a filtered shell command to a detected shell tmux target")
    .requiredOption("-t, --to <target>", "tmux target, e.g. session:window or session:window.pane")
    .requiredOption("-c, --command <command>", "single-line shell command to submit")
    .option("-m, --machine <id>", "target machine (via @hasna/machines); local when omitted")
    .option("--dry-run", "validate and show the exact tmux input without sending it")
    .option("--allow <path>", "JSON exec policy file with reviewed allowPrefixes/targets/sensitive paths")
    .option("--force-interrupt", "send C-c before pasting the command")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const options: ExecOptions = {
        target: opts.to,
        command: opts.command,
        machine: opts.machine,
        dryRun: opts.dryRun === true,
        forceInterrupt: opts.forceInterrupt === true,
        policy: opts.allow ? loadExecPolicy(opts.allow) : undefined,
      };
      const rec = await withClient((c) => c.exec(options));
      if (opts.json) {
        out(JSON.stringify(rec, null, 2));
      } else {
        out(formatRecord(rec));
        if (opts.dryRun && rec.execPlan && rec.filter?.allowed === true) {
          if (rec.execPlan.interrupt) out("would send key: C-c");
          out(`would paste: ${JSON.stringify(rec.execPlan.pasteText)}`);
          out(`would send key: ${rec.execPlan.submitKey}`);
        }
      }
      if (rec.status === "failed" || (rec.kind === "exec" && rec.filter?.allowed === false)) process.exitCode = 1;
    });

  program
    .command("status <id>")
    .description("Show a recorded dispatch or scheduled dispatch/loop by id")
    .option("--verbose", "show expanded human-readable fields without dumping raw JSON")
    .option("--json", "output JSON")
    .action(async (id, opts) => {
      const rec = await withClient((c) => c.status(id));
      if (rec) {
        out(opts.json ? JSON.stringify(rec, null, 2) : opts.verbose ? formatRecordDetail(rec) : `${formatRecord(rec)}\nhint: use \`dispatch show ${rec.id}\` or \`dispatch status ${rec.id} --verbose\` for details; use --json for the full record`);
        return;
      }
      const sched = await withClient((c) => c.scheduleStatus(id));
      if (!sched) {
        err(`dispatch or schedule not found: ${id}`);
        process.exitCode = 1;
        return;
      }
      out(opts.json ? JSON.stringify(sched, null, 2) : opts.verbose ? formatScheduleDetail(sched) : `${formatSchedule(sched)}\nhint: use \`dispatch show ${sched.id}\` or \`dispatch status ${sched.id} --verbose\` for details; use --json for the full record`);
    });

  program
    .command("show <id>")
    .alias("inspect")
    .description("Show expanded details for a dispatch, schedule, or loop")
    .option("--json", "output the full stored JSON object")
    .action(async (id, opts) => {
      const rec = await withClient((c) => c.status(id));
      if (rec) {
        out(opts.json ? JSON.stringify(rec, null, 2) : formatRecordDetail(rec));
        return;
      }
      const sched = await withClient((c) => c.scheduleStatus(id));
      if (!sched) {
        err(`dispatch or schedule not found: ${id}`);
        process.exitCode = 1;
        return;
      }
      out(opts.json ? JSON.stringify(sched, null, 2) : formatScheduleDetail(sched));
    });

  program
    .command("list")
    .description("List recorded dispatches (newest first)")
    .option("-s, --status <status>", "filter by status")
    .option("-n, --limit <n>", "max rows", parseIntegerOption("limit", 1))
    .option("--verbose", "show expanded human-readable rows")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const limit = opts.limit ?? 20;
      const rows = await withClient((c) => c.list({ status: opts.status, limit: opts.json ? limit : limit + 1 }));
      if (opts.json) {
        out(JSON.stringify(rows, null, 2));
      } else {
        const shown = rows.slice(0, limit);
        out(formatRecordList(shown, { limit, verbose: opts.verbose === true, hasMore: rows.length > limit }));
      }
    });

  program
    .command("targets")
    .description("List dispatchable tmux targets (panes) on a machine")
    .option("-m, --machine <id>", "machine to enumerate (local when omitted)")
    .option("-n, --limit <n>", "max rows", parseIntegerOption("limit", 1))
    .option("--verbose", "include compact detection/capability details")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const tmux = new Tmux(await createRunner(opts.machine));
      const allTargets = tmux.listTargets();
      const limit = opts.limit ?? (opts.json ? undefined : 50);
      const selectedTargets = limit === undefined ? allTargets : allTargets.slice(0, limit);
      const targets = opts.json || opts.verbose
        ? selectedTargets.map((target) => ({
            ...target,
            detection: inspectAgentTarget(tmux, target.target, {
              assumeExists: true,
              paneCommand: target.paneCommand,
              cwd: target.cwd,
              panePid: target.panePid,
            }).detection,
          }))
        : selectedTargets;
      if (opts.json) {
        out(JSON.stringify(targets, null, 2));
      } else if (targets.length === 0) {
        out("no tmux targets found");
      } else {
        out(`targets: showing ${targets.length} of ${allTargets.length}${opts.machine ? ` on ${opts.machine}` : ""}`);
        for (const t of targets) {
          const base = `${t.active ? "▸" : " "} ${t.target}  (${t.window})`;
          if (opts.verbose) {
            const d = ("detection" in t ? t.detection : undefined) as AgentTargetInfo | undefined;
            out(`${base}  ${d?.targetKind ?? "unknown"}/${d?.agentKind ?? "unknown"} state=${d?.composerState ?? "unknown"} receive=${d?.canReceivePrompt ?? false} queue=${d?.canQueuePrompt ?? false}`);
          } else {
            out(base);
          }
        }
        out("hint: use --verbose for detection details or --json for full target metadata");
      }
    });

  program
    .command("schedule")
    .description("Queue a dispatch to fire later (--at, --in, --cron, or --every)")
    .requiredOption("-t, --to <target>", "tmux target")
    .option("-p, --prompt <text>", "prompt text (or --file / stdin)")
    .option("-f, --file <path>", "read the prompt from a file")
    .option("--goal", "prefix the delivered prompt with /goal unless it already starts with /goal")
    .option("--name <name>", "optional schedule/loop name")
    .option("-m, --machine <id>", "target machine")
    .option("--at <time>", "one-shot fire time (ISO 8601 or anything Date parses)")
    .option("--in <duration>", "one-shot relative delay, e.g. 30m, 5 minutes, 2h, 1d")
    .option("--cron <expr>", "recurring 5-field cron expression")
    .option("--every <duration>", "recurring interval loop, e.g. 5m or 1 hour")
    .option("--if-idle", "refuse delivery unless the target looks idle when fired")
    .option("--queue", "queue on active agents that prove Tab queued-message support when fired")
    .option("--force-active", "explicitly override active/unknown target refusal when fired")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const stdin = opts.prompt || opts.file ? deps.stdin : deps.stdin ?? (await readStdinIfPiped());
      const prompt = resolvePrompt(opts, stdin);
      const sched = await withClient((c) =>
        c.schedule({
          options: {
            target: opts.to,
            prompt,
            goal: opts.goal === true,
            machine: opts.machine,
            ifIdle: opts.ifIdle === true,
            queue: opts.queue === true,
            forceActive: opts.forceActive === true,
          },
          at: opts.at,
          in: opts.in,
          cron: opts.cron,
          every: opts.every,
          name: opts.name,
        }),
      );
      out(opts.json ? JSON.stringify(sched, null, 2) : formatSchedule(sched));
    });

  program
    .command("loop")
    .description("Create a recurring interval dispatch loop")
    .requiredOption("-t, --to <target>", "tmux target")
    .requiredOption("--every <duration>", "recurring interval, e.g. 5m, 30min, 1 hour")
    .option("-p, --prompt <text>", "prompt text (or --file / stdin)")
    .option("-f, --file <path>", "read the prompt from a file")
    .option("--goal", "prefix the delivered prompt with /goal unless it already starts with /goal")
    .option("--name <name>", "optional loop name")
    .option("-m, --machine <id>", "target machine")
    .option("--if-idle", "refuse delivery unless the target looks idle when fired")
    .option("--queue", "queue on active agents that prove Tab queued-message support when fired")
    .option("--force-active", "explicitly override active/unknown target refusal when fired")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const stdin = opts.prompt || opts.file ? deps.stdin : deps.stdin ?? (await readStdinIfPiped());
      const prompt = resolvePrompt(opts, stdin);
      const sched = await withClient((c) =>
        c.loop({
          options: {
            target: opts.to,
            prompt,
            goal: opts.goal === true,
            machine: opts.machine,
            ifIdle: opts.ifIdle === true,
            queue: opts.queue === true,
            forceActive: opts.forceActive === true,
          },
          every: opts.every,
          name: opts.name,
        }),
      );
      out(opts.json ? JSON.stringify(sched, null, 2) : formatSchedule(sched));
    });

  program
    .command("schedules")
    .description("List scheduled dispatches")
    .option("-s, --status <status>", "filter by status (scheduled | paused | fired | cancelled | failed)")
    .option("--kind <kind>", "filter by kind (schedule | loop)")
    .option("-n, --limit <n>", "max rows", parseIntegerOption("limit", 1))
    .option("--verbose", "show expanded human-readable rows")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const limit = opts.limit ?? 20;
      const rows = await withClient((c) => c.listSchedules({ status: opts.status, kind: opts.kind, limit: opts.json ? limit : limit + 1 }));
      if (opts.json) {
        out(JSON.stringify(rows, null, 2));
      } else {
        const shown = rows.slice(0, limit);
        out(formatScheduleList(shown, { limit, verbose: opts.verbose === true, label: "scheduled dispatches", hasMore: rows.length > limit }));
      }
    });

  program
    .command("loops")
    .description("List recurring interval loops")
    .option("-s, --status <status>", "filter by status (scheduled | paused | cancelled | failed)")
    .option("-n, --limit <n>", "max rows", parseIntegerOption("limit", 1))
    .option("--verbose", "show expanded human-readable rows")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const limit = opts.limit ?? 20;
      const rows = await withClient((c) => c.listLoops({ status: opts.status, limit: opts.json ? limit : limit + 1 }));
      if (opts.json) {
        out(JSON.stringify(rows, null, 2));
      } else {
        const shown = rows.slice(0, limit);
        out(formatScheduleList(shown, { limit, verbose: opts.verbose === true, label: "dispatch loops", hasMore: rows.length > limit }));
      }
    });

  program
    .command("cancel <id>")
    .description("Cancel a scheduled dispatch")
    .action(async (id) => {
      const ok = await withClient((c) => c.cancelSchedule(id));
      if (ok) {
        out(`cancelled ${id}`);
      } else {
        err(`could not cancel ${id} (not found or not scheduled)`);
        process.exitCode = 1;
      }
    });

  program
    .command("pause <id>")
    .description("Pause a scheduled dispatch or loop")
    .action(async (id) => {
      const ok = await withClient((c) => c.pauseSchedule(id));
      if (ok) {
        out(`paused ${id}`);
      } else {
        err(`could not pause ${id} (not found or not scheduled)`);
        process.exitCode = 1;
      }
    });

  program
    .command("resume <id>")
    .description("Resume a paused scheduled dispatch or loop")
    .action(async (id) => {
      const ok = await withClient((c) => c.resumeSchedule(id));
      if (ok) {
        out(`resumed ${id}`);
      } else {
        err(`could not resume ${id} (not found or not paused)`);
        process.exitCode = 1;
      }
    });

  program
    .command("clear <id>")
    .description("Delete a scheduled dispatch or loop")
    .action(async (id) => {
      const ok = await withClient((c) => c.clearSchedule(id));
      if (ok) {
        out(`cleared ${id}`);
      } else {
        err(`could not clear ${id} (not found)`);
        process.exitCode = 1;
      }
    });

  registerDaemonCommands(program, { out, err });

  return program;
}

async function readStdinIfPiped(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? text : undefined;
}

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
