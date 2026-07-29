import { describe, expect, test } from "bun:test";
import {
  DispatchApiClient,
  DispatchApiError,
  getDispatchApiClient,
  getDispatchApiConfigStatus,
  type FetchLike,
} from "./api-client.js";

interface RecordedCall {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function apiFetch(handler: (path: string, method: string, body: unknown) => { status?: number; body?: unknown }) {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = init.headers as Record<string, string>;
    const path = `${new URL(url).pathname}${new URL(url).search}`;
    calls.push({ url, path, method, headers, body });
    const result = handler(path, method, body);
    return Response.json(result.body ?? {}, { status: result.status ?? 200 });
  };
  return { calls, fetchImpl };
}

/** A fetch that never answers, so the client's own timeout aborts the request. */
function hangingFetch() {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    return new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal | undefined;
      const abort = () => {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort);
    });
  };
  return { calls, fetchImpl };
}

/**
 * Calls that carry the API key anywhere other than the auth headers. The auth
 * headers are excluded deliberately — they are the one place the key belongs —
 * so the predicate can actually fail; see the negative control below.
 */
function credentialLeaks(calls: Array<Pick<RecordedCall, "url" | "body">>, apiKey: string): Array<Pick<RecordedCall, "url" | "body">> {
  return calls.filter((call) => JSON.stringify({ url: call.url, body: call.body }).includes(apiKey));
}

const record = {
  id: "d1",
  target: "work:agent",
  machine: "local",
  prompt: "hello",
  status: "delivered",
  createdAt: "x",
  updatedAt: "x",
} as const;

const schedule = {
  id: "s1",
  options: { target: "work:agent", prompt: "later" },
  nextRun: "2099-01-01T00:00:00.000Z",
  status: "scheduled",
  createdAt: "x",
  updatedAt: "x",
} as const;

const daemonStatusBody = {
  running: true,
  stale: false,
  health: "alive",
  scheduled: 0,
  paused: 0,
  fired: 0,
  cancelled: 0,
  failed: 0,
  recentDispatches: 0,
  heartbeatStaleMs: 30000,
  recentFailures: [],
  logPath: "log",
  pidPath: "pid",
  statePath: "state",
} as const;

const startBody = { started: true, alreadyRunning: false } as const;
const stopBody = { stopped: true, forced: false, wasRunning: true } as const;

