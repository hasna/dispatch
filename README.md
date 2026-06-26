# @hasna/dispatch

**Dispatch prompts to coding agents running in tmux windows — locally and across machines — reliably.**

Driving coding agents (Claude Code, Codex, …) that live in tmux windows by hand with
`tmux send-keys` is flaky: the Enter often doesn't submit (text just sits in the
composer), long prompts get mangled, there's no delivery confirmation, and it doesn't
work across machines. `dispatch` makes this a first-class, reliable tool — with a **CLI**,
an **MCP server**, a programmatic **SDK**, and a **live daemon** for scheduled dispatches.
tmux is the default backend; an optional Open Mosaic backend is available for Mosaic
sessions without changing existing tmux behavior.

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
| Need to know what a pane actually is | **Native agent detection** — Codewith, Codex, Claude Code/Claude, and OpenCode panes are classified from command, process tree, cwd, and live UI proof |
| "Did it actually go through?" | **Smart delivery confirmation** — diffs the pane before/after and detects the agent's working/`esc to interrupt` state and the composer clearing |
| Doesn't work across machines | **Cross-machine** routing through [`@hasna/machines`](https://github.com/hasna/machines) (Tailscale / LAN / SSH) |
| Fire-and-forget / later | **Scheduled dispatches and loops** (`--at` / `--in` / `--cron` / `--every`) owned by a **persistent daemon** that survives restarts |

See [docs/reliability.md](docs/reliability.md) for the full mechanism.

## Install

```bash
bun install -g @hasna/dispatch
# requires tmux on the target host for the default backend; Bun >= 1.0
```

## CLI

```text
dispatch send       Dispatch a prompt to a tmux target and auto-submit it
dispatch exec       Dispatch a filtered shell command to a shell tmux target
dispatch key        Send an allowlisted special key to an agent composer
dispatch capture    Capture a bounded, redacted pane transcript
dispatch status     Show a recorded dispatch, schedule, or loop by id
dispatch show       Show expanded details for a dispatch, schedule, or loop
dispatch list       List recorded dispatches (newest first)
dispatch targets    List dispatchable tmux targets (panes) on a machine
dispatch schedule   Queue a dispatch to fire later (--at, --in, --cron, or --every)
dispatch loop       Create a recurring interval loop (--every)
dispatch schedules  List scheduled dispatches
dispatch loops      List recurring interval loops
dispatch pause      Pause a schedule/loop
dispatch resume     Resume a paused schedule/loop
dispatch clear      Delete a schedule/loop
dispatch cancel     Cancel a scheduled dispatch
dispatch daemon     start | ensure | restart | status | doctor | service | stop
```

### Output defaults

Read/list commands are compact by default so agent terminals do not fill context
with stored prompt bodies or large records:

```bash
dispatch list                  # compact, 20 rows by default
dispatch loops                 # compact, 20 rows by default
dispatch schedules             # compact, 20 rows by default
dispatch targets               # compact, 50 panes by default
dispatch status <id>           # one-line status plus next-step hint
dispatch show <id>             # expanded human-readable details
dispatch status <id> --verbose # expanded human-readable details
dispatch list --limit 50       # request more rows explicitly
dispatch list --limit 50 --json # full stored JSON objects for selected rows
```

Compact rows include ids, status, target, timing, and short prompt previews. Use
`show`/`inspect` or `--verbose` for a bounded detail view, and `--json` when you
really need the full stored object for selected rows. Existing JSON output remains
the machine-readable path and may include full prompt text by design.
When more rows exist beyond the current limit, human output says `more available`;
raise `--limit` deliberately instead of dumping the whole store.

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

# Queue to an active Codewith/Claude pane that proves Tab queued-message support
dispatch send --to open-dispatch:1.1 --prompt "Follow up safely" --queue --dry-run

# Explicit submit key. Tab is accepted only when detection proves queue support.
dispatch send --to open-dispatch:1.1 --prompt "Follow up safely" --submit-key Tab

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
`--goal`, `--submit-key Enter|Tab`, `--queue`, `--no-submit`, `--no-confirm`, `--delay <ms>`, `--retries <n>`,
`--mode auto|paste|literal`, `--backend tmux|mosaic`, `--json`.

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
Plain-text bulk results show the first 20 compact records and an omitted count; use
`--json` for the full bulk result.

Prompt sends now use native terminal-agent detection before typing. JSON outputs from
`dispatch targets --json`, `dispatch status --json`, `dispatch capture --json`, and
bulk send results include detection metadata when available:

```jsonc
{
  "agentKind": "codewith",          // codewith | codex | claude | opencode | unknown
  "targetKind": "agent",            // agent | shell | unknown
  "composerState": "active",        // idle | active | unknown
  "canReceivePrompt": false,
  "canQueuePrompt": true,
  "submitKeys": ["Enter", "Tab"],
  "recommendedSubmitKey": "Tab",
  "reason": "recognized codewith wrapper from process tree and live composer UI; active composer supports queued Tab prompt delivery"
}
```

