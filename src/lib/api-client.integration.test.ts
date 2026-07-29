import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * API mode driven end-to-end: a real loopback `/v1` authority, the real CLI
 * binary, the client's own default `fetch` (manual redirects, real headers, real
 * AbortController). Every other API-mode test injects `fetchImpl` and asserts on
 * a promise, so nothing else in the suite exercises the default transport or the
 * process exit code an automation loop actually reads.
 */

const cli = join(import.meta.dir, "..", "cli", "index.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_api_mode_"));

const record = {
  id: "d1",
  kind: "prompt",
  target: "work:agent",
  machine: "local",
  prompt: "deploy prod",
  status: "delivered",
  detail: "working detected",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
};

/** What POST /v1/dispatches answers next. Rewritten per test. */
let dispatchBody: unknown = {};
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/v1/dispatches" && request.method === "POST") return Response.json(dispatchBody);
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  server?.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Spawned asynchronously on purpose: the authority is served from this same
 * process, so a synchronous spawn would block the event loop that has to answer
 * the request the child makes.
 */
async function sendPrompt(): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", cli, "send", "--to", "work:agent", "--prompt", "deploy prod", "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DISPATCH_DATA_DIR: dataDir,
      HASNA_DISPATCH_STORAGE_MODE: "api",
      HASNA_DISPATCH_API_URL: `http://127.0.0.1:${server!.port}`,
      HASNA_DISPATCH_API_KEY: "test-key",
    },
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}

describe("api mode against a live loopback authority", () => {
  test("a conforming dispatch is printed and exits 0", async () => {
    // Positive control. Without it, the failure cases below would also pass for a
    // CLI that is simply broken in API mode.
    dispatchBody = { dispatch: record };
    const run = await sendPrompt();

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: "d1", status: "delivered", detail: "working detected" });
  }, 30_000);

  test("a 200 the client cannot read exits non-zero instead of printing a fabricated success", async () => {
    // The regression: an authority that answers 200 `{}` for POST /v1/dispatches
    // used to make `dispatch send --json` print `{}` and exit 0, so an automation
    // loop reads exit 0 and believes the prompt reached the pane. Without --json
    // the same call died with a raw `text.replace` TypeError out of the formatter.
    dispatchBody = {};
    const run = await sendPrompt();

    expect(run.status).not.toBe(0);
    expect(run.stdout.trim()).toBe("");
    expect(run.stderr).toContain("REMOTE_API_MALFORMED_RESPONSE");
    expect(run.stderr).toContain("POST /dispatches");
    expect(run.stderr).not.toContain("test-key");
  }, 30_000);

  test("a partially-filled record is rejected the same way as an empty body", async () => {
    dispatchBody = { dispatch: { id: "d1", target: "work:agent", status: "delivered" } };
    const run = await sendPrompt();

    expect(run.status).not.toBe(0);
    expect(run.stdout.trim()).toBe("");
    expect(run.stderr).toContain("REMOTE_API_MALFORMED_RESPONSE");
  }, 30_000);
});
