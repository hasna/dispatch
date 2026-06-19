import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression coverage for the confirmation false-negatives reported from
 * spark01: a busy agent that queues the prompt, and a raw shell that echoes the
 * command into scrollback. Both used to be reported "failed" despite the prompt
 * being delivered/executed. These drive the real CLI against real tmux panes.
 */

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const cli = join(import.meta.dir, "cli", "index.ts");
const busyAgent = join(import.meta.dir, "test", "busy-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_confirm_reg_"));
const SESSION = `dispatch_reg_${process.pid}`;

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
  afterEach(killSession);
  afterAll(() => {
    killSession();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("raw shell: dispatching a command that executes is reported delivered (not failed)", async () => {
    const res = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50"], {
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`failed to start shell session: ${res.stderr}`);
    await Bun.sleep(700);

    const marker = `DISPATCH_REG_SHELL_${process.pid}`;
    const send = runCli(["send", "--to", SESSION, "--prompt", `echo ${marker}`, "--json"]);
    expect(send.status).toBe(0);
    const rec = JSON.parse(send.stdout);
    expect(rec.status).toBe("delivered");

    // The command actually executed in the pane.
    await Bun.sleep(300);
    const pane = spawnSync("tmux", ["capture-pane", "-t", SESSION, "-p"], { encoding: "utf8" }).stdout;
    expect(pane).toContain(marker);
  }, 20000);

  test("busy agent that queues the message is reported delivered + queued (not failed)", async () => {
    const res = spawnSync(
      "tmux",
      ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", "bun", "run", busyAgent],
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
});