Normal prompt delivery uses `Enter` and refuses active agents unless `--force-active`
is explicitly passed. `--queue` is the safe active-agent path: when detection proves
the target supports queued-message behavior, dispatch types the prompt and presses
`Tab`; otherwise it refuses. Prompt sends wait until the delivered text is visibly
parked in the composer before pressing Enter/Tab; if it never parks within
`DISPATCH_SETTLE_TIMEOUT_MS`, dispatch refuses the submit key. Queued Tab delivery
is single-shot to avoid duplicate queued follow-up inputs; `--retries` applies to
Enter submission. Detection supports
direct binaries and compatible `node`/`bun`/`npx`/`bunx`/`pnpm`/`yarn`/`npm exec`
launchers, but wrapper panes still need live composer UI proof so arbitrary `node`
output and copied transcripts stay fail-closed.

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
`kind: "key"` with a safe prompt like `<key:Tab>`. `Enter` is refused when the
detected composer is active. `Tab` is refused for agents that do not advertise Tab
support, and active Tab is allowed only when detection proves queued-message support.

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
dispatch targets --verbose       # include detection/capability summary
dispatch targets --machine spark01 --json
```

### Optional Open Mosaic Backend

tmux remains the default backend. To use Open Mosaic, install a `mosaic` binary on
`PATH` and select it explicitly with `--backend mosaic` or set
`DISPATCH_BACKEND=mosaic`. The backend uses the native Mosaic control CLI directly;
it does not use tmux shims. You can override the binary path with
`DISPATCH_MOSAIC_BIN=/path/to/mosaic`.

Mosaic targets use `<session>:<pane_id>` because native prompt delivery requires a
session and pane id. Discover them with:

```bash
dispatch targets --backend mosaic
dispatch targets --backend mosaic --json
```

Examples:

```bash
# Send text through native Mosaic prompt delivery.
dispatch send --backend mosaic --to work:terminal_1 --prompt "status?"

# File input is read by dispatch and delivered as resolved text so the recorded
# prompt always matches what Mosaic receives.
dispatch send --backend mosaic --to work:terminal_1 --file ./prompt.md

# Queue or type without submitting using Mosaic-native flags.
dispatch send --backend mosaic --to work:terminal_1 --prompt "next task" --queue
dispatch send --backend mosaic --to work:terminal_1 --prompt "draft" --no-submit

# Validate via Mosaic's top-level dry-run mode.
dispatch send --backend mosaic --to work:terminal_1 --prompt "status?" --dry-run --json

# Capture recent output through Mosaic.
dispatch capture --backend mosaic --to work:terminal_1 --lines 120
```

Mosaic prompt records include `backend: "mosaic"` and the native receipt in JSON
status/list output. Receipt status `accepted` means the Mosaic server accepted the
write, queue, or no-submit action; it does not prove that the terminal process has
consumed the bytes or completed work. Queued sends preserve queued semantics in the
record confirmation (`confirm.queued: true`), and `--submit-key Tab` maps to Mosaic
queue mode. This first slice supports single-target Mosaic sends and capture; bulk
Mosaic fan-out, `--if-idle` active-state proof, and AI transforms over Mosaic captures
are intentionally left out until the native API stabilizes further. Mosaic `--if-idle`
fails closed unless `--queue` or `--force-active` is passed deliberately.

### Schedule

```bash
# One-shot at a specific time
dispatch schedule --to work:agent --prompt "deploy" --at 2026-06-18T09:00:00Z

# One-shot relative to now
dispatch schedule --to work:agent --prompt "check the deploy" --in 30m
dispatch schedule --machine spark01 --to work:agent --prompt "remote follow-up" --in "5 minutes"

# Recurring (5-field cron)
dispatch schedule --to work:agent --prompt "run nightly suite" --cron "0 2 * * *"

# Recurring interval loop
dispatch loop --to work:agent --prompt "capture status and report blockers" --every 5m --name status-loop

# Mosaic schedules carry the backend option and fire through Mosaic when due.
dispatch schedule --backend mosaic --to work:terminal_1 --prompt "later" --in 30m

