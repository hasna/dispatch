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
                                Store (sqlite)  ← dispatches + schedules
```

## Surfaces

- **SDK** — `DispatchClient` (`send`, `status`, `list`, `schedule`, `loop`,
  `scheduleStatus`, `listSchedules`, `listLoops`, `pauseSchedule`, `resumeSchedule`,
  `cancelSchedule`, `clearSchedule`). The programmatic core; the other surfaces wrap it.
- **CLI** — `commander` commands; thin adapters over the client. Read/schedule commands
  are unit-tested with an injected in-memory client; `send` is integration-tested.
- **MCP** — every verb defined once in `mcp/tools.ts` (zod schema + handler) and
  registered on `McpServer`. A parity test keeps the MCP and CLI verb sets identical.
- **Daemon** — a long-running loop (`daemon/loop.ts`) that runs the scheduler `tick()` on
  an interval, owns the scheduled-dispatch queue, and tracks deliveries. Single-instance
  via an atomic pidfile claim; schedules live in sqlite so they survive restarts. A small
  heartbeat file records start time, last tick, and tick errors for health checks.

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

## State

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
