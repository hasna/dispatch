import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codewithFixtureLauncher } from "./test/agent-launcher.js";

/**
 * Regression coverage for the confirmation false-negatives reported from
 * spark01: a busy agent that queues the prompt, and raw shell command delivery.
 * These drive the real CLI against real tmux panes.
 */

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const cli = join(import.meta.dir, "cli", "index.ts");
const busyAgent = join(import.meta.dir, "test", "busy-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_confirm_reg_"));
const SESSION = `dispatch_reg_${process.pid}`;
const policyFile = join(dataDir, "exec-policy.json");

const d = tmuxAvailable ? describe : describe.skip;

function runCli(args: string[]) {
  return spawnSync("bun", ["run", cli, ...args], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, DISPATCH_DATA_DIR: dataDir, DISPATCH_MAX_DELAY_MS: "400" },
  });
}

function killSession() {
  spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
}

d("confirmation regressions (real tmux)", () => {
  beforeEach(() => {
    writeFileSync(policyFile, JSON.stringify({ allowTargets: [`${SESSION}*`] }));
  });
  afterEach(killSession);
  afterAll(() => {
    killSession();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("raw shell: dispatch exec reports an executed shell command delivered", async () => {
    const res = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50"], {
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`failed to start shell session: ${res.stderr}`);
    await Bun.sleep(700);

    const send = runCli(["exec", "--to", SESSION, "--command", "pwd", "--allow", policyFile, "--json"]);
    expect(send.status).toBe(0);
    const rec = JSON.parse(send.stdout);
    expect(rec.kind).toBe("exec");
    expect(rec.status).toBe("delivered");

    // The command actually executed in the pane.
    await Bun.sleep(300);
    const pane = spawnSync("tmux", ["capture-pane", "-t", SESSION, "-p"], { encoding: "utf8" }).stdout;
    expect(pane).toContain("open-dispatch");
  }, 20000);

  test("busy agent that queues the message is reported delivered + queued (not failed)", async () => {
    const res = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", codewithFixtureLauncher(dataDir), "run", busyAgent],
      { encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`failed to start busy agent: ${res.stderr}`);
    await Bun.sleep(900);

    const send = runCli(["send", "--to", SESSION, "--prompt", "apply the lease-loss fix now", "--json"]);
    expect(send.status).toBe(0);
    const rec = JSON.parse(send.stdout);
    expect(rec.status).toBe("delivered");
    expect(rec.confirm.delivered).toBe(true);
    expect(rec.confirm.queued).toBe(true);

    // The pane shows the staged message.
    const pane = spawnSync("tmux", ["capture-pane", "-t", SESSION, "-p"], { encoding: "utf8" }).stdout;
    expect(pane).toMatch(/to be submitted after next tool call/i);
  }, 20000);

  test("pane scrolled into copy-mode: dispatch exits the mode and still lands", async () => {
    const res = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "120", "-y", "30"], {
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`failed to start shell session: ${res.stderr}`);
    await Bun.sleep(700);
    // Generate scrollback and scroll up into copy-mode (keys would be swallowed).
    spawnSync("tmux", ["send-keys", "-t", SESSION, "seq 1 200", "Enter"], { encoding: "utf8" });
    await Bun.sleep(300);
    spawnSync("tmux", ["copy-mode", "-t", SESSION], { encoding: "utf8" });
    spawnSync("tmux", ["send-keys", "-t", SESSION, "-X", "history-top"], { encoding: "utf8" });
    expect(spawnSync("tmux", ["display-message", "-p", "-t", SESSION, "#{pane_in_mode}"], { encoding: "utf8" }).stdout.trim()).toBe("1");

    const send = runCli(["exec", "--to", SESSION, "--command", "pwd", "--allow", policyFile, "--json"]);
    expect(send.status).toBe(0);
    expect(JSON.parse(send.stdout).status).toBe("delivered");

    await Bun.sleep(300);
    // Mode exited and the command executed.
    expect(spawnSync("tmux", ["display-message", "-p", "-t", SESSION, "#{pane_in_mode}"], { encoding: "utf8" }).stdout.trim()).toBe("0");
    const pane = spawnSync("tmux", ["capture-pane", "-t", SESSION, "-p"], { encoding: "utf8" }).stdout;
    expect(pane).toContain("open-dispatch");
  }, 20000);
});
