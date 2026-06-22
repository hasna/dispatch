import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codewithFixtureLauncher } from "../test/agent-launcher.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const SESSION = `dispatch_cli_${process.pid}`;
const cli = join(import.meta.dir, "index.ts");
const agent = join(import.meta.dir, "..", "test", "fake-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_cli_data_"));

const d = tmuxAvailable ? describe : describe.skip;

function runCli(args: string[]) {
  return spawnSync("bun", ["run", cli, ...args], {
    encoding: "utf8",
    input: "",
    // Cap the auto-delay so the real submit path stays exercised but fast.
    env: { ...process.env, DISPATCH_DATA_DIR: dataDir, DISPATCH_MAX_DELAY_MS: "500" },
  });
}

function runCliAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("dispatch CLI stdin handling", () => {
  test("send --prompt does not drain an open stdin before parsing flags", () => {
    const res = spawnSync("bash", ["-lc", `tail -f /dev/null | bun run ${JSON.stringify(cli)} send --help`], {
      encoding: "utf8",
      timeout: 4000,
      env: { ...process.env, DISPATCH_DATA_DIR: dataDir },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: dispatch send");
  });

  test("schedule --prompt does not drain an open stdin before parsing flags", () => {
    const res = spawnSync("bash", ["-lc", `tail -f /dev/null | bun run ${JSON.stringify(cli)} schedule --help`], {
      encoding: "utf8",
      timeout: 4000,
      env: { ...process.env, DISPATCH_DATA_DIR: dataDir },
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Usage: dispatch schedule");
  });
});

describe("dispatch CLI concurrent ledger writes", () => {
  test("parallel sends wait for sqlite writer locks instead of throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch_cli_concurrent_"));
    try {
      const env = { ...process.env, DISPATCH_DATA_DIR: dir, DISPATCH_MAX_DELAY_MS: "100" };
      const sends = Array.from({ length: 8 }, (_, i) =>
        runCliAsync(["send", "--to", `dispatch_missing_${i}`, "--prompt", `parallel ${i}`, "--json"], env),
      );
      const results = await Promise.all(sends);
      expect(results.every((r) => r.stderr.includes("database is locked"))).toBe(false);
      for (const result of results) {
        expect(result.stderr).not.toContain("database is locked");
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).status).toBe("failed");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

async function startAgent(): Promise<void> {
  spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
  const res = spawnSync(
    "tmux",
    ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", codewithFixtureLauncher(dataDir), "run", agent],
    { encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`failed to start fake agent: ${res.stderr}`);
  await Bun.sleep(900);
}

d("dispatch CLI send (real tmux + fake agent)", () => {
  beforeEach(async () => {
    await startAgent();
  });
  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("send delivers, auto-submits, confirms, and persists (queryable via status)", () => {
    const send = runCli([
      "send",
      "--to",
      SESSION,
      "--prompt",
      "Please refactor the tokenizer and add unit tests for edge cases.",
      "--json",
    ]);
    expect(send.status).toBe(0);
    const rec = JSON.parse(send.stdout);
    expect(rec.status).toBe("delivered");
    expect(rec.confirm.delivered).toBe(true);
    expect(rec.submitDelayMs).toBeGreaterThan(0);

    // The dispatch is queryable from a fresh CLI invocation (persisted).
    const status = runCli(["status", rec.id, "--json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).id).toBe(rec.id);

    const list = runCli(["list", "--json"]);
    expect(JSON.parse(list.stdout).length).toBeGreaterThanOrEqual(1);
  }, 20000);

  test("send to a nonexistent target fails with exit code 1", () => {
    const send = runCli(["send", "--to", `${SESSION}_nope`, "--prompt", "hi", "--json"]);
    expect(send.status).toBe(1);
    expect(JSON.parse(send.stdout).status).toBe("failed");
  });

  test("send a long multi-paragraph prompt via --file delivers intact and submits", () => {
    const paras = Array.from({ length: 6 }, (_, i) =>
      `Paragraph ${i}: ` + "lorem ipsum dolor sit amet ".repeat(8).trim(),
    ).join("\n\n");
    const f = join(dataDir, "long_prompt.txt");
    writeFileSync(f, paras);
    const send = runCli(["send", "--to", SESSION, "--file", f, "--json"]);
    expect(send.status).toBe(0);
    const rec = JSON.parse(send.stdout);
    expect(rec.status).toBe("delivered");
    expect(rec.confirm.delivered).toBe(true);
  }, 20000);
});
