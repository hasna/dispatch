# @hasna/dispatch

**Dispatch prompts to coding agents running in tmux windows — locally and across machines — reliably.**

Driving coding agents (Claude Code, Codex, …) that live in tmux windows by hand with
`tmux send-keys` is flaky: the Enter often doesn't submit (text just sits in the
composer), long prompts get mangled, there's no delivery confirmation, and it doesn't
work across machines. `dispatch` makes this a first-class, reliable tool — with a **CLI**,
an **MCP server**, a programmatic **SDK**, and a **live daemon** for scheduled dispatches.

```bash
bun install -g @hasna/dispatch        # or: npm install -g @hasna/dispatch
dispatch send --to work:agent --prompt "Refactor the parser and add tests"
```

## Why it's reliable

| Problem | How `dispatch` solves it |
|---|---|
| Enter doesn't submit (text stuck in composer) | **Auto-calculated delay** before Enter (derived from word/char count), then **Enter-with-retry** until delivery is confirmed |
| Long / multi-line prompts get mangled or submit early | **Bracketed paste** via a tmux buffer — the whole prompt arrives as one paste, newlines and all, with no premature submit |
| Prompt text accidentally lands in a shell | **Target-class checks** — `dispatch send` refuses detected shell panes; shell commands must use `dispatch exec` |
| Shell command dispatch needs guardrails | **Exec security filter** — shell targets only, allowlisted command prefixes, destructive/exfiltration blockers, dry-run audit, and no `C-c` unless explicitly requested |
| Need to press a special key deliberately | **Safe key dispatch** — `dispatch key` only allows named safe keys and still refuses shells / unproven wrapper panes |
| Need to inspect what happened in a pane | **Bounded capture** — `dispatch capture` captures recent transcript lines, strips terminal controls, and redacts obvious secrets before output or optional AI transforms |
| Need to fan out prompts across live agent sessions | **Bulk/session orchestration** — `dispatch send` supports idle guards, dry-run, jitter/concurrency caps, pre-capture, and fixed `sessions live/status --json` registry probes |
| "Did it actually go through?" | **Smart delivery confirmation** — diffs the pane before/after and detects the agent's working/`esc to interrupt` state and the composer clearing |
| Doesn't work across machines | **Cross-machine** routing through [`@hasna/machines`](https://github.com/hasna/machines) (Tailscale / LAN / SSH) |
| Fire-and-forget / later | **Scheduled dispatches** (`--at` / `--cron`) owned by a **persistent daemon** that survives restarts |

See [docs/reliability.md](docs/reliability.md) for the full mechanism.

## Install

```bash
bun install -g @hasna/dispatch
# requires tmux on the target host; Bun >= 1.0
```

## CLI

```text
dispatch send       Dispatch a prompt to a tmux target and auto-submit it
dispatch exec       Dispatch a filtered shell command to a shell tmux target
dispatch key        Send an allowlisted special key to an agent composer
dispatch capture    Capture a bounded, redacted pane transcript
dispatch status     Show a recorded dispatch by id
dispatch list       List recorded dispatches (newest first)
dispatch targets    List dispatchable tmux targets (panes) on a machine
dispatch schedule   Queue a dispatch to fire later (--at or --cron)
dispatch schedules  List scheduled dispatches
dispatch cancel     Cancel a scheduled dispatch
dispatch daemon     start | stop | status | run  (scheduled-dispatch queue)
```

### Send

```bash
# Short prompt (typed literally), auto-submitted with delivery confirmation
dispatch send --to work:agent --prompt "run the tests"

# Long / multi-line prompt from a file (bracketed paste, no premature submit)
dispatch send --to work:agent --file ./prompt.md

# From stdin
git diff | dispatch send --to work:agent --prompt "review this diff" 

# Type without submitting (leave it in the composer)
dispatch send --to work:agent --prompt "draft" --no-submit

# Create a Codewith goal from the delivered prompt
dispatch send --goal --to open-browser:1.1 --prompt "Fix native chat..."

# Bulk-send to explicit targets with safety guards and pre-capture
dispatch send --to open-a:1.1,open-b:1.1 --prompt "Run smoke tests" \
  --if-idle --dry-run --capture-before 120 --max-concurrency 2 --jitter 500

# Resolve targets from an open-sessions registry when available
dispatch send --from sessions-query --sessions-query open-router \
  --prompt "Fix native chat..." --goal --dry-run

# Target a pane explicitly, and another machine
dispatch send --machine spark01 --to work:agent.1 --prompt "build it" --json
```

Key flags: `--to <session:window[.pane]>`, `--prompt`/`--file`/stdin, `--machine`,
`--goal`, `--no-submit`, `--no-confirm`, `--delay <ms>`, `--retries <n>`,
`--mode auto|paste|literal`, `--json`.

`--goal` prefixes the delivered prompt with `/goal ` unless it already starts with
`/goal`. The prefix happens after `--prompt`/`--file`/stdin resolution and before
delivery/recording, so multiline prompt contents are preserved.

