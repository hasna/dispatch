import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The gate decides whether the real-tmux suites run at all, and this repo has
 * no CI, so `bun test`'s exit code is the only thing standing between a broken
 * tmux surface and a green run. These tests drive the gate in a subprocess with
 * a fake `tmux` on PATH — the child's PATH is what resolves the binary.
 */

const GATE = join(import.meta.dir, "tmux-availability.ts");
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch_tmux_gate_"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake `tmux` that answers `-V` but exits `newSessionStatus` for `new-session`. */
function stubTmux(name: string, newSessionStatus: number): { dir: string; callLog: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const callLog = join(dir, "calls.log");
  writeFileSync(
    join(dir, "tmux"),
    [
      "#!/bin/sh",
      `echo "$@" >> ${JSON.stringify(callLog)}`,
      'case "$1" in',
      "  -V) echo 'tmux 3.4'; exit 0 ;;",
      `  new-session) echo 'no server running on /tmp/tmux-0/default' >&2; exit ${newSessionStatus} ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "tmux"), 0o755);
  return { dir, callLog };
}

/** Evaluate the gate in a child process whose PATH (and opt-out) we control. */
function runGate(opts: { path: string; skip?: string }): string {
  const src = [
    `const gate = await import(${JSON.stringify(GATE)});`,
    `try { console.log("RESULT:" + gate.canRunTmuxIntegration()); }`,
    `catch (err) { console.log("THREW:" + (err instanceof Error ? err.message : String(err))); }`,
  ].join("\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.PATH = opts.path;
  if (opts.skip === undefined) delete env.DISPATCH_SKIP_TMUX_INTEGRATION;
  else env.DISPATCH_SKIP_TMUX_INTEGRATION = opts.skip;
  const res = spawnSync(process.execPath, ["-e", src], { encoding: "utf8", env, timeout: 30_000 });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

describe("canRunTmuxIntegration", () => {
  test("throws when tmux is installed but cannot start a session", () => {
    const broken = stubTmux("broken", 1);
    const out = runGate({ path: broken.dir });
    expect(out).toContain("THREW:");
    expect(out).toContain("tmux is installed but cannot start a session");
    expect(out).toContain("DISPATCH_SKIP_TMUX_INTEGRATION=1");
    expect(out).not.toContain("RESULT:");
  });

  test("opts out without probing when DISPATCH_SKIP_TMUX_INTEGRATION=1", () => {
    const broken = stubTmux("opted-out", 1);
    const out = runGate({ path: broken.dir, skip: "1" });
    expect(out).toContain("RESULT:false");
    expect(existsSync(broken.callLog)).toBe(false); // tmux was never invoked
  });

  test("skips quietly when tmux is not installed", () => {
    const empty = join(root, "no-tmux");
    mkdirSync(empty, { recursive: true });
    expect(runGate({ path: empty })).toContain("RESULT:false");
  });

  test("runs when tmux can start a session", () => {
    const healthy = stubTmux("healthy", 0);
    expect(runGate({ path: healthy.dir })).toContain("RESULT:true");
  });
});