describe("dispatch API route resolution", () => {
  test("explicit api/self-hosted mode resolves to /v1 with auth required", () => {
    const status = getDispatchApiConfigStatus({
      HASNA_DISPATCH_STORAGE_MODE: "self_hosted",
      HASNA_DISPATCH_API_URL: "https://dispatch.hasna.xyz",
      HASNA_DISPATCH_API_KEY: "test-key",
    });
    expect(status).toMatchObject({
      selected: true,
      ok: true,
      mode: "self_hosted",
      v1BaseUrl: "https://dispatch.hasna.xyz/v1",
      localFallback: false,
    });
  });

  test("url plus key can select api mode for fleet flips, while explicit local wins", () => {
    expect(
      getDispatchApiConfigStatus({
        HASNA_DISPATCH_API_URL: "https://dispatch.hasna.xyz/v1",
        HASNA_DISPATCH_API_KEY: "test-key",
      }),
    ).toMatchObject({ selected: true, source: "auto:api-url+api-key", v1BaseUrl: "https://dispatch.hasna.xyz/v1" });

    expect(
      getDispatchApiConfigStatus({
        HASNA_DISPATCH_STORAGE_MODE: "local",
        HASNA_DISPATCH_API_URL: "https://dispatch.hasna.xyz",
        HASNA_DISPATCH_API_KEY: "test-key",
      }),
    ).toMatchObject({ selected: false, mode: "local" });
  });

  test("api mode without a key fails closed instead of falling back to local SQLite", () => {
    expect(() => getDispatchApiClient({ HASNA_DISPATCH_STORAGE_MODE: "api", HASNA_DISPATCH_API_URL: "https://dispatch.hasna.xyz" })).toThrow(
      /REMOTE_API_KEY_MISSING/,
    );
    expect(() => getDispatchApiClient({ HASNA_DISPATCH_STORAGE_MODE: "api", HASNA_DISPATCH_API_KEY: "test-key" })).toThrow(
      /REMOTE_API_URL_MISSING/,
    );
  });

  test("a stale DISPATCH_STORAGE_MODE alias never vetoes the canonical mode that outranks it", () => {
    // Only the variable that wins precedence is consulted, so an unread alias
    // must not be able to brick the run — least of all the default local path.
    expect(
      getDispatchApiConfigStatus({ HASNA_DISPATCH_STORAGE_MODE: "local", DISPATCH_STORAGE_MODE: "sqlite" }),
    ).toMatchObject({ selected: false, ok: true, mode: "local", source: "HASNA_DISPATCH_STORAGE_MODE", issues: [] });
    expect(getDispatchApiClient({ HASNA_DISPATCH_STORAGE_MODE: "local", DISPATCH_STORAGE_MODE: "sqlite" })).toBeNull();

    const apiEnv = {
      HASNA_DISPATCH_STORAGE_MODE: "api",
      DISPATCH_STORAGE_MODE: "sqlite",
      HASNA_DISPATCH_API_URL: "https://dispatch.hasna.xyz",
      HASNA_DISPATCH_API_KEY: "test-key",
    };
    expect(getDispatchApiConfigStatus(apiEnv)).toMatchObject({
      selected: true,
      ok: true,
      mode: "api",
      source: "HASNA_DISPATCH_STORAGE_MODE",
      v1BaseUrl: "https://dispatch.hasna.xyz/v1",
      issues: [],
    });
    expect(getDispatchApiClient(apiEnv)).toBeInstanceOf(DispatchApiClient);
  });

  test("an unusable storage mode still fails closed when that variable is the one in effect", () => {
    // Negative control for the precedence rule above: ignoring the loser must not
    // become ignoring the winner. The alias is authoritative when the canonical
    // name is unset, and the canonical name is authoritative when both are set.
    expect(getDispatchApiConfigStatus({ DISPATCH_STORAGE_MODE: "sqlite" })).toMatchObject({
      selected: true,
      ok: false,
      mode: "sqlite",
      source: "DISPATCH_STORAGE_MODE",
      localFallback: false,
    });
    expect(getDispatchApiConfigStatus({ HASNA_DISPATCH_STORAGE_MODE: "sqlite", DISPATCH_STORAGE_MODE: "local" })).toMatchObject({
      selected: true,
      ok: false,
      mode: "sqlite",
      source: "HASNA_DISPATCH_STORAGE_MODE",
      localFallback: false,
    });
    expect(() => getDispatchApiClient({ HASNA_DISPATCH_STORAGE_MODE: "sqlite" })).toThrow(/REMOTE_STORAGE_MODE_INVALID/);
  });
});

