import type { ZodIssue, ZodTypeAny } from "zod";
import type { StartDaemonResult } from "../daemon/daemon.js";
import type { ServiceAction, ServiceResult } from "../daemon/service.js";
import type { DaemonStatus, StopDaemonResult } from "../daemon/control.js";
import {
  agentRecoverResultSchema,
  agentTriageResultSchema,
  bulkDispatchResultSchema,
  captureResultSchema,
  daemonDoctorResultSchema,
  daemonEnsureResultSchema,
  daemonRestartResultSchema,
  daemonServiceResultSchema,
  daemonStatusSchema,
  dispatchRecordSchema,
  dispatchTargetRowSchema,
  fleetSummaryResultSchema,
  scheduledDispatchSchema,
  startDaemonResultSchema,
  stopDaemonResultSchema,
} from "./api-schemas.js";
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

/**
 * Outcome of an API-mode routing attempt. `routed` records whether the remote
 * authority answered the call; it is never derived from the payload value, so a
 * falsy or empty remote response can never be mistaken for "local mode".
 */
export type DispatchApiRouteResult<T> = { routed: true; value: T } | { routed: false };

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

/**
 * A 2xx with no payload from an endpoint that must return one. Raised instead of
 * resolving `undefined`, because `undefined` is indistinguishable from "this
 * command did not route to the API" at the call sites.
 */
export class DispatchApiEmptyResponseError extends Error {
  readonly method: string;
  readonly path: string;

  constructor(baseUrl: string, method: string, path: string) {
    super(
      `REMOTE_API_EMPTY_RESPONSE: configured Dispatch authority ${baseUrl} returned an empty body for ${method} ${path}; local fallback is disabled`,
    );
    this.name = "DispatchApiEmptyResponseError";
    this.method = method;
    this.path = path;
  }
}

/**
 * A 2xx whose payload does not match the endpoint's `/v1` response contract.
 * Same fail-closed family as {@link DispatchApiEmptyResponseError}: without it a
 * body the client cannot interpret — `{}`, `[]`, `{"ok":true}`, an HTML error
 * page — is coerced with `as T` and handed to the caller as a completed
 * dispatch, so `dispatch send --json` prints `{}` and exits 0 while the prompt's
 * fate is unknown.
 */
export class DispatchApiMalformedResponseError extends Error {
  readonly method: string;
  readonly path: string;
  readonly issues: string[];

  constructor(baseUrl: string, method: string, path: string, issues: string[]) {
    super(
      `REMOTE_API_MALFORMED_RESPONSE: configured Dispatch authority ${baseUrl} answered ${method} ${path} with a body that does not match the documented response contract (${issues.join("; ")}); local fallback is disabled`,
    );
    this.name = "DispatchApiMalformedResponseError";
    this.method = method;
    this.path = path;
    this.issues = issues;
  }
}

/**
 * The first key that carries a value, in precedence order. Later keys are pure
 * aliases: once an earlier one wins they are never read, so their contents can
 * never affect the outcome.
 */
