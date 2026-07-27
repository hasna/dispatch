import { describe, expect, test } from "bun:test";
import { DispatchApiClient, DispatchApiError, getDispatchApiClient, getDispatchApiConfigStatus, type FetchLike } from "./api-client.js";

function apiFetch(handler: (path: string, method: string, body: unknown) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; path: string; method: string; headers: Record<string, string>; body: unknown }> = [];
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
        if (path === "/v1/daemon/status") return { body: { running: true, stale: false, health: "alive", scheduled: 0, paused: 0, fired: 0, cancelled: 0, failed: 0, recentDispatches: 0, heartbeatStaleMs: 30000, recentFailures: [], logPath: "log", pidPath: "pid", statePath: "state" } };
        if (path === "/v1/daemon/doctor") return { body: { ok: true, status: { running: true, stale: false, health: "alive", scheduled: 0, paused: 0, fired: 0, cancelled: 0, failed: 0, recentDispatches: 0, heartbeatStaleMs: 30000, recentFailures: [], logPath: "log", pidPath: "pid", statePath: "state" }, findings: [] } };
        if (path === "/v1/daemon/service") return { body: { ok: true, action: "status", detail: "remote service status" } };
        return { body: { ok: true, started: true, stopped: false, alreadyRunning: false } };
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
    expect(calls.every((call) => !JSON.stringify(call).includes("secret") || call.headers.Authorization === "Bearer secret")).toBe(true);
  });

  test("returns undefined for a missing dispatch without querying local state", async () => {
    const { calls, fetchImpl } = apiFetch(() => ({ status: 404, body: { error: "not found" } }));
    const client = new DispatchApiClient({ baseUrl: "https://dispatch.hasna.xyz/v1", apiKey: "secret", fetchImpl });
    expect(await client.status("missing")).toBeUndefined();
    expect(calls.map((call) => call.path)).toEqual(["/v1/dispatches/missing"]);
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