dispatch schedules            # list schedules and loops
dispatch loops                # list interval loops
dispatch show <id>            # inspect a dispatch, schedule, or loop
dispatch status <id>          # compact status plus detail hint
dispatch pause <id>           # pause a schedule/loop
dispatch resume <id>          # resume a paused schedule/loop
dispatch cancel <id>          # mark cancelled
dispatch clear <id>           # delete
```

Scheduled dispatches are fired by the **daemon**:

```bash
dispatch daemon ensure        # idempotently start/recover the queue owner
dispatch daemon status        # health, last tick, next due item, failures
dispatch daemon restart       # safe stop + start
dispatch daemon doctor        # small actionable health check
dispatch daemon stop
```

On Linux machines such as `spark02` and `spark01`, install the daemon as a user-level
systemd service so schedules and loops have an always-live owner:

```bash
dispatch daemon service install --start
dispatch daemon service status
dispatch daemon service restart
```

The generated unit is `~/.config/systemd/user/hasna-dispatch-daemon.service`.
It runs `dispatch daemon run` with `Restart=on-failure` and `RestartSec=10s`,
which avoids tight restart loops while recovering from crashes. If you need the
service to survive logout on a Linux host, enable user lingering outside dispatch
with your normal machine-management policy. macOS launchd support is not built in
yet; use `dispatch daemon ensure` there and track launchd as a small follow-up if
needed.

The queue is persisted (sqlite under `~/.hasna/dispatch`), so it **survives a daemon
restart** — a schedule created while the daemon was down still fires once it's back up.
The daemon processes due schedules serially; interval loops compute their next run only
after the previous dispatch attempt completes, so runs do not overlap by default. If a
target is busy or unsafe, the dispatch attempt is recorded as skipped/failed and a loop
waits until its next interval.

Failure behavior is deliberately conservative:

- one-shot schedules retry transient failures every 60s and give up after the retry
  window, then become `failed`;
- cron schedules and interval loops stay `scheduled` and retry at their next cadence;
- each failed attempt records `lastFailureAt`, `lastFailureReason`, and `failureCount`;
- `dispatch daemon status --json` reports `health`, `lastTickAt`, `nextDue`, and
  `recentFailures` without including prompt bodies.

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
const later = dispatch.schedule({
  options: { target: "work:agent", prompt: "follow up" },
  in: "30m",
});
const loop = dispatch.loop({
  options: { target: "work:agent", prompt: "summarize current status" },
  every: "5m",
  name: "status-loop",
});
dispatch.listSchedules();
dispatch.listLoops();
dispatch.pauseSchedule(loop.id);
dispatch.resumeSchedule(loop.id);
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
//   dispatch_send, dispatch_key, dispatch_capture, dispatch_exec, dispatch_status, dispatch_show,
//   dispatch_list, dispatch_targets,
//   dispatch_schedule, dispatch_loop, dispatch_schedules, dispatch_loops,
//   dispatch_cancel, dispatch_pause, dispatch_resume, dispatch_clear,
//   dispatch_daemon_start, dispatch_daemon_stop, dispatch_daemon_status,
//   dispatch_daemon_ensure, dispatch_daemon_restart, dispatch_daemon_doctor,
//   dispatch_daemon_service
```

```bash
dispatch-mcp        # stdio MCP server
```

MCP read/list tools also return compact summaries by default. Pass `verbose: true`
to `dispatch_status`, `dispatch_show`, `dispatch_list`, `dispatch_schedules`,
`dispatch_loops`, `dispatch_targets`, or dispatch-producing tools when an agent
explicitly needs full records.
Compact MCP responses are wrapper objects such as `{ items, count, hasMore }` for
lists or `{ id, status, record }` for single dispatch results; clients that need
the historical raw records should pass `verbose: true`.

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
4. Poll until the prompt tail is visibly parked in the composer. Claude's collapsed
   `[Pasted text]` placeholder counts only when it newly appears after delivery, so
   stale hidden composer content cannot spoof the settle gate.
5. Press **Enter**, then re-press until the **delivery probe** confirms submission
   (working indicator appeared / composer cleared) or the submit timeout/retries are exhausted.
   Queued Tab delivery is not retried because duplicate Tabs can create duplicate
   queued follow-up inputs.
6. Record a **delivered / not-delivered** verdict with a reason. If a Codewith
   pane queues input while an auth profile/account switch is visible, the verdict
   is **not delivered** with `actionNeeded=true` rather than a false success.

## Environment

| Variable | Purpose |
|---|---|
| `DISPATCH_DATA_DIR` | State dir (default `~/.hasna/dispatch`) |
| `DISPATCH_MIN_DELAY_MS` / `DISPATCH_MAX_DELAY_MS` | Clamp for the auto delay |
| `DISPATCH_MS_PER_WORD` / `DISPATCH_MS_PER_CHAR` | Auto-delay coefficients |
| `DISPATCH_SETTLE_TIMEOUT_MS` | Prompt-parked settle budget before the first submit key; default 2000ms |
| `DISPATCH_SUBMIT_TIMEOUT_MS` / `DISPATCH_SUBMIT_RETRY_INTERVAL_MS` | Submit confirmation/retry budget; defaults 10000ms / 2000ms |
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
