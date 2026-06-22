import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunner } from "./runner.js";
import { Tmux } from "./tmux.js";
import { confirmDelivery, evaluateDelivery } from "./confirm.js";
import { codewithFixtureLauncher } from "../test/agent-launcher.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const SESSION = `dispatch_confirm_${process.pid}`;
const TARGET = SESSION;
const tmux = new Tmux(new LocalRunner());
const agent = join(import.meta.dir, "..", "test", "fake-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_confirm_data_"));

const d = tmuxAvailable ? describe : describe.skip;

async function settle(ms = 400): Promise<void> {
  await Bun.sleep(ms);
}

d("delivery confirmation against a real tmux pane", () => {
  beforeEach(async () => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    const res = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", codewithFixtureLauncher(dataDir), "run", agent], {
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`failed to start fake agent: ${res.stderr}`);
    await settle(800); // let the agent boot and render
  });
  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("confirms delivery when the agent enters the working state", async () => {
    const before = tmux.capturePane(TARGET);
    expect(before).toContain("idle");

    tmux.paste(TARGET, "Please refactor the parser and add tests", { bracketed: true });
    tmux.sendKey(TARGET, "Enter");

    const result = await confirmDelivery(tmux, TARGET, {
      before,
      prompt: "Please refactor the parser and add tests",
      waitMs: 400,
      maxPolls: 6,
    });
    expect(result.delivered).toBe(true);
    expect(result.workingDetected).toBe(true);
  }, 20000);

  test("reports not-delivered when nothing is submitted", async () => {
    const before = tmux.capturePane(TARGET);
    // Type into the composer but never press Enter.
    tmux.paste(TARGET, "an unsent prompt tail marker", { bracketed: true });
    await settle(500);
    const after = tmux.capturePane(TARGET);
    const result = evaluateDelivery({
      before,
      after,
      afterTyped: after,
      prompt: "an unsent prompt tail marker",
    });
    expect(result.workingDetected).toBe(false);
  }, 20000);
});