function firstEnv<K extends string>(env: Env, keys: readonly K[]): { key: K; value: string } | null {
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

/** True when the failure is a client-side abort/timeout rather than an authority response. */
function isAbortLike(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /abort|timed?\s*out/i.test(message);
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
  // Same rule the retry loop uses: only a failure with no numeric status can be a
  // client-side abort. `isAbortLike` matches on the message, and an answered
  // request's message embeds the route, so an id or schedule name spelling
  // "abort"/"timeout" would otherwise forge a timeout out of a real 404 — hiding
  // the not-found handling in status/scheduleStatus/clearSchedule/scheduleAction
  // and blaming authority health for a request the authority answered at once.
  if (typeof status !== "number" && isAbortLike(error)) {
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

/**
 * What an endpoint is allowed to answer. Every request declares one, so an
 * endpoint cannot be added without stating the shape it promises: a body that
 * fails its contract is a remote failure, never a coerced success.
 */
type ResponseContract =
  | { readonly kind: "object"; readonly schema: ZodTypeAny; readonly keys: readonly string[] }
  | { readonly kind: "list"; readonly item: ZodTypeAny | null; readonly keys: readonly string[] }
  | { readonly kind: "boolean"; readonly keys: readonly string[] };

/** A single object payload, optionally wrapped under one of `keys`. */
function objectResponse(schema: ZodTypeAny, keys: readonly string[] = []): ResponseContract {
  return { kind: "object", schema, keys };
}

/** An array payload, bare or wrapped under one of `keys`. `item` null means the rows are untyped. */
function listResponse(item: ZodTypeAny | null, keys: readonly string[]): ResponseContract {
  return { kind: "list", item, keys };
}

/** A yes/no outcome, sent bare or as `{ <key>: boolean }`. */
function booleanResponse(keys: readonly string[]): ResponseContract {
  return { kind: "boolean", keys };
}

function describeKeys(keys: readonly string[]): string {
  return keys.map((key) => `"${key}"`).join(" or ");
}

/**
 * Render zod issues as field path plus expectation only. The received value is
 * deliberately never echoed: the body is authority-controlled and can carry
 * transcript text, and a diagnostic is not a place to reprint it.
 */
function describeIssues(issues: readonly ZodIssue[], prefix?: string): string[] {
  return issues.slice(0, 5).map((issue) => {
    const path = [...(prefix ? [prefix] : []), ...issue.path.map(String)].join(".") || "<root>";
    return issue.code === "invalid_type" ? `${path}: expected ${issue.expected}` : `${path}: ${issue.code}`;
  });
}

function unwrapObject(raw: unknown, keys: readonly string[]): unknown {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (obj[key] !== undefined) return obj[key];
    }
  }
  return raw;
}

function unwrapList(raw: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      const value = obj[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/**
 * Unwrap the declared envelope and check the payload against the contract.
 *
 * The authority's own value is returned rather than zod's parse output, so a
 * conforming authority never loses fields this client does not model — the
 * schema is a gate, not a transform.
 */
function checkResponse(contract: ResponseContract, raw: unknown, fail: (issues: string[]) => never): unknown {
  if (contract.kind === "list") {
    const rows = unwrapList(raw, contract.keys);
    if (!rows) fail([`<root>: expected an array or an object carrying ${describeKeys(contract.keys)}`]);
    if (contract.item) {
      for (const [index, row] of rows.entries()) {
        const parsed = contract.item.safeParse(row);
        if (!parsed.success) fail(describeIssues(parsed.error.issues, String(index)));
      }
    }
    return rows;
  }
  if (contract.kind === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      for (const key of contract.keys) {
        if (typeof obj[key] === "boolean") return obj[key];
      }
    }
    fail([`<root>: expected a boolean or an object carrying ${describeKeys(contract.keys)}`]);
  }
  const value = unwrapObject(raw, contract.keys);
  const parsed = contract.schema.safeParse(value);
  if (!parsed.success) fail(describeIssues(parsed.error.issues));
  return value;
}

export function getDispatchApiConfigStatus(env: Env = process.env as Env): DispatchApiConfigStatus {
  // Resolve precedence first, then validate only the variable that actually
  // wins. Validating the loser too would let a stale `DISPATCH_STORAGE_MODE`
  // left over from an older install veto an explicitly set
  // `HASNA_DISPATCH_STORAGE_MODE` and hard-fail every command, including the
  // default local mode that never reads either value.
  const modeHit = firstEnv(env, ["HASNA_DISPATCH_STORAGE_MODE", "DISPATCH_STORAGE_MODE"]);
  const selectedMode = cleanMode(modeHit?.value);
  const urlHit = firstEnv(env, ["HASNA_DISPATCH_API_URL", "DISPATCH_API_URL"]);
  const keyHit = firstEnv(env, ["HASNA_DISPATCH_API_KEY", "DISPATCH_API_KEY"]);

  if (modeHit && selectedMode && !VALID_MODES.has(selectedMode)) {
    return {
      selected: true,
      ok: false,
      mode: selectedMode,
      source: modeHit.key,
      apiUrlConfigured: Boolean(urlHit),
      apiKeyConfigured: Boolean(keyHit),
      v1BaseUrl: null,
      issues: [
        `REMOTE_STORAGE_MODE_INVALID: ${modeHit.key}=${selectedMode} must be local, api, remote, self_hosted, cloud, or hybrid; local fallback is disabled`,
      ],
      localFallback: false,
    };
  }

  let mode = selectedMode ?? "local";
  let source: DispatchApiConfigStatus["source"] = modeHit ? modeHit.key : "default";
  if (!selectedMode && urlHit && keyHit) {
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
    expect: ResponseContract,
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
    // The Idempotency-Key is advisory metadata for the authority. It does NOT license
    // client retries: no authority in this repo implements or is tested against an
    // idempotency contract, so replaying a side-effecting POST could type a prompt or
    // shell command into a live pane twice. Only HTTP-idempotent methods are retried.
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const methodRetryable = IDEMPOTENT.has(upper);
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
        if (response.ok) {
          if (parsed === undefined || parsed === null) throw new DispatchApiEmptyResponseError(this.baseUrl, upper, rel);
          // An answered 2xx is a definitive answer, so a body that fails its
          // contract is reported as a remote failure rather than replayed or
          // coerced. Both halves of that rule matter: coercion fabricates
          // success, and replaying would resend a side-effecting POST.
          return checkResponse(expect, parsed, (issues) => {
            throw new DispatchApiMalformedResponseError(this.baseUrl, upper, rel, issues);
          }) as T;
        }
        last = new DispatchApiError(upper, rel, response.status, parsed);
      } catch (error) {
        if (error instanceof DispatchApiEmptyResponseError || error instanceof DispatchApiMalformedResponseError) throw error;
        last = error;
      } finally {
        clearTimeout(timer);
      }
      const status = last && typeof last === "object" ? (last as { status?: unknown }).status : undefined;
      // A client-side abort/timeout is not proof the authority never received the
      // request, so it is never retried regardless of method. Only transport-level
      // failures qualify — an authority response always carries a numeric status.
      const abortedInFlight = typeof status !== "number" && isAbortLike(last);
      if (!methodRetryable || attempt >= attempts || abortedInFlight || (typeof status === "number" && !RETRY_STATUSES.has(status))) break;
      await this.sleepImpl(Math.min(2_000, 200 * 2 ** (attempt - 1)));
    }
    return routeError(this.baseUrl.replace(/\/v1$/, ""), rel, last);
  }

  async send(options: DispatchOptions): Promise<DispatchRecord> {
    return this.request("POST", "/dispatches", objectResponse(dispatchRecordSchema, ["dispatch", "record"]), { options }, {
      idempotencyKey: randomIdempotencyKey(),
    });
  }

  async bulkSend(options: BulkDispatchOptions): Promise<BulkDispatchResult> {
    return this.request("POST", "/dispatches/bulk", objectResponse(bulkDispatchResultSchema, ["bulk", "result"]), { options }, {
      idempotencyKey: randomIdempotencyKey(),
    });
  }

  async exec(options: ExecOptions): Promise<DispatchRecord> {
    return this.request("POST", "/exec", objectResponse(dispatchRecordSchema, ["dispatch", "record"]), { options }, {
      idempotencyKey: randomIdempotencyKey(),
    });
  }

  async key(options: KeyOptions): Promise<DispatchRecord> {
    return this.request("POST", "/keys", objectResponse(dispatchRecordSchema, ["dispatch", "record"]), { options }, {
      idempotencyKey: randomIdempotencyKey(),
    });
  }

  async capture(options: CaptureOptions): Promise<CaptureResult> {
    return this.request("POST", "/captures", objectResponse(captureResultSchema, ["capture", "result"]), { options });
  }

  async triage(options: AgentTriageOptions): Promise<AgentTriageResult> {
    return this.request("POST", "/triage", objectResponse(agentTriageResultSchema, ["triage", "result"]), { options });
  }

  async recover(options: AgentRecoverOptions): Promise<AgentRecoverResult> {
    return this.request("POST", "/recover", objectResponse(agentRecoverResultSchema, ["recover", "result"]), { options }, {
      idempotencyKey: randomIdempotencyKey(),
    });
  }

  async fleetSummary(options: FleetSummaryOptions = {}): Promise<FleetSummaryResult> {
    return this.request("POST", "/fleet/summary", objectResponse(fleetSummaryResultSchema, ["summary", "result"]), { options });
  }

  async targets(options: DispatchTargetsOptions = {}): Promise<unknown[]> {
    return this.request("GET", "/targets", listResponse(dispatchTargetRowSchema, ["targets", "items", "data", "results"]), undefined, {
      query: {
        machine: options.machine,
        backend: options.backend,
        limit: options.all ? undefined : options.limit,
        all: options.all === true ? true : undefined,
        verbose: options.verbose === true ? true : undefined,
      },
    });
  }

  async status(id: string): Promise<DispatchRecord | undefined> {
    try {
      return await this.request(
        "GET",
        `/dispatches/${encodeURIComponent(id)}`,
        objectResponse(dispatchRecordSchema, ["dispatch", "record"]),
      );
    } catch (error) {
      if (error instanceof DispatchApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async list(opts: { status?: DispatchStatus; limit?: number } = {}): Promise<DispatchRecord[]> {
    return this.request("GET", "/dispatches", listResponse(dispatchRecordSchema, ["dispatches", "records", "items", "data", "results"]), undefined, {
      query: opts,
    });
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
    return this.request("POST", "/schedules", objectResponse(scheduledDispatchSchema, ["schedule"]), input, {
      idempotencyKey: randomIdempotencyKey(),
    });
  }

  async loop(input: { options: DispatchOptions; every: string; name?: string; from?: Date }): Promise<ScheduledDispatch> {
    return this.request("POST", "/loops", objectResponse(scheduledDispatchSchema, ["loop", "schedule"]), input, {
      idempotencyKey: randomIdempotencyKey(),
    });
  }

  async scheduleStatus(id: string): Promise<ScheduledDispatch | undefined> {
    try {
      return await this.request("GET", `/schedules/${encodeURIComponent(id)}`, objectResponse(scheduledDispatchSchema, ["schedule"]));
    } catch (error) {
      if (!(error instanceof DispatchApiError) || error.status !== 404) throw error;
    }
    try {
      return await this.request("GET", `/loops/${encodeURIComponent(id)}`, objectResponse(scheduledDispatchSchema, ["loop", "schedule"]));
    } catch (error) {
      if (error instanceof DispatchApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  async listSchedules(opts: { status?: ScheduleStatus; kind?: ScheduleKind; limit?: number } = {}): Promise<ScheduledDispatch[]> {
    return this.request("GET", "/schedules", listResponse(scheduledDispatchSchema, ["schedules", "items", "data", "results"]), undefined, {
      query: opts,
    });
  }

  async listLoops(opts: { status?: ScheduleStatus; limit?: number } = {}): Promise<ScheduledDispatch[]> {
    try {
      return await this.request(
        "GET",
        "/loops",
        listResponse(scheduledDispatchSchema, ["loops", "schedules", "items", "data", "results"]),
        undefined,
        { query: opts },
      );
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
    const cleared = booleanResponse(["cleared", "deleted"]);
    try {
      return await this.request("DELETE", `/schedules/${encodeURIComponent(id)}`, cleared);
    } catch (error) {
      if (!(error instanceof DispatchApiError) || error.status !== 404) throw error;
    }
    try {
      return await this.request("DELETE", `/loops/${encodeURIComponent(id)}`, cleared);
    } catch (error) {
      if (error instanceof DispatchApiError && error.status === 404) return false;
      throw error;
    }
  }

  async daemonStart(): Promise<StartDaemonResult> {
    return this.request("POST", "/daemon/start", objectResponse(startDaemonResultSchema), {});
  }

  async daemonStop(): Promise<StopDaemonResult> {
    return this.request("POST", "/daemon/stop", objectResponse(stopDaemonResultSchema), {});
  }

  async daemonEnsure(): Promise<DispatchDaemonEnsureResult> {
    return this.request("POST", "/daemon/ensure", objectResponse(daemonEnsureResultSchema), {});
  }

  async daemonRestart(): Promise<{ ok: boolean; stopped: StopDaemonResult; started: StartDaemonResult }> {
    return this.request("POST", "/daemon/restart", objectResponse(daemonRestartResultSchema), {});
  }

  async daemonStatus(): Promise<DaemonStatus> {
    return this.request("GET", "/daemon/status", objectResponse(daemonStatusSchema));
  }

  async daemonDoctor(): Promise<DispatchDaemonDoctorResult> {
    return this.request("GET", "/daemon/doctor", objectResponse(daemonDoctorResultSchema));
  }

  async daemonService(options: DispatchDaemonServiceOptions): Promise<ServiceResult> {
    return this.request("POST", "/daemon/service", objectResponse(daemonServiceResultSchema), options);
  }

  close(): void {
    /* no persistent local handle */
  }

  private async scheduleAction(id: string, action: "cancel" | "pause" | "resume", keys: readonly string[]): Promise<boolean> {
    const applied = booleanResponse(keys);
    try {
      return await this.request("POST", `/schedules/${encodeURIComponent(id)}/${action}`, applied, {});
    } catch (error) {
      if (!(error instanceof DispatchApiError) || error.status !== 404) throw error;
    }
    try {
      return await this.request("POST", `/loops/${encodeURIComponent(id)}/${action}`, applied, {});
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
