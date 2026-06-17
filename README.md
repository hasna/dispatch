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

# Target a pane explicitly, and another machine
dispatch send --machine spark01 --to work:agent.1 --prompt "build it" --json
```

Key flags: `--to <session:window[.pane]>`, `--prompt`/`--file`/stdin, `--machine`,
`--no-submit`, `--no-confirm`, `--delay <ms>`, `--retries <n>`,
`--mode auto|paste|literal`, `--json`.

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

One-shot helper: `import { dispatch } from "@hasna/dispatch"`.

## MCP

Every CLI verb is also an MCP tool, so agents can dispatch over MCP:

```jsonc
// register the server: dispatch-mcp  (stdio)
// tools:
//   dispatch_send, dispatch_status, dispatch_list, dispatch_targets,
//   dispatch_schedule, dispatch_schedules, dispatch_cancel,
//   dispatch_daemon_start, dispatch_daemon_stop, dispatch_daemon_status
```

```bash
dispatch-mcp        # stdio MCP server
```

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
