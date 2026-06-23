import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codewithFixtureLauncher } from "../test/agent-launcher.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const SESSION = `dispatch_daemon_it_${process.pid}`;
const cli = join(import.meta.dir, "..", "cli", "index.ts");
const agent = join(import.meta.dir, "..", "test", "fake-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_daemon_it_"));

const d = tmuxAvailable ? describe : describe.skip;

const env = {
  ...process.env,
  DISPATCH_DATA_DIR: dataDir,
  DISPATCH_MAX_DELAY_MS: "300",
  DISPATCH_DAEMON_INTERVAL_MS: "400",
};

function runCli(args: string[]) {
  return spawnSync("bun", ["run", cli, ...args], { encoding: "utf8", input: "", env });
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

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

d("dispatch daemon (real tmux + fake agent)", () => {
  beforeEach(async () => {
    await startAgent();
  });
  afterEach(() => {
    runCli(["daemon", "stop"]);
  });
  afterAll(() => {
    runCli(["daemon", "stop"]);
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("start -> status reports running; stop reports stopped", () => {
    const start = runCli(["daemon", "start"]);
    expect(start.status).toBe(0);
    expect(start.stdout).toMatch(/started|already running/);

    const status = JSON.parse(runCli(["daemon", "status", "--json"]).stdout);
    expect(status.running).toBe(true);
    expect(typeof status.pid).toBe("number");

    const stop = runCli(["daemon", "stop"]);
    expect(stop.stdout).toMatch(/stopped/);
    expect(JSON.parse(runCli(["daemon", "status", "--json"]).stdout).running).toBe(false);
  });

  test("ensure is idempotent and restart brings the daemon back healthy", () => {
    const ensure = runCli(["daemon", "ensure", "--json"]);
    expect(ensure.status).toBe(0);
    let status = JSON.parse(runCli(["daemon", "status", "--json"]).stdout);
    expect(status.running).toBe(true);
    expect(status.health).toBe("alive");

    const ensureAgain = JSON.parse(runCli(["daemon", "ensure", "--json"]).stdout);
    expect(ensureAgain.alreadyRunning).toBe(true);

    const restart = runCli(["daemon", "restart", "--json"]);
    expect(restart.status).toBe(0);
    status = JSON.parse(runCli(["daemon", "status", "--json"]).stdout);
    expect(status.running).toBe(true);
    expect(status.health).toBe("alive");
    expect(status.lastTickAt || status.lastTickStartedAt).toBeDefined();
  }, 30000);

  test("a relative scheduled dispatch fires and is delivered to the pane", async () => {
    runCli(["daemon", "start"]);
    const sched = JSON.parse(
      runCli(["schedule", "--to", SESSION, "--prompt", "scheduled hello to the agent", "--in", "1500ms", "--json"])
        .stdout,
    );
    expect(sched.status).toBe("scheduled");
    expect(sched.at).toBeDefined();

    // Wait past the fire time + a tick + full delivery (generous for load).
    await Bun.sleep(12000);

    const schedules = JSON.parse(runCli(["schedules", "--json"]).stdout);
    expect(schedules.find((s: any) => s.id === sched.id).status).toBe("fired");

    const dispatches = JSON.parse(runCli(["list", "--json"]).stdout);
    const fired = dispatches.find((r: any) => r.prompt.includes("scheduled hello"));
    expect(fired).toBeDefined();
    expect(fired.status).toBe("delivered");
    expect(fired.confirm.delivered).toBe(true);
  }, 30000);

  test("an interval loop fires and remains scheduled for its next run", async () => {
    runCli(["daemon", "start"]);
    const loop = JSON.parse(
      runCli(["loop", "--to", SESSION, "--prompt", "loop hello to the agent", "--every", "2s", "--name", "it-loop", "--json"])
        .stdout,
    );
    expect(loop).toMatchObject({ status: "scheduled", kind: "loop", name: "it-loop", every: "2s" });

    await Bun.sleep(9000);

    const loops = JSON.parse(runCli(["loops", "--json"]).stdout);
    const after = loops.find((s: any) => s.id === loop.id);
    expect(after).toBeDefined();
    expect(after.status).toBe("scheduled");
    expect(after.lastDispatchId).toBeDefined();

    const dispatches = JSON.parse(runCli(["list", "--json"]).stdout);
    expect(dispatches.some((r: any) => r.prompt.includes("loop hello"))).toBe(true);
    expect(runCli(["clear", loop.id]).status).toBe(0);
  }, 30000);

  test("scheduled dispatch survives a daemon restart (persisted queue)", async () => {
    // Schedule ~3.5s out, then stop the daemon before it can fire.
    runCli(["daemon", "start"]);
    const sched = JSON.parse(
      runCli(["schedule", "--to", SESSION, "--prompt", "survives restart marker", "--at", isoIn(3500), "--json"])
        .stdout,
    );
    await Bun.sleep(600);
    runCli(["daemon", "stop"]);
    await Bun.sleep(400);

    // The schedule is still pending (not yet fired) and persisted on disk.
    let after = JSON.parse(runCli(["schedules", "--json"]).stdout).find((s: any) => s.id === sched.id);
    expect(after.status).toBe("scheduled");

    // Restart a fresh daemon process; it must pick up the persisted schedule
    // (which fires ~3.5s after creation) and deliver it.
    runCli(["daemon", "start"]);
    await Bun.sleep(14000);

    after = JSON.parse(runCli(["schedules", "--json"]).stdout).find((s: any) => s.id === sched.id);
    expect(after.status).toBe("fired");
    const fired = JSON.parse(runCli(["list", "--json"]).stdout).find((r: any) =>
      r.prompt.includes("survives restart marker"),
    );
    expect(fired).toBeDefined();
    expect(fired.status).toBe("delivered");
  }, 35000);
});
