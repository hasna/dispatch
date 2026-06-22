#!/usr/bin/env bun
import { Command } from "commander";
import { getPackageVersion } from "../lib/version.js";
import { DispatchClient } from "../sdk/index.js";
import type { CaptureOptions, CaptureTransform, DispatchOptions, ExecOptions, KeyOptions } from "../types.js";
import { formatCapture, formatRecord, formatSchedule, resolvePrompt } from "./format.js";
import { registerDaemonCommands } from "./daemon-commands.js";
import { Tmux } from "../lib/tmux.js";
import { createRunner } from "../lib/runner.js";
import { loadExecPolicy } from "../lib/exec-policy.js";

export interface CliDeps {
  /** Factory for the client; when provided, the CLI will NOT close it (tests own it). */
  clientFactory?: () => DispatchClient;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Pre-read stdin content (piped prompt). */
  stdin?: string;
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
    .requiredOption("-t, --to <target>", "tmux target, e.g. session:window or session:window.pane")
    .option("-p, --prompt <text>", "prompt text (or use --file / stdin)")
    .option("-f, --file <path>", "read the prompt from a file")
    .option("--goal", "prefix the delivered prompt with /goal unless it already starts with /goal")
    .option("-m, --machine <id>", "target machine (via @hasna/machines); local when omitted")
    .option("--no-submit", "type into the composer but do not press Enter")
    .option("--no-confirm", "skip delivery confirmation")
    .option("--delay <ms>", "override the auto-computed pre-Enter delay", (v) => parseInt(v, 10))
    .option("--retries <n>", "max Enter retries if not confirmed", (v) => parseInt(v, 10))
    .option("--mode <mode>", "delivery mode: auto | paste | literal", "auto")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const stdin = opts.prompt || opts.file ? deps.stdin : deps.stdin ?? (await readStdinIfPiped());
      const prompt = resolvePrompt(opts, stdin);
      const options: DispatchOptions = {
        target: opts.to,
        prompt,
        goal: opts.goal === true,
        machine: opts.machine,
        submit: opts.submit,
        confirm: opts.confirm,
        submitDelayMs: opts.delay,
        maxSubmitRetries: opts.retries,
        mode: opts.mode,
      };
      const rec = await withClient((c) => c.send(options));
      out(opts.json ? JSON.stringify(rec, null, 2) : formatRecord(rec));
      if (rec.status === "failed") process.exitCode = 1;
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
    .description("Show a recorded dispatch by id")
    .option("--json", "output JSON")
    .action(async (id, opts) => {
      const rec = await withClient((c) => c.status(id));
      if (!rec) {
        err(`dispatch not found: ${id}`);
        process.exitCode = 1;
        return;
      }
      out(opts.json ? JSON.stringify(rec, null, 2) : formatRecord(rec));
    });

  program
    .command("list")
    .description("List recorded dispatches (newest first)")
    .option("-s, --status <status>", "filter by status")
    .option("-n, --limit <n>", "max rows", (v) => parseInt(v, 10), 20)
    .option("--json", "output JSON")
    .action(async (opts) => {
      const rows = await withClient((c) => c.list({ status: opts.status, limit: opts.limit }));
      if (opts.json) {
        out(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        out("no dispatches yet");
      } else {
        for (const r of rows) out(formatRecord(r));
      }
    });

  program
    .command("targets")
    .description("List dispatchable tmux targets (panes) on a machine")
    .option("-m, --machine <id>", "machine to enumerate (local when omitted)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const tmux = new Tmux(await createRunner(opts.machine));
      const targets = tmux.listTargets();
      if (opts.json) {
        out(JSON.stringify(targets, null, 2));
      } else if (targets.length === 0) {
        out("no tmux targets found");
      } else {
        for (const t of targets) out(`${t.active ? "▸" : " "} ${t.target}  (${t.window})`);
      }
    });

  program
    .command("schedule")
    .description("Queue a dispatch to fire later (one-shot --at or recurring --cron)")
    .requiredOption("-t, --to <target>", "tmux target")
    .option("-p, --prompt <text>", "prompt text (or --file / stdin)")
    .option("-f, --file <path>", "read the prompt from a file")
    .option("--goal", "prefix the delivered prompt with /goal unless it already starts with /goal")
    .option("-m, --machine <id>", "target machine")
    .option("--at <time>", "one-shot fire time (ISO 8601 or anything Date parses)")
    .option("--cron <expr>", "recurring 5-field cron expression")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const stdin = opts.prompt || opts.file ? deps.stdin : deps.stdin ?? (await readStdinIfPiped());
      const prompt = resolvePrompt(opts, stdin);
      const sched = await withClient((c) =>
        c.schedule({
          options: { target: opts.to, prompt, goal: opts.goal === true, machine: opts.machine },
          at: opts.at,
          cron: opts.cron,
        }),
      );
      out(opts.json ? JSON.stringify(sched, null, 2) : formatSchedule(sched));
    });

  program
    .command("schedules")
    .description("List scheduled dispatches")
    .option("-s, --status <status>", "filter by status (scheduled | fired | cancelled)")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const rows = await withClient((c) => c.listSchedules({ status: opts.status }));
      if (opts.json) {
        out(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        out("no scheduled dispatches");
      } else {
        for (const s of rows) out(formatSchedule(s));
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
