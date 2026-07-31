# SDK and MCP reference

## SDK

```ts
import { DispatchClient } from "@hasna/dispatch/sdk";

const client = new DispatchClient();
const record = await client.send({ target: "work:agent", prompt: "Run tests" });
client.close();
```

`DispatchClient` opens the default SQLite store unless given `store`, `dbPath`,
or `persist: false`; scheduling requires persistence. A constructor `backend`
sets the default for backend-capable calls.

| Method | Behavior |
| --- | --- |
| `send` | Deliver one prompt through tmux or Mosaic. |
| `bulkSend` | Resolve explicit or `sessions-query` tmux targets and apply guards/concurrency. |
| `exec` / `key` | Deliver a filtered shell command or allowlisted composer key. |
| `capture` | Return bounded redacted tmux/Mosaic output, optionally AI-transformed. |
| `triage` / `recover` | Classify state, then plan or apply guarded recovery. |
| `fleetSummary` | Return bounded tmux fleet classifications. |
| `status` / `list` | Read local dispatch records. |
| `schedule` / `loop` / `scheduleStatus` | Create and inspect persisted work. |
| `listSchedules` / `listLoops` | List persisted schedule state. |
| `cancelSchedule` / `pauseSchedule` / `resumeSchedule` / `clearSchedule` | Apply lifecycle transitions. |
| `close` | Close a store owned by the client. |

`createDispatchClientFromEnv()` returns a local client or authenticated
`DispatchApiClient`. API selection is fail-closed: configuration and response
errors never fall back to local state. See [api-v1.md](api-v1.md).

## MCP

`dispatch-mcp` is a stdio server. Its tools mirror every user-facing CLI verb;
the internal foreground `dispatch daemon run` entry is intentionally excluded.

| Tools | CLI surface |
| --- | --- |
| `dispatch_send`, `dispatch_exec`, `dispatch_key` | delivery |
| `dispatch_capture`, `dispatch_triage`, `dispatch_recover` | observation/recovery |
| `dispatch_status`, `dispatch_show`, `dispatch_list` | record reads |
| `dispatch_targets`, `dispatch_fleet_summary` | target/fleet reads |
| `dispatch_schedule`, `dispatch_loop` | schedule creation |
| `dispatch_schedules`, `dispatch_loops` | schedule lists |
| `dispatch_cancel`, `dispatch_pause`, `dispatch_resume`, `dispatch_clear` | lifecycle |
| `dispatch_daemon_start`, `dispatch_daemon_stop` | daemon process |
| `dispatch_daemon_ensure`, `dispatch_daemon_restart` | daemon process |
| `dispatch_daemon_status`, `dispatch_daemon_doctor` | daemon health |
| `dispatch_daemon_service` | systemd service |
| `dispatch_self_heal_diagnose` | read-only diagnosis |

Schemas in `src/mcp/tools.ts` are authoritative. Guard defaults match the CLI:
recovery plans unless `apply: true`; bulk delivery defaults to idle guarding
unless queue/force is explicit; target enumeration is bounded unless `all: true`.

## Compact responses

MCP output is compact by default to protect agent context:

- Single records/schedules return wrappers with id, status, kind, bounded preview,
  and a hint. Set `verbose: true` for the full object.
- Lists return wrappers such as `{ items, count, limit, hasMore, compact }`.
- Dispatch-producing tools return compact record wrappers unless verbose.
- `dispatch_targets` defaults to 50 in local and API mode.
- Fleet summary is always a bounded compact schema.

Full objects may contain prompt text. Request `verbose: true` only when needed.

## API route

`HASNA_DISPATCH_STORAGE_MODE` has precedence over the compatibility alias
`DISPATCH_STORAGE_MODE`. API modes (`api`, `self_hosted`, `remote`, `cloud`,
`hybrid`) require an authority URL and key; `local` explicitly stays local.
The client validates every 2xx response, rejects redirects, retries only
HTTP-idempotent methods, and submits side-effecting requests at most once. It
sends an idempotency key but does not replay writes after an unknown timeout.
