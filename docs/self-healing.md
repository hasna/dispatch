# Dispatch self-healing runbook

This runbook is for agents and coordinators recovering a failed dispatch route.
The goal is to repair the owning package path so agents do not fall back to
manual tmux prompt paste.

## Safety rules

- Do not paste prompts into tmux panes as a fallback unless the user explicitly
  authorized a legacy/emergency handoff for this incident.
- Keep failure evidence bounded and redacted. Do not record API keys, tokens,
  credentials, full prompt bodies, or unbounded pane transcripts.
- Diagnose first, then mutate. The self-heal diagnosis command is read-only and
  must not modify repos, daemon state, package installs, or machine config.
- If a needed fix belongs in another package, create an owning-package todo
  instead of adding permanent local scripts or shell glue.
- Related machines to check during dispatch incidents are `spark01`, `spark02`,
  and `apple03`. Ignore `apple01` if it is nonresponsive unless the incident
  evidence specifically proves `apple01` is the intended route owner.

## Read-only diagnosis

Use bounded text from the failed route, such as a compact error line, a
`status --json` excerpt, daemon doctor output, or a short target/capture summary.
The command redacts common credential shapes and emits a recommended next action.

```bash
dispatch self-heal diagnose \
  --to work:agent \
  --machine spark01 \
  --route "sessions-query:open-router" \
  --error "target not found" \
  --json
```

For larger evidence, write the sample to a temporary file and pass
`--error-file` or `--status-file`. The CLI reads only bounded head/tail bytes
from those files, and all returned redacted fields are capped with truncation
metadata so full prompts, pane captures, and payload tails are not echoed.

```bash
dispatch self-heal diagnose --error-file /tmp/dispatch-failure.txt --json
```

The diagnosis classifies the failure into one of these buckets:

| Bucket | Typical signal | Owning repair path |
|---|---|---|
| `target` | target missing, unsafe shell pane, active composer, prompt never parked | fix target discovery/state in `open-dispatch` or wait for a safe target |
| `auth` | 401/403, auth profile switch, account limit, logged out, credential problem | repair the target agent account/profile state before retrying |
| `machine` | SSH/Tailscale failure, host unreachable, machine not found, remote timeout | check `spark01`/`spark02`/`apple03`; durable reachability abstractions belong in `open-machines` |
| `stale_package` | unknown option/command, missing dist file, version mismatch, broken install | patch-publish `@hasna/dispatch`, update affected machines, then restart daemons |
| `routing` | sessions-query/source mapping failure, no live sessions, route mismatch | fix route execution in `open-dispatch`; source/config gaps belong in `open-todos`, `open-configs`, or `open-machines` |
| `dispatch_bug` | unhandled exception, stack trace, sqlite/internal invariant | fix `open-dispatch` with a regression test before publish/update |

`unknown` means the sample was too thin. Capture one more bounded redacted status
sample and classify manually before changing state.

## Capture and redact

1. Capture the smallest useful status: command, target, machine, route source,
   error summary, package version if known, and daemon health if schedules are
   involved.
2. Prefer bounded package output over raw terminal history. Use compact read
   paths and explicit limits.
3. Redact before commenting on todos, issues, chat, or commit messages. Never
   include raw bearer tokens, npm tokens, GitHub tokens, cloud keys, or passwords.
4. If a pane capture is required, keep it to the relevant tail and use the
   package capture redaction path. Do not attach full scrollback.

## Repair routing

Use the diagnosis bucket to choose the owning package:

- `open-dispatch`: delivery behavior, target safety, confirmation, daemon queue,
  route execution, CLI/MCP/SDK surfaces, and self-heal diagnosis.
- `open-machines`: durable machine inventory, reachability, SSH/Tailscale route
  resolution, and fleet-level machine checks.
- `open-configs`: durable config/profile distribution gaps.
- `open-todos`: task identity, task-triggered routing, dedupe, and lifecycle
  workflow gaps.

If the repair needs an abstraction that does not exist yet, create or update a
todo in the owning package. Temporary local scripts are allowed only to prove a
behavior during the incident; they must not become the permanent route.

## Package fix, publish, update

For `stale_package` or `dispatch_bug`:

1. Reproduce with a bounded fixture or dry-run path.
2. Make the smallest package change in `open-dispatch`.
3. Add or update tests that fail without the fix.
4. Run focused tests, typecheck, and build when feasible.
5. Commit and push a task branch.
6. Patch-publish only after review acceptance and the normal release gate.
7. Update installed `@hasna/dispatch` on local, `spark01`, `spark02`, and
   `apple03` as required by the incident. Keep Bun's release-age policy in mind
   for newly published packages.

## Daemon restart

Restart only after the package/config repair is in place and the queue owner is
known. For scheduled routes, the daemon lives on the machine where the schedule
state is stored.

```bash
dispatch daemon doctor --json
dispatch daemon restart --json
dispatch daemon status --json
```

If a daemon restart fails because machine reachability is broken, classify the
incident as `machine` and repair that route before retrying the daemon step.

## Smoke the original route

The smoke must prove the original route is fixed without leaking prompt content.

1. Re-run the original route in a dry-run/no-secret mode where supported.
2. Re-check target discovery and daemon health if the route depends on them.
3. Send only a harmless smoke prompt after the dry-run path passes and the user
   has not forbidden delivery.
4. Record the branch, commit, package version if published, machine update
   status, daemon restart result, and smoke result on the task.

If the dry-run still fails, do not use tmux paste fallback. Re-enter diagnosis
with the new redacted error and route the repair to the owning package.
