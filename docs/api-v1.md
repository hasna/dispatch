# `/v1` authority response contract

This is what an implementation of the Dispatch HTTP authority must answer. The
client in `src/lib/api-client.ts` checks every 2xx body against the schemas in
`src/lib/api-schemas.ts` before handing it to a caller; a body that does not
match is a remote failure (`REMOTE_API_MALFORMED_RESPONSE`), never a coerced
success.

That check is not pedantry. Without it a 200 whose shape the client does not
recognize is cast straight to the declared return type, so `dispatch send --json`
prints `{}` and exits **0** for a prompt whose delivery is entirely unknown — and
an automation loop reads that exit code as "the prompt reached the pane".

## Rules that apply to every endpoint

- **Authenticate.** The client sends both `Authorization: Bearer <key>` and
  `x-api-key: <key>`. Never accept the key from a query string or body.
- **Answer with a body.** A 2xx with an empty or `null` body raises
  `REMOTE_API_EMPTY_RESPONSE`; `204` is not a valid answer to any endpoint below.
- **Do not redirect.** The client sends `redirect: "manual"` and refuses 3xx, so
  credentials are never replayed to another host.
- **Extra fields are fine.** Each schema requires exactly the fields the
  documented type declares as required. Additional fields are passed through
  untouched — validation is a gate, not a transform.
- **Missing or wrong-typed required fields are not fine.** `{}`, `[]`,
  `{"ok":true}`, and an HTML error page are all rejected.
- **Writes are sent once.** `POST` bodies carry an advisory `Idempotency-Key`
  header, but the client never replays them, including after a client-side
  timeout. Treat a repeated key as a duplicate only if you choose to implement
  that contract; the client does not rely on it.
- **404 means not-found, not broken.** `status`, `scheduleStatus`,
  `clearSchedule`, and the schedule actions treat a 404 as "no such id" and, for
  schedules, retry the request against the `/loops` sibling path.

Payloads may be sent bare or wrapped in a single-key envelope. Accepted wrapper
keys are listed per endpoint; the bare form is always accepted.

## Endpoints

| Method + path | Envelope keys | Body |
| --- | --- | --- |
| `POST /v1/dispatches` | `dispatch`, `record` | `DispatchRecord` |
| `POST /v1/dispatches/bulk` | `bulk`, `result` | `BulkDispatchResult` |
| `POST /v1/exec` | `dispatch`, `record` | `DispatchRecord` |
| `POST /v1/keys` | `dispatch`, `record` | `DispatchRecord` |
| `POST /v1/captures` | `capture`, `result` | `CaptureResult` |
| `POST /v1/triage` | `triage`, `result` | `AgentTriageResult` |
| `POST /v1/recover` | `recover`, `result` | `AgentRecoverResult` |
| `POST /v1/fleet/summary` | `summary`, `result` | `FleetSummaryResult` |
| `GET /v1/targets` | `targets`, `items`, `data`, `results` | array of rows, each with a `target` string |
| `GET /v1/dispatches/:id` | `dispatch`, `record` | `DispatchRecord` (404 when unknown) |
| `GET /v1/dispatches` | `dispatches`, `records`, `items`, `data`, `results` | array of `DispatchRecord` |
| `POST /v1/schedules` | `schedule` | `ScheduledDispatch` |
| `POST /v1/loops` | `loop`, `schedule` | `ScheduledDispatch` |
| `GET /v1/schedules/:id`, `GET /v1/loops/:id` | `schedule` / `loop`, `schedule` | `ScheduledDispatch` (404 when unknown) |
| `GET /v1/schedules` | `schedules`, `items`, `data`, `results` | array of `ScheduledDispatch` |
| `GET /v1/loops` | `loops`, `schedules`, `items`, `data`, `results` | array of `ScheduledDispatch` |
| `POST /v1/schedules/:id/cancel` (and `/loops/:id/cancel`) | `cancelled` | boolean |
| `POST /v1/schedules/:id/pause` (and `/loops/:id/pause`) | `paused` | boolean |
| `POST /v1/schedules/:id/resume` (and `/loops/:id/resume`) | `resumed` | boolean |
| `DELETE /v1/schedules/:id`, `DELETE /v1/loops/:id` | `cleared`, `deleted` | boolean |
| `POST /v1/daemon/start` | — | `StartDaemonResult` |
| `POST /v1/daemon/stop` | — | `StopDaemonResult` |
| `POST /v1/daemon/ensure` | — | `{ ok, started, alreadyRunning }` |
| `POST /v1/daemon/restart` | — | `{ ok, stopped: StopDaemonResult, started: StartDaemonResult }` |
| `GET /v1/daemon/status` | — | `DaemonStatus` |
| `GET /v1/daemon/doctor` | — | `{ ok, status: DaemonStatus, findings: string[] }` |
| `POST /v1/daemon/service` | — | `ServiceResult` |