describe("DispatchApiClient", () => {
  test("routes command families through authenticated /v1 endpoints", async () => {
    const { calls, fetchImpl } = apiFetch((path, method) => {
      if (path.startsWith("/v1/dispatches/bulk")) return { body: { result: { status: "completed", source: "explicit", requested: 0, planned: 0, delivered: 0, skipped: 0, failed: 0, dryRun: true, maxConcurrency: 1, jitterMs: 0, perMachineLimit: 1, records: [] } } };
      if (path.startsWith("/v1/dispatches")) {
        if (method === "GET" && path === "/v1/dispatches?status=delivered&limit=3") return { body: { dispatches: [record] } };
        return { body: { dispatch: record } };
      }
      if (path.startsWith("/v1/schedules/s1/") || (path === "/v1/schedules/s1" && method === "DELETE")) {
        const key = method === "DELETE" ? "cleared" : path.split("/").at(-1) === "cancel" ? "cancelled" : `${path.split("/").at(-1)}d`;
        return { body: { [key!]: true } };
      }
      if (path.startsWith("/v1/schedules")) {
        if (method === "GET" && path !== "/v1/schedules/s1") return { body: { schedules: [schedule] } };
        return { body: { schedule } };
      }
      if (path.startsWith("/v1/loops")) {
        if (method === "GET" && path !== "/v1/loops/s1") return { body: { loops: [{ ...schedule, kind: "loop" }] } };
        return { body: { loop: { ...schedule, kind: "loop" } } };
      }
      if (path === "/v1/targets?backend=tmux&limit=5&verbose=true") {
        return { body: { targets: [{ target: "work:1.0", window: "agent", active: true }] } };
      }
      if (path === "/v1/fleet/summary") return { body: { summary: { schemaVersion: "dispatch.fleet_summary.v1", status: "completed", machine: "local", generatedAt: "x", targetGlobs: ["*"], limit: 1, maxLimit: 50, requestedMaxPaneChars: 1200, maxPaneChars: 1200, maxAllowedPaneChars: 4000, totalTargets: 0, matchedTargets: 0, inspectedTargets: 0, omittedTargets: 0, totals: {}, items: [], compact: true } } };
      if (path === "/v1/captures") return { body: { capture: { status: "captured", target: "work:agent", machine: "local", requestedLines: 1, lines: 1, maxLines: 2000, capturedAt: "x", text: "", redacted: true } } };
      if (path === "/v1/triage") return { body: { triage: { schemaVersion: "dispatch.agentTriage.v1", status: "failed", target: "work:agent", machine: "local", generatedAt: "x", action: { kind: "refuse", safeToApply: false, reason: "test" }, capture: { status: "failed", requestedLines: 1, lines: 0, maxLines: 2000, maxChars: 0, textLength: 0, truncatedChars: false, redacted: true, excerptChars: 0 } } } };
      if (path === "/v1/recover") return { body: { recover: { schemaVersion: "dispatch.agentRecover.v1", status: "planned", target: "work:agent", machine: "local", dryRun: true, generatedAt: "x", promptPreview: "fix", promptLength: 3, action: { kind: "refuse", safeToApply: false, reason: "test" }, triage: { schemaVersion: "dispatch.agentTriage.v1", status: "failed", target: "work:agent", machine: "local", generatedAt: "x", action: { kind: "refuse", safeToApply: false, reason: "test" }, capture: { status: "failed", requestedLines: 1, lines: 0, maxLines: 2000, maxChars: 0, textLength: 0, truncatedChars: false, redacted: true, excerptChars: 0 } } } } };
      if (path.startsWith("/v1/daemon/")) {
        if (path === "/v1/daemon/status") return { body: daemonStatusBody };
        if (path === "/v1/daemon/doctor") return { body: { ok: true, status: daemonStatusBody, findings: [] } };
        if (path === "/v1/daemon/service") return { body: { ok: true, action: "status", detail: "remote service status" } };
        if (path === "/v1/daemon/stop") return { body: stopBody };
        if (path === "/v1/daemon/restart") return { body: { ok: true, stopped: stopBody, started: startBody } };
        return { body: { ok: true, ...startBody } };
      }
      return { body: { dispatch: record } };
    });
    const client = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl, sleepImpl: async () => {} });

    await client.send({ target: "work:agent", prompt: "hello" });
    await client.bulkSend({ targets: [], prompt: "hello", dryRun: true });
    await client.exec({ target: "work:shell", command: "pwd", dryRun: true });
    await client.key({ target: "work:agent", key: "Tab" });
    await client.capture({ target: "work:agent", lines: 1 });
    await client.triage({ target: "work:agent", lines: 1 });
    await client.recover({ target: "work:agent", prompt: "fix" });
    await client.fleetSummary({ limit: 1 });
    await client.targets({ backend: "tmux", limit: 5, verbose: true });
    await client.status("d1");
    await client.list({ status: "delivered", limit: 3 });
    await client.schedule({ options: { target: "work:agent", prompt: "later" }, in: "30m" });
    await client.loop({ options: { target: "work:agent", prompt: "poll" }, every: "5m" });
    await client.scheduleStatus("s1");
    await client.listSchedules({ status: "scheduled", kind: "schedule", limit: 2 });
    await client.listLoops({ status: "scheduled", limit: 2 });
    await client.cancelSchedule("s1");
    await client.pauseSchedule("s1");
    await client.resumeSchedule("s1");
    await client.clearSchedule("s1");
    await client.daemonStatus();
    await client.daemonDoctor();
    await client.daemonEnsure();
    await client.daemonRestart();
    await client.daemonStop();
    await client.daemonService({ action: "status" });

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/dispatches",
      "POST /v1/dispatches/bulk",
      "POST /v1/exec",
      "POST /v1/keys",
      "POST /v1/captures",
      "POST /v1/triage",
      "POST /v1/recover",
      "POST /v1/fleet/summary",
      "GET /v1/targets?backend=tmux&limit=5&verbose=true",
      "GET /v1/dispatches/d1",
      "GET /v1/dispatches?status=delivered&limit=3",
      "POST /v1/schedules",
      "POST /v1/loops",
      "GET /v1/schedules/s1",
      "GET /v1/schedules?status=scheduled&kind=schedule&limit=2",
      "GET /v1/loops?status=scheduled&limit=2",
      "POST /v1/schedules/s1/cancel",
      "POST /v1/schedules/s1/pause",
      "POST /v1/schedules/s1/resume",
      "DELETE /v1/schedules/s1",
      "GET /v1/daemon/status",
      "GET /v1/daemon/doctor",
      "POST /v1/daemon/ensure",
      "POST /v1/daemon/restart",
      "POST /v1/daemon/stop",
      "POST /v1/daemon/service",
    ]);
    expect(calls.every((call) => call.headers.Authorization === "Bearer secret")).toBe(true);
    expect(credentialLeaks(calls, "secret")).toEqual([]);
  });

  test("the credential-leak predicate flags a key carried outside the auth headers", () => {
    // Negative control: without this, an assertion that "the key never leaks" could
    // be vacuously true and would stay green if a future change put it in a query
    // string or request body.
    expect(credentialLeaks([{ url: "https://dispatch.hasna.xyz/v1/dispatches?apiKey=secret", body: undefined }], "secret")).toHaveLength(1);
    expect(credentialLeaks([{ url: "https://dispatch.hasna.xyz/v1/dispatches", body: { options: { apiKey: "secret" } } }], "secret")).toHaveLength(1);
    expect(credentialLeaks([{ url: "https://dispatch.hasna.xyz/v1/dispatches", body: { options: { prompt: "hello" } } }], "secret")).toEqual([]);
  });

  test("returns undefined for a missing dispatch without querying local state", async () => {
    const { calls, fetchImpl } = apiFetch(() => ({ status: 404, body: { error: "not found" } }));
    const client = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl });
    expect(await client.status("missing")).toBeUndefined();
    expect(calls.map((call) => call.path)).toEqual(["/v1/dispatches/missing"]);
  });

  test("a 404 stays a not-found even when the id spells abort or timeout", async () => {
    // The abort heuristic matches on the error message, which embeds the request
    // path, so a free-text id or schedule name can otherwise forge a timeout out
    // of an answered 404 and blame authority health during an incident.
    const { calls, fetchImpl } = apiFetch(() => ({ status: 404, body: { error: "not found" } }));
    const client = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(await client.status("abort-loop")).toBeUndefined();
    expect(await client.status("timeout-check")).toBeUndefined();
    expect(await client.scheduleStatus("abort-loop")).toBeUndefined();
    expect(await client.clearSchedule("abort-loop")).toBe(false);
    expect(await client.cancelSchedule("timeout-watchdog")).toBe(false);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/dispatches/abort-loop",
      "GET /v1/dispatches/timeout-check",
      "GET /v1/schedules/abort-loop",
      "GET /v1/loops/abort-loop",
      "DELETE /v1/schedules/abort-loop",
      "DELETE /v1/loops/abort-loop",
      "POST /v1/schedules/timeout-watchdog/cancel",
      "POST /v1/loops/timeout-watchdog/cancel",
    ]);
  });

  test("an answered 4xx whose path spells abort still surfaces its own status, not a timeout", async () => {
    // Companion to the 404 case: statuses routeError does not special-case must
    // reach the caller as the authority's own DispatchApiError.
    const { fetchImpl } = apiFetch(() => ({ status: 409, body: { error: "conflict" } }));
    const client = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl });
    await expect(client.status("abort-loop")).rejects.toBeInstanceOf(DispatchApiError);
    await expect(client.status("abort-loop")).rejects.not.toThrow(/REMOTE_API_TIMEOUT/);
  });

  test("never replays a side-effecting POST, so a prompt or command is submitted at most once", async () => {
    const { calls, fetchImpl } = apiFetch(() => ({ status: 504, body: { error: "gateway timeout" } }));
    const client = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await expect(client.send({ target: "work:agent", prompt: "hello" })).rejects.toThrow(/REMOTE_API_UNAVAILABLE/);
    await expect(client.exec({ target: "work:shell", command: "bun run migrate" })).rejects.toThrow(/REMOTE_API_UNAVAILABLE/);
    await expect(client.recover({ target: "work:agent", prompt: "fix" })).rejects.toThrow(/REMOTE_API_UNAVAILABLE/);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /v1/dispatches", "POST /v1/exec", "POST /v1/recover"]);
  });

  test("still retries idempotent reads on a retryable status", async () => {
    const { calls, fetchImpl } = apiFetch(() => ({ status: 503, body: { error: "unavailable" } }));
    const client = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await expect(client.list()).rejects.toThrow(/REMOTE_API_UNAVAILABLE/);
    expect(calls).toHaveLength(3);
  });

  test("never replays a request after a client-side timeout, even an idempotent one", async () => {
    const post = hangingFetch();
    const postClient = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl: post.fetchImpl,
      timeoutMs: 5,
      sleepImpl: async () => {},
    });
    await expect(postClient.exec({ target: "work:shell", command: "bun run migrate" })).rejects.toThrow(/REMOTE_API_TIMEOUT/);
    expect(post.calls).toEqual(["POST /v1/exec"]);

    const get = hangingFetch();
    const getClient = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl: get.fetchImpl,
      timeoutMs: 5,
      sleepImpl: async () => {},
    });
    await expect(getClient.list()).rejects.toThrow(/REMOTE_API_TIMEOUT/);
    expect(get.calls).toEqual(["GET /v1/dispatches"]);
  });

  test("a body-less or null success from the authority fails closed instead of resolving undefined", async () => {
    const empty: FetchLike = async () => new Response(null, { status: 204 });
    const emptyClient = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl: empty });
    await expect(emptyClient.daemonStatus()).rejects.toThrow(/REMOTE_API_EMPTY_RESPONSE/);

    const nulled: FetchLike = async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } });
    const nullClient = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl: nulled });
    await expect(nullClient.fleetSummary()).rejects.toThrow(/REMOTE_API_EMPTY_RESPONSE/);
  });

  test("an unrecognized 200 fails closed instead of being coerced into a fabricated success", async () => {
    // These are the bodies a half-built authority actually answers with, and the
    // exact reason a contract check exists: `as T` turns every one of them into a
    // "successful" dispatch, so `dispatch send --json` prints `{}` and exits 0
    // for a prompt whose delivery is entirely unknown.
    const bodies: unknown[] = [
      {},
      [],
      { ok: true },
      { dispatch: {} },
      "<html>login</html>",
      // Right envelope, wrong record: no timestamps, so callers that read them
      // would render `undefined` as if the authority had reported one.
      { dispatch: { id: "d1", target: "work:agent", machine: "local", prompt: "hello", status: "delivered" } },
      // Right fields, undeclared status value.
      { dispatch: { ...record, status: "queued" } },
    ];

    for (const body of bodies) {
      const { calls, fetchImpl } = apiFetch(() => ({ body }));
      const client = new DispatchApiClient({
        baseUrl: "https://dispatch.hasna.xyz/v1",
        apiKey: "secret",
        fetchImpl,
        sleepImpl: async () => {},
      });
      await expect(client.send({ target: "work:agent", prompt: "deploy prod" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
      // An answered 2xx is definitive, so the side-effecting POST is not replayed.
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["POST /v1/dispatches"]);
    }
  });

  test("every typed endpoint family checks its own contract, not just the dispatch record", async () => {
    const { fetchImpl } = apiFetch(() => ({ body: { ok: true } }));
    const client = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await expect(client.exec({ target: "work:shell", command: "pwd" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.key({ target: "work:agent", key: "Tab" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.bulkSend({ targets: [], prompt: "hi" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.capture({ target: "work:agent" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.triage({ target: "work:agent" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.recover({ target: "work:agent", prompt: "fix" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.fleetSummary()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.schedule({ options: { target: "work:agent", prompt: "later" }, in: "30m" })).rejects.toThrow(
      /REMOTE_API_MALFORMED_RESPONSE/,
    );
    await expect(client.loop({ options: { target: "work:agent", prompt: "poll" }, every: "5m" })).rejects.toThrow(
      /REMOTE_API_MALFORMED_RESPONSE/,
    );
    await expect(client.daemonStatus()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.daemonDoctor()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.daemonStop()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.daemonRestart()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.daemonService({ action: "status" })).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
  });

  test("an unreadable list envelope fails closed instead of reporting an empty fleet", async () => {
    // Silently answering "no dispatches"/"no targets" for a body the client cannot
    // read is the same fabricated success: an operator reads it as a healthy,
    // empty fleet rather than as an authority it cannot talk to.
    const { fetchImpl } = apiFetch(() => ({ body: { rows_v2: [record] } }));
    const client = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await expect(client.list()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.targets()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.listSchedules()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
  });

  test("a list row that is not a record fails closed rather than reaching callers as one", async () => {
    const { fetchImpl } = apiFetch(() => ({ body: { dispatches: [record, { id: "d2" }] } }));
    const client = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl,
      sleepImpl: async () => {},
    });
    await expect(client.list()).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
  });

  test("a boolean endpoint that answers an unrecognized shape is not reported as a no-op", async () => {
    // `{"ok":true}` for a cancel that succeeded used to fall through to the
    // boolean default and print "could not cancel s1", exit 1 — the authority
    // did the work and the operator was told it did not.
    const { fetchImpl } = apiFetch(() => ({ body: { ok: true } }));
    const client = new DispatchApiClient({
      baseUrl: "https://dispatch.hasna.xyz/v1",
      apiKey: "secret",
      fetchImpl,
      sleepImpl: async () => {},
    });

    await expect(client.cancelSchedule("s1")).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.pauseSchedule("s1")).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
    await expect(client.clearSchedule("s1")).rejects.toThrow(/REMOTE_API_MALFORMED_RESPONSE/);
  });

  test("a conforming payload keeps the fields this client does not model", async () => {
    // The contract is a gate, not a transform. If validation ever starts
    // returning zod's parse output instead of the authority's own object, every
    // unmodelled field silently disappears from `--json`.
    const { fetchImpl } = apiFetch(() => ({
      body: { dispatch: { ...record, detail: "working detected", confirm: { delivered: true, reason: "composer cleared" } } },
    }));
    const client = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl });

    const result = await client.send({ target: "work:agent", prompt: "hello" });
    expect(result).toMatchObject({ id: "d1", status: "delivered", detail: "working detected" });
    expect(result.confirm).toEqual({ delivered: true, reason: "composer cleared" });
  });

  test("the malformed-response diagnostic names the offending field and echoes neither payload nor key", async () => {
    const transcript = "TRANSCRIPT_BODY_SHOULD_NOT_BE_ECHOED";
    const { fetchImpl } = apiFetch(() => ({ body: { capture: { ...record, status: "captured", text: 42, detail: transcript } } }));
    const client = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl });

    const error = await client.capture({ target: "work:agent" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Diagnosable: the reviewer's live probe got a raw `text.replace` TypeError
    // out of the formatter instead of anything naming the endpoint or the field.
    expect(message).toContain("POST /captures");
    expect(message).toContain("text: expected string");
    expect(message).not.toContain(transcript);
    expect(message).not.toContain("secret");
  });

  test("rejects redirects so credentials are not followed to another authority", async () => {
    const { fetchImpl } = apiFetch(() => ({ status: 302, body: { location: "https://elsewhere.invalid" } }));
    const client = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl });
    await expect(client.list()).rejects.toThrow(/REMOTE_API_REDIRECT_REJECTED/);
    await expect(client.list()).rejects.toBeInstanceOf(Error);
    await expect(client.status("missing")).rejects.toThrow(/REMOTE_API_REDIRECT_REJECTED/);
    await expect(client.list()).rejects.not.toThrow("secret");
    expect(new DispatchApiError("GET", "/dispatches", 500, {}).status).toBe(500);
  });
});
