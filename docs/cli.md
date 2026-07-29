# CLI reference

`dispatch` defaults to local SQLite and tmux. Commands with `--machine` use
`@hasna/machines` when available and plain SSH otherwise. Commands with
`--backend` accept `tmux` or `mosaic`. Prompt input resolves in order from
`--prompt`, `--file`, then piped stdin; empty prompts are rejected.

## Delivery commands

- `send` sends one prompt or performs a guarded bulk send. Select one `--to`,
  comma-separated `--to` values, or `--from sessions-query`. Controls include
  `--goal`, `--machine`, `--backend`, `--if-idle`, `--queue`, `--submit-key`,
  `--force-active`, `--capture-before`, `--dry-run`, `--max-concurrency`,
  `--jitter`, `--per-machine-limit`, `--no-submit`, `--no-confirm`, `--delay`,
  `--retries`, `--mode`, and `--json`. Bulk defaults to the idle guard and is
  tmux-only; Mosaic supports single-target send, dry-run, queue, and no-submit.
- `exec` sends a policy-filtered command only to a detected shell pane. It accepts
  `--policy`, repeatable `--allow-prefix`, `--no-filter`, `--dry-run`,
  `--interrupt`, the submit controls above, `--machine`, and `--json`. Dry-run
  records and prints the exact plan without typing.
- `key` sends one allowlisted key to a recognized agent composer. Supported keys
  include Enter/Return, Tab, Escape/Esc, arrows, Backspace, Delete, Home, End,
  PageUp, and PageDown. Shell and unproven wrapper panes are refused.
- `capture` captures bounded, control-stripped, credential-redacted output.
  `--lines` defaults to 200 and caps at 2000. AI controls are `--ai`,
  `--transform summary|blockers|changes|next-steps`, `--prompt`, `--provider`, and
  `--model`; backend, machine, and JSON controls also apply.
- `triage` returns bounded redacted target state and a recovery action. It accepts
  `--lines`, `--excerpt-chars`, `--no-excerpt`, `--artifact`, `--no-queue`,
  `--machine`, and `--json`. Artifacts cannot escape the dispatch artifacts dir.
- `recover` runs triage and plans by default; nothing is typed without `--apply`.
  It accepts prompt input, `--goal`, triage bounds, `--queue`, `--force-active`,
  `--capture-before`, `--machine`, and `--json`.

## Inspection commands

- `status <id>` finds a dispatch, schedule, or loop. `--verbose` expands human
  output; `--json` returns the object. `show <id>` is the expanded detail path.
- `list` lists dispatch records newest first with `--status`, `--limit`,
  `--verbose`, and `--json`.
- `targets` lists tmux or Mosaic targets with `--machine`, `--backend`, `--limit`,
  `--all`, `--verbose`, and `--json`. It caps output at 50 unless explicitly
  changed; JSON remains bounded unless `--all` is supplied.
- `fleet summary` returns bounded tmux classifications. Options are repeatable or
  comma-separated `--target`, `--limit` (default 20, max 200),
  `--max-pane-chars` (default 4000, max 12000), `--changed-since`, `--require-ai`,
  `--machine`, and `--json`.

Human dispatch/schedule/loop lists default to 20 rows and report more available.
JSON returns full selected objects and may contain full prompts.

## Schedule commands

- `schedule` requires exactly one of `--at`, `--in`, `--cron`, or `--every`; it
  also accepts target, prompt, goal, name, machine, backend, safety, and JSON options.
- `loop` requires `--every` and is the explicit interval form.
- `schedules` filters by `--status`, `--kind`, and `--limit`; `loops` is the
  interval-only list with `--status` and `--limit`. Both support verbose/JSON.
- `cancel <id>` cancels waiting work, `pause <id>` pauses it, `resume <id>`
  computes a future run, and `clear <id>` permanently deletes it.

See [scheduling.md](scheduling.md) for persistence, retries, and daemon ownership.

## Daemon and diagnosis

`daemon` provides `start`, idempotent `ensure`, safe `restart`, waiting `stop`,
`status`, `doctor`, and `service <install|start|stop|restart|status|uninstall>`.
`service install --start` starts after writing the unit. `daemon run [--interval]`
is the foreground process-supervisor entry used internally.

`self-heal diagnose` is read-only. It accepts direct or file evidence for error
and status plus target, machine, route/source/operation, package version, daemon
health, and JSON fields. Evidence is bounded and redacted before classification.
See [self-healing.md](self-healing.md).

## Exit behavior

Delivery exits nonzero for failed/refused/skipped outcomes except a valid dry-run
plan. Capture exits nonzero when capture or a requested AI transform fails.
Lookup/lifecycle commands exit nonzero for absent ids or invalid transitions.
Structured remote errors do not include credentials or raw transport output.

Runtime help (`dispatch --help` and `dispatch <command> --help`) is authoritative
for exact syntax. MCP response conventions are in [sdk-mcp.md](sdk-mcp.md).