A boolean endpoint answers `true`/`false` bare or as `{"cancelled": true}`. It
must not answer `{"ok": true}`: the client cannot tell that from "the schedule
was already gone", and reporting a successful cancel as a failed one is the same
class of bug as fabricating a success.

## Required fields

Only required fields are listed. Optional fields from `src/types.ts` may be
included and are passed through.

**`DispatchRecord`** — `id`, `target`, `machine`, `prompt` (strings), `status`
(`pending` | `sending` | `delivered` | `failed` | `scheduled` | `cancelled` |
`skipped`), `createdAt`, `updatedAt` (ISO 8601 strings).

**`ScheduledDispatch`** — `id`, `options` (object with `target` and `prompt`),
`nextRun`, `status` (`scheduled` | `paused` | `fired` | `cancelled` | `failed`),
`createdAt`, `updatedAt`.

**`BulkDispatchResult`** — `status` (`completed` | `failed`), `source`
(`explicit` | `sessions-query`), the counters `requested`, `planned`,
`delivered`, `skipped`, `failed`, `maxConcurrency`, `jitterMs`,
`perMachineLimit`, the flag `dryRun`, and `records` (array of `DispatchRecord`).

**`CaptureResult`** — `status` (`captured` | `failed`), `target`, `machine`,
`requestedLines`, `lines`, `maxLines`, `capturedAt`, `text`, `redacted`.
Transcripts must already be redacted; the client does not redact them for you.

**`AgentTriageResult`** — `schemaVersion` exactly `"dispatch.agentTriage.v1"`,
`status` (`ok` | `blocked` | `failed`), `target`, `machine`, `generatedAt`,
`action` (`{ kind: "send" | "queue" | "refuse", safeToApply, reason }`), and
`capture` (`{ status, requestedLines, lines, maxLines, maxChars, textLength,
truncatedChars, redacted, excerptChars }`).

**`AgentRecoverResult`** — `schemaVersion` exactly
`"dispatch.agentRecover.v1"`, `status` (`planned` | `applied` | `refused` |
`failed`), `target`, `machine`, `dryRun`, `generatedAt`, `promptPreview`,
`promptLength`, `action` (as above), and `triage` (an `AgentTriageResult`).

**`FleetSummaryResult`** — `schemaVersion` exactly
`"dispatch.fleet_summary.v1"`, `status` (`completed` | `failed`), `machine`,
`generatedAt`, `targetGlobs` (string array), the bounds `limit`, `maxLimit`,
`requestedMaxPaneChars`, `maxPaneChars`, `maxAllowedPaneChars`, the counts
`totalTargets`, `matchedTargets`, `inspectedTargets`, `omittedTargets`, `totals`
(a state → count map; states you observed none of may be omitted), `items`, and
`compact: true`. Each item needs `backend: "tmux"`, `target`, `machine`,
`window`, `active`, `classification` (`{ state, uncertainty, reasons }`),
`excerpt`, `excerptChars`, `excerptTruncated`.

**`DaemonStatus`** — `running`, `stale` (booleans), `health` (`alive` | `stale` |
`dead`), the counts `scheduled`, `paused`, `fired`, `cancelled`, `failed`,
`recentDispatches`, `heartbeatStaleMs`, `recentFailures` (array of items with
`id`, `status`, `target`, `nextRun`), and the paths `logPath`, `pidPath`,
`statePath`.

**`StartDaemonResult`** — `started`, `alreadyRunning`.

**`StopDaemonResult`** — `stopped`, `forced`, `wasRunning`.

**`ServiceResult`** — `ok`, `action` (`install` | `start` | `stop` | `restart` |
`status` | `uninstall`), `detail`.

## Error responses

Non-2xx statuses are translated by the client into fail-closed errors; the body
is not required to have any particular shape.

| Status | Client outcome |
| --- | --- |
| 3xx | `REMOTE_API_REDIRECT_REJECTED` |
| 401 | `REMOTE_API_UNAUTHORIZED` |
| 403 | `REMOTE_API_FORBIDDEN` |
| 404 | not-found where the endpoint defines one, otherwise a `DispatchApiError` |
| 408, 425, 429 | retried on `GET`/`HEAD`/`PUT`/`DELETE`/`OPTIONS` only |
| 5xx | retried on idempotent methods, then `REMOTE_API_UNAVAILABLE` |
| no response | `REMOTE_API_TIMEOUT` or `REMOTE_API_UNREACHABLE` |

None of these ever fall back to the local SQLite store. Once API mode is
selected, the route is fixed for the whole command.
