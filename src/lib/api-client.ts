import type { StartDaemonResult } from "../daemon/daemon.js";
import type { ServiceAction, ServiceResult } from "../daemon/service.js";
import type { DaemonStatus, StopDaemonResult } from "../daemon/control.js";
import type {
  AgentRecoverOptions,
  AgentRecoverResult,
  AgentTriageOptions,
  AgentTriageResult,
  BulkDispatchOptions,
  BulkDispatchResult,
  CaptureOptions,
  CaptureResult,
  DispatchBackend,
  DispatchOptions,
  DispatchRecord,
  DispatchStatus,
  ExecOptions,
  FleetSummaryOptions,
  FleetSummaryResult,
  KeyOptions,
  ScheduleKind,
  ScheduledDispatch,
  ScheduleStatus,
} from "../types.js";

export type Env = Record<string, string | undefined>;
export type DispatchClientRoute = "local" | "api-http";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API_MODES = new Set(["api", "self_hosted", "remote", "cloud", "hybrid"]);
const VALID_MODES = new Set(["local", ...API_MODES]);
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

export interface DispatchApiConfigStatus {
  selected: boolean;
  ok: boolean;
  mode: string;
  source: "HASNA_DISPATCH_STORAGE_MODE" | "DISPATCH_STORAGE_MODE" | "auto:api-url+api-key" | "default";
  apiUrlConfigured: boolean;
  apiKeyConfigured: boolean;
  v1BaseUrl: string | null;
  issues: string[];
  localFallback: false;
}

export interface DispatchApiClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface DispatchTargetsOptions {
  machine?: string;
  backend?: DispatchBackend;
  limit?: number;
  all?: boolean;
  verbose?: boolean;
}

export interface DispatchDaemonEnsureResult {
  ok: boolean;
  started: boolean;
  alreadyRunning: boolean;
  before?: DaemonStatus;
  after?: DaemonStatus;
}

export interface DispatchDaemonDoctorResult {
  ok: boolean;
  status: DaemonStatus;
  findings: string[];
}

export interface DispatchDaemonServiceOptions {
  action: ServiceAction;
  start?: boolean;
}

export class DispatchApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(method: string, path: string, status: number, body: unknown) {
    super(`Dispatch API request failed: ${method} ${path} -> ${status}`);
    this.name = "DispatchApiError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }
}