Bulk/session orchestration flags: `--if-idle`, `--queue`, `--force-active`,
`--capture-before <lines>`, `--dry-run`, `--max-concurrency <n>`, `--jitter <ms>`,
and `--per-machine-limit <n>`. A comma-separated `--to` list uses explicit bulk
dispatch. `--from sessions-query` asks the `sessions` CLI for fixed JSON commands
only (`sessions live --json --once`, then `sessions status --json`) and filters with
`--sessions-query`; it does not execute arbitrary shell text. Bulk sends default to
`--if-idle`, so active targets are skipped unless `--queue` or
`--force-active` is passed. `--capture-before` stores a bounded redacted transcript
on each dispatch record for later `dispatch status` / `dispatch list` audit context.

### Key

`dispatch key` is for deliberate special keys, not arbitrary tmux key names. It reuses
the same agent-composer safety checks as `dispatch send`, so shells and arbitrary
`node`/`bun` panes are refused.

```bash
dispatch key --to open-browser:1.1 --key Tab
dispatch key --to open-browser:1.1 --key Enter --json
```

Allowed keys: `Enter`, `Tab`, `Escape`, `Up`, `Down`, `Left`, `Right`, `Backspace`,
`Delete`, `Home`, `End`, `PageUp`, `PageDown`. Control keys such as `C-c` are not
accepted. Key dispatches are recorded in `dispatch list` / `dispatch status` as
`kind: "key"` with a safe prompt like `<key:Tab>`.

### Capture

`dispatch capture` is read-only. It captures a bounded recent transcript from a tmux
pane locally or through `--machine`, strips common terminal control sequences, returns
only the requested tail lines, and redacts obvious secret-looking values before plain
or JSON output.

```bash
dispatch capture --to open-browser:1.1 --lines 200
dispatch capture --to open-browser:1.1 --lines 200 --json
dispatch capture --to open-browser:1.1 --lines 200 --ai --transform summary
dispatch capture --to open-browser:1.1 --lines 200 --ai \
  --prompt "Summarize what the agent did and list blockers"
```

Default capture size is 200 lines; requests are capped at 2000 lines. Redaction covers
common API-key/token/password shapes (`sk-*`, GitHub/GitLab/Slack tokens, AWS access
keys, bearer tokens, and `token=`/`password=`-style values). It is a safety layer, not
a guarantee that every possible secret format is removed.

AI transforms are optional and run only over the redacted transcript. Configure them
with environment variables:

```bash
DISPATCH_AI_PROVIDER=groq       # groq | cerebras | openai | none
GROQ_API_KEY=...
DISPATCH_AI_MODEL=llama-3.3-70b-versatile   # optional override
DISPATCH_AI_BASE_URL=https://...             # optional OpenAI-compatible endpoint override
```

Provider-specific keys/models are also supported: `GROQ_API_KEY`/`GROQ_MODEL`,
`CEREBRAS_API_KEY`/`CEREBRAS_MODEL`, and `OPENAI_API_KEY`/`OPENAI_MODEL`. If `--ai`
is requested without credentials, capture still returns the raw redacted transcript
and reports an actionable AI failure.

### Exec

`dispatch exec` is for shell commands, not agent prompts. It refuses detected agent
composer panes, and `dispatch send` refuses detected shell panes so prompt text cannot
accidentally execute in bash.

```bash
# Validate the target, command filter, and exact tmux input without typing.
dispatch exec --to open-mailery:01 --command "mailery status" --dry-run

# Submit a reviewed safe command to a detected shell pane.
dispatch exec --to open-mailery:01 \
  --command "cd ~/workspace/hasna/opensource/open-emails && mailery doctor" \
  --allow ./dispatch-exec-policy.json

# Prompts still use send.
dispatch send --to open-mailery:01 --file ./goal.md
```

The exec filter blocks destructive patterns such as root/home removal, filesystem
formatting, fork bombs, `curl|bash`, credential-looking network exfiltration, and
rewrites under `~/.ssh`. Commands must match a built-in safe prefix or an allow prefix
from a reviewed JSON policy file:

```json
{
  "allowPrefixes": ["git reset --hard"],
  "allowGitResetHardPaths": ["/home/hasna/workspace/hasna/opensource/open-dispatch"],
  "allowTargets": ["open-dispatch:*"]
}
```

Use `--allow ./dispatch-exec-policy.json` for that file. `git reset --hard` is refused
unless the command first `cd`s into an allowed path. Non-dry-run exec requires
`allowTargets` in a policy file; dry-run can run without one. `dispatch exec` rejects
shell chaining, pipes, redirects, command substitution, and background operators except
for the single reviewed form `cd <path> && <allowlisted-command>`. It sends the command
with tmux `load-buffer` / `paste-buffer -p`, then Enter; it never sends `C-c` unless
`--force-interrupt` is passed. Exec records appear in `dispatch list` / `dispatch status`
with command hash, target kind, filter result, and delivered/skipped status. Persisted
records store redacted command placeholders plus the hash rather than the raw command.

