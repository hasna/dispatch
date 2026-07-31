# Scheduling and daemon

Schedules persist delivery options and a next-run timestamp in SQLite (or an API
authority). Creating local work does not start a daemon; the daemon owns firing.

## Timing

`schedule` requires exactly one mode: `at` (absolute `Date` input), `in`
(relative duration), `cron` (five local-time fields), or `every` (interval loop).
Durations accept positive milliseconds, seconds, minutes, hours, or days, such as
`500ms`, `30m`, `5 minutes`, `2h`, and `1d`; fractional values are rounded.

Cron fields support `*`, values, ranges, steps, and comma lists. Sunday is `0` or
`7`. When day-of-month and day-of-week are both restricted, either may match.
The next match is strictly after the reference time.

## Lifecycle and retries

States are `scheduled`, `paused`, `fired`, `failed`, and `cancelled`. `clear`
deletes a row rather than creating an audit state. Dispatch records from previous
runs remain independent ledger entries.

The scheduler claims due rows before delivery and the daemon processes them serially:

- Successful one-shots become `fired`.
- Failed one-shots retry every 60 seconds for up to one hour after their effective
  first-due time, then become `failed`.
- Cron schedules compute the next matching time after each attempt.
- Interval loops compute the next run after the attempt completes, so a loop does
  not overlap itself.
- Recurring failures retain failure metadata and remain `scheduled` for the next cadence.

`pause` excludes work from due claims. `resume` recomputes future cron/interval
timing from the resume time. Stored delivery safety, machine, backend, and goal
options apply when the work fires.

## Daemon ownership

`dispatch daemon ensure` idempotently starts the local queue owner. The daemon
atomically claims its pidfile, removes stale ownership, writes heartbeat state,
and ticks at `DISPATCH_DAEMON_INTERVAL_MS` (default 1000ms). Sliced sleeps observe
stop signals quickly. Restart waits for the old process to exit before replacing it.

`status` combines process ownership, heartbeat freshness, queue counts, next due
work, and bounded recent failures. `doctor` produces actionable findings. State
under `DISPATCH_DATA_DIR` includes `dispatch.db`, `daemon.pid`,
`daemon.pid.lock`, `daemon.state.json`, `daemon.log`, and `artifacts/`.

## Service management

On Linux, `dispatch daemon service install --start` writes and starts
`~/.config/systemd/user/hasna-dispatch-daemon.service`. It runs
`dispatch daemon run`, uses `Restart=on-failure` with a 10-second delay, and
preserves an explicit data directory. Actions are `install`, `start`, `stop`,
`restart`, `status`, and `uninstall`. Other platforms need their own supervisor
or can use `daemon ensure`.

## Remote and API ownership

A local schedule may target a remote machine; the daemon beside the local SQLite
store owns its timer and creates the remote runner when due. In API mode, the
authority owns persistence and queue execution instead. See
[cross-machine.md](cross-machine.md) and [api-v1.md](api-v1.md).