function firstEnv(env: Env, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

function cleanMode(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  return normalized || null;
}

function normalizeApiAuthorityUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_DISPATCH_API_URL must be an absolute http(s) URL; local fallback is disabled");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_DISPATCH_API_URL must be an absolute http(s) URL; local fallback is disabled");
  }
  if (url.username || url.password) {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_DISPATCH_API_URL must not contain userinfo; local fallback is disabled");
  }
  if (url.search || url.hash) {
    throw new Error("REMOTE_API_URL_INVALID: HASNA_DISPATCH_API_URL must not contain a query or fragment; local fallback is disabled");
  }
  if (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/") {
    throw new Error(
      "REMOTE_API_URL_INVALID: HASNA_DISPATCH_API_URL must be an authority root or end in /v1; local fallback is disabled",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (url.protocol === "http:" && !loopback) {
    throw new Error("REMOTE_API_URL_INVALID: plaintext HTTP is allowed only for loopback Dispatch authorities; local fallback is disabled");
  }
  return `${url.origin}/v1`;
}

function routeError(baseUrl: string, route: string, error: unknown): never {
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  if (status === 401) {
    throw new Error(
      `REMOTE_API_UNAUTHORIZED: configured Dispatch authority ${baseUrl} rejected HASNA_DISPATCH_API_KEY for ${route}; local fallback is disabled`,
      { cause: error },
    );
  }
  if (status === 403) {
    throw new Error(
      `REMOTE_API_FORBIDDEN: configured Dispatch authority ${baseUrl} denied ${route}; local fallback is disabled`,
      { cause: error },
    );
  }
  if (typeof status === "number" && status >= 300 && status < 400) {
    throw new Error(
      `REMOTE_API_REDIRECT_REJECTED: configured Dispatch authority ${baseUrl} redirected ${route}; authenticated redirects are disabled`,
      { cause: error },
    );
  }
  if (typeof status === "number" && status >= 500) {
    throw new Error(
      `REMOTE_API_UNAVAILABLE: configured Dispatch authority ${baseUrl} returned HTTP ${status} for ${route}; local fallback is disabled`,
      { cause: error },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if ((error instanceof Error && error.name === "AbortError") || /abort|timed?\s*out/i.test(message)) {
    throw new Error(`REMOTE_API_TIMEOUT: configured Dispatch authority ${baseUrl} timed out for ${route}; local fallback is disabled`, {
      cause: error,
    });
  }
  if (status === undefined) {
    throw new Error(
      `REMOTE_API_UNREACHABLE: configured Dispatch authority ${baseUrl} could not be reached for ${route}; local fallback is disabled`,
      { cause: error },
    );
  }
  throw error;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomIdempotencyKey(): string {
  const cryptoLike = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID();
  return `dispatch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function appendQuery(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
}

function envelope<T>(raw: unknown, keys: readonly string[]): T {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (obj[key] !== undefined) return obj[key] as T;
    }
  }
  return raw as T;
}

function listEnvelope<T>(raw: unknown, keys: readonly string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

function booleanEnvelope(raw: unknown, keys: readonly string[]): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (typeof obj[key] === "boolean") return obj[key] as boolean;
    }
  }
  return false;
}

export function getDispatchApiConfigStatus(env: Env = process.env as Env): DispatchApiConfigStatus {
  const canonical = cleanMode(env.HASNA_DISPATCH_STORAGE_MODE);
  const fallback = cleanMode(env.DISPATCH_STORAGE_MODE);
  const urlHit = firstEnv(env, ["HASNA_DISPATCH_API_URL", "DISPATCH_API_URL"]);
  const keyHit = firstEnv(env, ["HASNA_DISPATCH_API_KEY", "DISPATCH_API_KEY"]);

  for (const [source, value] of [
    ["HASNA_DISPATCH_STORAGE_MODE", canonical],
    ["DISPATCH_STORAGE_MODE", fallback],
  ] as const) {
    if (value && !VALID_MODES.has(value)) {
      return {
        selected: true,
        ok: false,
        mode: value,
        source,
        apiUrlConfigured: Boolean(urlHit),
        apiKeyConfigured: Boolean(keyHit),
        v1BaseUrl: null,
        issues: [
          `REMOTE_STORAGE_MODE_INVALID: ${source}=${value} must be local, api, remote, self_hosted, cloud, or hybrid; local fallback is disabled`,
        ],
        localFallback: false,
      };
    }
  }

  let mode = canonical ?? fallback ?? "local";
  let source: DispatchApiConfigStatus["source"] = canonical ? "HASNA_DISPATCH_STORAGE_MODE" : fallback ? "DISPATCH_STORAGE_MODE" : "default";
  if (!canonical && !fallback && urlHit && keyHit) {
    mode = "api";
    source = "auto:api-url+api-key";
  }

  if (mode === "local") {
    return {
      selected: false,
      ok: true,
      mode,
      source,
      apiUrlConfigured: Boolean(urlHit),
      apiKeyConfigured: Boolean(keyHit),
      v1BaseUrl: null,
      issues: [],
      localFallback: false,
    };
  }

  const issues: string[] = [];
  let v1BaseUrl: string | null = null;
  if (!urlHit) {
    issues.push("REMOTE_API_URL_MISSING: remote Dispatch API mode requires HASNA_DISPATCH_API_URL; local fallback is disabled");
  } else {
    try {
      v1BaseUrl = normalizeApiAuthorityUrl(urlHit.value);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!keyHit) {
    issues.push("REMOTE_API_KEY_MISSING: remote Dispatch API mode requires HASNA_DISPATCH_API_KEY; local fallback is disabled");
  }
  return {
    selected: true,
    ok: issues.length === 0,
    mode,
    source,
    apiUrlConfigured: Boolean(urlHit),
    apiKeyConfigured: Boolean(keyHit),
    v1BaseUrl,
    issues,
    localFallback: false,
  };
}

export class DispatchApiClient {
  readonly mode = "api-http";
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: DispatchApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, { ...init, redirect: "manual" }));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { query?: Record<string, string | number | boolean | undefined>; idempotencyKey?: string; retries?: number } = {},
  ): Promise<T> {
    const upper = method.toUpperCase();
    const rel = appendQuery(path.startsWith("/") ? path : `/${path}`, opts.query);
    const url = `${this.baseUrl}${rel}`;
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const methodRetryable = IDEMPOTENT.has(upper) || Boolean(opts.idempotencyKey);
    const attempts = methodRetryable ? (opts.retries ?? 2) + 1 : 1;
    let last: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const init: RequestInit = { method: upper, headers, signal: controller.signal };
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(body);
        }
        const response = await this.fetchImpl(url, init);
        const text = await response.text();
        const parsed = text ? safeJson(text) : undefined;
        if (response.ok) return parsed as T;
        last = new DispatchApiError(upper, rel, response.status, parsed);
      } catch (error) {
        last = error;
      } finally {
        clearTimeout(timer);
      }
      const status = last && typeof last === "object" ? (last as { status?: unknown }).status : undefined;
      if (!methodRetryable || attempt >= attempts || (typeof status === "number" && !RETRY_STATUSES.has(status))) break;
      await this.sleepImpl(Math.min(2_000, 200 * 2 ** (attempt - 1)));
    }
    return routeError(this.baseUrl.replace(/\/v1$/, ""), rel, last);
  }

  async send(options: DispatchOptions): Promise<DispatchRecord> {
    return envelope(await this.request("POST", "/dispatches", { options }, { idempotencyKey: randomIdempotencyKey() }), [
      "dispatch",
      "record",
    ]);
  }

  async bulkSend(options: BulkDispatchOptions): Promise<BulkDispatchResult> {
    return envelope(await this.request("POST", "/dispatches/bulk", { options }, { idempotencyKey: randomIdempotencyKey() }), [
      "bulk",
      "result",
    ]);
  }

  async exec(options: ExecOptions): Promise<DispatchRecord> {
    return envelope(await this.request("POST", "/exec", { options }, { idempotencyKey: randomIdempotencyKey() }), [
      "dispatch",
      "record",
    ]);
  }

  async key(options: KeyOptions): Promise<DispatchRecord> {
    return envelope(await this.request("POST", "/keys", { options }, { idempotencyKey: randomIdempotencyKey() }), [
      "dispatch",
      "record",
    ]);
  }

  async capture(options: CaptureOptions): Promise<CaptureResult> {
    return envelope(await this.request("POST", "/captures", { options }), ["capture", "result"]);
  }

  async triage(options: AgentTriageOptions): Promise<AgentTriageResult> {
    return envelope(await this.request("POST", "/triage", { options }), ["triage", "result"]);
  }

  async recover(options: AgentRecoverOptions): Promise<AgentRecoverResult> {
    return envelope(await this.request("POST", "/recover", { options }, { idempotencyKey: randomIdempotencyKey() }), [
      "recover",
      "result",
    ]);
  }

  async fleetSummary(options: FleetSummaryOptions = {}): Promise<FleetSummaryResult> {
    return envelope(await this.request("POST", "/fleet/summary", { options }), ["summary", "result"]);
  }

  async targets(options: DispatchTargetsOptions = {}): Promise<unknown[]> {
    const raw = await this.request("GET", "/targets", undefined, {
      query: {
        machine: options.machine,
        backend: options.backend,
        limit: options.all ? undefined : options.limit,
        all: options.all === true ? true : undefined,
        verbose: options.verbose === true ? true : undefined,
      },
    });
    return listEnvelope(raw, ["targets", "items", "data", "results"]);
  }

  async status(id: string): Promise<DispatchRecord | undefined> {
    try {
      return envelope(await this.request("GET", `/dispatches/${encodeURIComponent(id)}`), ["dispatch", "record"]);
    } catch (error) {
      if (error instanceof DispatchApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async list(opts: { status?: DispatchStatus; limit?: number } = {}): Promise<DispatchRecord[]> {
    const raw = await this.request("GET", "/dispatches", undefined, { query: opts });
    return listEnvelope(raw, ["dispatches", "records", "items", "data", "results"]);
  }

  async schedule(input: {
    options: DispatchOptions;
    at?: string;
    in?: string;
    cron?: string;
    every?: string;
    intervalMs?: number;
    name?: string;
    from?: Date;
  }): Promise<ScheduledDispatch> {
    return envelope(await this.request("POST", "/schedules", input, { idempotencyKey: randomIdempotencyKey() }), [
      "schedule",
    ]);
  }

  async loop(input: { options: DispatchOptions; every: string; name?: string; from?: Date }): Promise<ScheduledDispatch> {
    return envelope(await this.request("POST", "/loops", input, { idempotencyKey: randomIdempotencyKey() }), [
      "loop",
      "schedule",
    ]);
  }

  async scheduleStatus(id: string): Promise<ScheduledDispatch | undefined> {
    try {
      return envelope(await this.request("GET", `/schedules/${encodeURIComponent(id)}`), ["schedule"]);
    } catch (error) {
      if (!(error instanceof DispatchApiError) || error.status !== 404) throw error;
    }
    try {
      return envelope(await this.request("GET", `/loops/${encodeURIComponent(id)}`), ["loop", "schedule"]);
    } catch (error) {
      if (error instanceof DispatchApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async listSchedules(opts: { status?: ScheduleStatus; kind?: ScheduleKind; limit?: number } = {}): Promise<ScheduledDispatch[]> {
    const raw = await this.request("GET", "/schedules", undefined, { query: opts });
    return listEnvelope(raw, ["schedules", "items", "data", "results"]);
  }

  async listLoops(opts: { status?: ScheduleStatus; limit?: number } = {}): Promise<ScheduledDispatch[]> {
    try {
      const raw = await this.request("GET", "/loops", undefined, { query: opts });
      return listEnvelope(raw, ["loops", "schedules", "items", "data", "results"]);
    } catch (error) {
      if (!(error instanceof DispatchApiError) || error.status !== 404) throw error;
    }
    return this.listSchedules({ ...opts, kind: "loop" });
  }

  async cancelSchedule(id: string): Promise<boolean> {
    return this.scheduleAction(id, "cancel", ["cancelled"]);
  }

  async pauseSchedule(id: string): Promise<boolean> {
    return this.scheduleAction(id, "pause", ["paused"]);
  }

  async resumeSchedule(id: string): Promise<boolean> {
    return this.scheduleAction(id, "resume", ["resumed"]);
  }

  async clearSchedule(id: string): Promise<boolean> {
    try {
      return booleanEnvelope(await this.request("DELETE", `/schedules/${encodeURIComponent(id)}`), ["cleared", "deleted"]);
    } catch (error) {
      if (!(error instanceof DispatchApiError) || error.status !== 404) throw error;
    }
    try {
      return booleanEnvelope(await this.request("DELETE", `/loops/${encodeURIComponent(id)}`), ["cleared", "deleted"]);
    } catch (error) {
      if (error instanceof DispatchApiError && error.status === 404) return false;
      throw error;
    }
  }

  async daemonStart(): Promise<StartDaemonResult> {
    return this.request("POST", "/daemon/start", {});
  }

  async daemonStop(): Promise<StopDaemonResult> {
    return this.request("POST", "/daemon/stop", {});
  }

  async daemonEnsure(): Promise<DispatchDaemonEnsureResult> {
    return this.request("POST", "/daemon/ensure", {});
  }

  async daemonRestart(): Promise<{ ok: boolean; stopped: StopDaemonResult; started: StartDaemonResult }> {
    return this.request("POST", "/daemon/restart", {});
  }

  async daemonStatus(): Promise<DaemonStatus> {
    return this.request("GET", "/daemon/status");
  }

  async daemonDoctor(): Promise<DispatchDaemonDoctorResult> {
    return this.request("GET", "/daemon/doctor");
  }

  async daemonService(options: DispatchDaemonServiceOptions): Promise<ServiceResult> {
    return this.request("POST", "/daemon/service", options);
  }

  close(): void {
    /* no persistent local handle */
  }

  private async scheduleAction(id: string, action: "cancel" | "pause" | "resume", keys: readonly string[]): Promise<boolean> {
    try {
      return booleanEnvelope(await this.request("POST", `/schedules/${encodeURIComponent(id)}/${action}`, {}), keys);
    } catch (error) {
      if (!(error instanceof DispatchApiError) || error.status !== 404) throw error;
    }
    try {
      return booleanEnvelope(await this.request("POST", `/loops/${encodeURIComponent(id)}/${action}`, {}), keys);
    } catch (error) {
      if (error instanceof DispatchApiError && error.status === 404) return false;
      throw error;
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function getDispatchApiClient(env: Env = process.env as Env, fetchImpl?: FetchLike): DispatchApiClient | null {
  const status = getDispatchApiConfigStatus(env);
  if (!status.selected) return null;
  if (!status.ok) throw new Error(status.issues[0] ?? "Dispatch API mode is misconfigured; local fallback is disabled");
  const key = firstEnv(env, ["HASNA_DISPATCH_API_KEY", "DISPATCH_API_KEY"])?.value;
  if (!key) throw new Error("Dispatch API mode resolved without an API key; local fallback is disabled");
  return new DispatchApiClient({ baseUrl: status.v1BaseUrl!, apiKey: key, ...(fetchImpl ? { fetchImpl } : {}) });
}