### Discover targets

```bash
dispatch targets                 # panes on this machine
dispatch targets --machine spark01 --json
```

### Schedule

```bash
# One-shot at a specific time
dispatch schedule --to work:agent --prompt "deploy" --at 2026-06-18T09:00:00Z

# Recurring (5-field cron)
dispatch schedule --to work:agent --prompt "run nightly suite" --cron "0 2 * * *"

dispatch schedules            # list
dispatch cancel <id>          # cancel
```

Scheduled dispatches are fired by the **daemon**:

```bash
dispatch daemon start         # background process owning the queue
dispatch daemon status        # running? how many scheduled / fired?
dispatch daemon stop
```

The queue is persisted (sqlite under `~/.hasna/dispatch`), so it **survives a daemon
restart** — a schedule created while the daemon was down still fires once it's back up.

## SDK

```ts
import { DispatchClient } from "@hasna/dispatch/sdk";

const dispatch = new DispatchClient();

const rec = await dispatch.send({
  target: "work:agent",
  prompt: "Refactor the auth module and add tests",
  machine: "spark01",        // optional; local when omitted
});
console.log(rec.status, rec.confirm?.reason); // "delivered", "working/interrupt indicator appeared after submit"

// schedule + inspect
const sched = dispatch.schedule({
  options: { target: "work:agent", prompt: "nightly" },
  cron: "0 2 * * *",
});
dispatch.listSchedules();
dispatch.status(rec.id);
dispatch.close();
```

```ts
const execRec = await dispatch.exec({
  target: "open-mailery:01",
  command: "mailery status",
  dryRun: true,
});
console.log(execRec.commandHash, execRec.filter?.code);
```

```ts
const keyRec = await dispatch.key({ target: "work:agent", key: "Tab" });
const cap = await dispatch.capture({ target: "work:agent", lines: 120 });
console.log(keyRec.status, cap.text);
```

```ts
const bulk = await dispatch.bulkSend({
  source: "sessions-query",
  sessionsQuery: "open-router",
  prompt: "Fix native chat...",
  goal: true,
  dryRun: true,
  maxConcurrency: 2,
  jitterMs: 500,
  captureBeforeLines: 120,
});
console.log(bulk.planned, bulk.skipped, bulk.failed);
```

One-shot helpers: `import { dispatch, dispatchBulk, dispatchExec, dispatchKey, dispatchCapture } from "@hasna/dispatch"`.

## MCP

Every CLI verb is also an MCP tool, so agents can dispatch over MCP:

```jsonc
// register the server: dispatch-mcp  (stdio)
// tools:
//   dispatch_send, dispatch_key, dispatch_capture, dispatch_exec, dispatch_status, dispatch_list, dispatch_targets,
//   dispatch_schedule, dispatch_schedules, dispatch_cancel,
//   dispatch_daemon_start, dispatch_daemon_stop, dispatch_daemon_status
```

```bash
dispatch-mcp        # stdio MCP server
```

`dispatch_exec` accepts `policyFile` for the same reviewed JSON policy used by
CLI `--allow`; it does not accept inline allowlists from the caller.

## How auto-submit works (the key feature)

1. Snapshot the pane.
2. Deliver the prompt — **literal** `send-keys` for short single-line text, **bracketed
   paste** (tmux buffer + `paste-buffer -p`) for long/multi-line text so embedded
   newlines are treated as text, not submits.
3. Wait an **auto-computed delay** (`min + words·k₁ + chars·k₂`, clamped) so the whole
   prompt is registered before Enter. Tune via `--delay` or
   `DISPATCH_MIN_DELAY_MS` / `DISPATCH_MAX_DELAY_MS` / `DISPATCH_MS_PER_WORD` /
   `DISPATCH_MS_PER_CHAR`.
4. Press **Enter**, then re-press until the **delivery probe** confirms submission
   (working indicator appeared / composer cleared) or retries are exhausted.
5. Record a **delivered / not-delivered** verdict with a reason.

## Environment

| Variable | Purpose |
|---|---|
| `DISPATCH_DATA_DIR` | State dir (default `~/.hasna/dispatch`) |
| `DISPATCH_MIN_DELAY_MS` / `DISPATCH_MAX_DELAY_MS` | Clamp for the auto delay |
| `DISPATCH_MS_PER_WORD` / `DISPATCH_MS_PER_CHAR` | Auto-delay coefficients |
| `DISPATCH_DAEMON_INTERVAL_MS` | Daemon tick interval |

## Development

```bash
bun install
bun test          # unit + real-tmux integration tests
bun run typecheck
bun run build
```

See [AGENTS.md](AGENTS.md) for repo conventions and [docs/](docs/) for architecture,
reliability, and cross-machine details.

## License

Apache-2.0 © Hasna, Inc.
