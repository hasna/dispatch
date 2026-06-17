# AGENTS.md — working in `open-dispatch`

`@hasna/dispatch` dispatches prompts to coding agents in tmux windows reliably:
CLI + MCP + SDK + a live daemon. This file orients an agent (or human) contributing here.

## Stack & layout

- **Bun + TypeScript**, `type: module`, strict tsconfig.
- Surfaces mirror `open-todos`: a **CLI** (`dispatch`), an **MCP server**
  (`dispatch-mcp`), a **daemon** (`dispatch-daemon`), and an **SDK** (`@hasna/dispatch/sdk`).

```
src/
  types.ts            core types (DispatchOptions/Record, ScheduledDispatch, ConfirmResult)
  index.ts            root exports
  lib/
    runner.ts         Runner abstraction — LocalRunner (spawnSync) / RemoteRunner (@hasna/machines)
    tmux.ts           tmux wrapper (send-keys, capture-pane, list-panes, load/paste-buffer)
    delay.ts          computeSubmitDelay — auto pre-Enter delay from word/char count
    submit.ts         submit() — wait + Enter + retry-until-confirmed
    confirm.ts        evaluateDelivery / confirmDelivery — pane-diff delivery detection
    engine.ts         performDispatch — deliver → submit → confirm → record
    store.ts          sqlite store (dispatches + schedules)
    schedule.ts       at + 5-field cron next-run
    scheduler.ts      tick() — fire due schedules, reschedule cron
    ids.ts / paths.ts / version.ts
  sdk/index.ts        DispatchClient (send/status/list/schedule/…)
  cli/                commander CLI + daemon-commands + format
  mcp/                tools.ts (verb defs) + index.ts (McpServer)
  daemon/             loop.ts, control.ts (pidfile), daemon.ts (runDaemon/startDaemon)
  test/               MockRunner + fixtures (fake-agent, bracket-sink)
```

## The Runner abstraction (read this first)

Everything tmux goes through a `Runner` that executes an **argv array**:

- `LocalRunner` → `spawnSync`.
- `RemoteRunner` → wraps the argv into one shell command and runs it via
  `@hasna/machines`' `resolveMachineCommand` (Tailscale/LAN/SSH), with a plain-`ssh`
  fallback when the optional dep is absent.

So the **same** tmux code targets any machine; cross-machine is just a different runner.
`@hasna/machines` is an **optional** dependency, dynamically imported.

## Conventions

- **TDD.** Tests first; every bug fix gets a regression test. Unit tests use `MockRunner`
  (`src/test/mock-runner.ts`); integration tests drive a **real tmux** session with the
  `fake-agent` fixture and are guarded by tmux availability.
- **CLI/MCP parity** is enforced by a test (`src/mcp/tools.test.ts`): every MCP verb has a
  CLI command and vice versa. Add a verb? Add it to both.
- **Determinism in tests.** Inject `sleep`/`now`/`shouldStop`; never rely on wall-clock
  except in real-tmux integration tests (which use generous waits — delivery against a
  real pane takes a few seconds).
- **No env leaks in tests.** Pass `--delay` / args rather than mutating `process.env`
  (the auto-delay reads env globals).
- Conventional commits, **no `Co-Authored-By`**. Scan staged files for secrets before
  every commit/push. Patch-version bumps only.

## Commands

```bash
bun install
bun test                 # full suite (unit + real-tmux integration)
bun test src/lib/...     # a subset
bun run typecheck
bun run build            # bun build per entry + tsc --emitDeclarationOnly
```

## Gotchas (learned the hard way)

- `tmux display-message -t <bad>` exits 0 and falls back to the current pane inside tmux
  → use `list-panes -t` for existence checks.
- `paste-buffer -p` only emits bracketed-paste markers when the receiving app enabled
  DECSET 2004; plain shells won't show them (correct behavior).
- Hosts may use `base-index 1`; target the session name to hit its active pane.
- `daemon stop` must **wait** for the process to die (SIGTERM returns immediately); the
  loop's wait is sliced so a stop signal is honored within ~200ms.
- `DISPATCH_DAEMON_INTERVAL_MS` is read inside `runDaemon`, so `daemon start` honors it.
