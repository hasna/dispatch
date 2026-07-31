# Architecture

`@hasna/dispatch` is layered so the same core engine powers four surfaces.

```
            CLI (dispatch)      MCP (dispatch-mcp)      Daemon (dispatch-daemon)
                  \                   |                        /
                   \                  |                       /
                          SDK  ──  DispatchClient
                                       |
                         ┌─────────────┴─────────────┐
                    tmux backend              Mosaic backend
                 performDispatch              native mosaic CLI
                    ┌────┼────┐              sessions/panes/tabs,
                 deliver submit confirm      prompt receipts, capture
                (tmux    (delay (pane-diff
                 paste/  + Enter working/
                 keys)   retry) cleared)
                                       |
                                  Runner (argv executor)
                          ┌────────────┴────────────┐
                    LocalRunner                 RemoteRunner
                    (spawnSync)            (@hasna/machines → ssh)
                                       |
                    Store (sqlite) or /v1 API  ← dispatches + schedules
```

## Surfaces

- **SDK** — `DispatchClient` exposes delivery (`send`, `bulkSend`, `exec`, `key`),
  observation/recovery (`capture`, `triage`, `recover`, `fleetSummary`), record
  reads (`status`, `list`), and the complete schedule lifecycle (`schedule`,
  `loop`, `scheduleStatus`, `listSchedules`, `listLoops`, `pauseSchedule`,
  `resumeSchedule`, `cancelSchedule`, `clearSchedule`). See [sdk-mcp.md](sdk-mcp.md).
- **CLI** — `commander` commands; thin adapters over the client. Read/list commands
  use compact defaults with bounded previews and explicit `show`/`--verbose`/`--json`
  detail paths. They are unit-tested with an injected in-memory client; `send` is
  integration-tested. See [cli.md](cli.md).
- **MCP** — every verb defined once in `mcp/tools.ts` (zod schema + handler) and
  registered on `McpServer`. A parity test keeps the MCP and CLI verb sets identical;
  read/list tools return compact wrapper summaries unless `verbose: true` is requested.
- **Daemon** — a long-running loop (`daemon/loop.ts`) that runs the scheduler `tick()` on
  an interval, owns the scheduled-dispatch queue, and tracks deliveries. Single-instance
  via an atomic pidfile claim; schedules live in sqlite so they survive restarts. A small
  heartbeat file records start time, last tick, and tick errors for health checks. See
  [scheduling.md](scheduling.md) for cadence, retries, lifecycle, and service ownership.

## The Runner abstraction

`Runner.run(argv, input?)` executes a command. Tmux and Mosaic operations are built as
argv arrays (never shell strings), which keeps prompt text safe from quoting.
`RemoteRunner` quotes the argv into a single command and routes it through
`@hasna/machines` to a remote host; that's the *only* thing that changes for
cross-machine dispatch.

tmux is the default backend. The optional Mosaic backend is selected through
`DispatchOptions.backend`, `--backend mosaic`, or `DISPATCH_BACKEND=mosaic`. It calls
the public `mosaic` binary directly (`mosaic.control.v1` JSON receipts/envelopes)
rather than using tmux compatibility shims.

## Client route

Local mode is the default and uses the on-box runner/store described below. API
mode is selected with `HASNA_DISPATCH_STORAGE_MODE=api` (or
`self_hosted`/`remote`/`cloud`/`hybrid`) plus `HASNA_DISPATCH_API_URL` and
`HASNA_DISPATCH_API_KEY`. In API mode, CLI and MCP client commands route through
the authenticated `/v1` authority for dispatch records, schedules, targets, fleet
summary, and daemon actions. Invalid API configuration fails closed instead of
falling back to local SQLite.

The route decision is computed once per command and is never re-derived from the
response value, so an empty or falsy authority payload cannot be mistaken for
"local mode"; a body-less success raises `REMOTE_API_EMPTY_RESPONSE`. The client
retries only HTTP-idempotent methods, and never after a client-side abort/timeout,
so a dispatch/exec/key/recover POST is submitted to a pane at most once.

Every endpoint declares the shape it promises (`src/lib/api-schemas.ts`), and
`request` checks each 2xx body against it before returning: an unrecognized
payload raises `REMOTE_API_MALFORMED_RESPONSE` instead of being cast to the
declared return type, which would report an unknown outcome as a completed
dispatch. The check is a gate rather than a transform — the authority's own
object is returned, so fields the client does not model still reach `--json`.
[api-v1.md](api-v1.md) is the contract an authority implements.

## Local state

Everything lives in sqlite at `~/.hasna/dispatch/dispatch.db` (override with
`DISPATCH_DATA_DIR`):

- `dispatches` — every dispatch with backend, status, confirmation result, computed
  delay, timestamps, and optional native backend receipt metadata.
- `schedules` — one-shot (`at` or relative `in`), recurring cron (`cron`), and
  interval loop (`every`/`interval_ms`) dispatches with kind/name, next run time,
  lifecycle status, last fired dispatch, and failure audit fields
  (`last_failure_at`, `last_failure_reason`, `failure_count`).
- `daemon.pid`, `daemon.state.json`, `daemon.log` — process ownership, heartbeat,
  and append-only daemon logs in `DISPATCH_DATA_DIR`.
- `artifacts/` — bounded, redacted recovery captures; requested artifact paths
  cannot escape this directory.

## Daemon health

`dispatch daemon status --json` reports:

- process state: `running`, `stale`, `pid`, and coarse `health` (`alive`, `stale`, `dead`);
- heartbeat state: `startedAt`, `lastTickAt`, tick start/finish/error timestamps, and
  heartbeat age;
- queue state: scheduled/paused/fired/cancelled/failed counts, the next scheduled item,
  and recent schedule/loop failures without prompt bodies.

`dispatch daemon ensure` is idempotent and recovers stale pidfiles. `dispatch daemon
restart` stops and starts the daemon. On Linux, `dispatch daemon service install --start`
writes and enables a user-level systemd unit with `Restart=on-failure` and
`RestartSec=10s`; this is the intended always-live mode for spark machines.
