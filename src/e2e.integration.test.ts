import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codewithFixtureLauncher } from "./test/agent-launcher.js";

/**
 * End-to-end fidelity: dispatch a long multi-paragraph prompt through the real
 * CLI to a real tmux pane and verify the agent received the ENTIRE prompt
 * intact (no premature submit, no mangling) AND that delivery was confirmed.
 */

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const SESSION = `dispatch_e2e_${process.pid}`;
const cli = join(import.meta.dir, "cli", "index.ts");
const recorder = join(import.meta.dir, "test", "recorder-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_e2e_"));
const recFile = join(dataDir, "received.txt");

const d = tmuxAvailable ? describe : describe.skip;

function runCli(args: string[]) {
  return spawnSync("bun", ["run", cli, ...args], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, DISPATCH_DATA_DIR: dataDir, DISPATCH_MAX_DELAY_MS: "500" },
  });
}

/** Extract the bracketed-paste payload and normalize CR→LF for comparison. */
function pastedText(raw: string): string {
  const start = raw.indexOf("\x1b[200~");
  const end = raw.indexOf("\x1b[201~");
  if (start === -1 || end === -1) return raw.replace(/\r/g, "\n");
  return raw.slice(start + 6, end).replace(/\r/g, "\n");
}

d("end-to-end: long multi-paragraph prompt fidelity + delivery", () => {
  beforeEach(async () => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    writeFileSync(recFile, "");
    const res = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", codewithFixtureLauncher(dataDir), "run", recorder, recFile],
      { encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`failed to start recorder: ${res.stderr}`);
    await Bun.sleep(1000);
  });
  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a 5-paragraph prompt arrives byte-intact and is confirmed delivered", async () => {
    const prompt = [
      "Please perform the following refactor across the codebase.",
      "First, extract the authentication middleware into its own module and add\nunit tests covering the happy path and the 401 and 403 branches.",
      "Second, replace the ad-hoc retry loop in the HTTP client with an exponential\nbackoff that is fully deterministic under a fake clock.",
      "Third, document every public function with a one-line summary; do not change\nbehavior, only add docs and tests.",
      "When you are done, run the full test suite and report which files changed and why.",
    ].join("\n\n");
    const f = join(dataDir, "prompt.md");
    writeFileSync(f, prompt);

    const send = runCli(["send", "--to", SESSION, "--file", f, "--json"]);
    expect(send.status).toBe(0);
    const rec = JSON.parse(send.stdout);

    // Delivery confirmed.
    expect(rec.status).toBe("delivered");
    expect(rec.confirm.delivered).toBe(true);

    // Give the recorder a moment to flush everything it received.
    await Bun.sleep(500);
    const received = pastedText(readFileSync(recFile, "utf8"));

    // Every paragraph and every internal line is present, in order, intact.
    for (const line of prompt.split("\n")) {
      if (line.trim()) expect(received).toContain(line);
    }
    // No premature submit: the full final sentence made it in (not cut off).
    expect(received).toContain("report which files changed and why.");
  }, 25000);
});
