import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real cross-machine dispatch: send a prompt to a tmux window on ANOTHER host
 * via `--machine`, routed through @hasna/machines (Tailscale/LAN/SSH). Skips
 * cleanly (with a note) when no second host is reachable.
 */

function reachable(host: string): { ok: boolean; bun?: string; tmux?: string } {
  const res = spawnSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", host, "command -v bun; command -v tmux"],
    { encoding: "utf8", timeout: 8000 },
  );
  if (res.status !== 0) return { ok: false };
  const lines = res.stdout.trim().split("\n");
  return { ok: lines.length >= 2, bun: lines[0]?.trim(), tmux: lines[1]?.trim() };
}

const CANDIDATES = ["spark01", "apple03", "spark02"];
const localHostAliases = new Set(
  [
    "localhost",
    "127.0.0.1",
    "::1",
    hostname(),
    hostname().split(".")[0],
    process.env.HOSTNAME,
  ]
    .filter(Boolean)
    .map((name) => name!.toLowerCase()),
);
let remote: { host: string; bun: string; tmux: string } | undefined;
for (const host of CANDIDATES) {
  if (localHostAliases.has(host.toLowerCase())) continue;
  const r = reachable(host);
  if (r.ok && r.bun && r.tmux) {
    remote = { host, bun: r.bun, tmux: r.tmux };
    break;
  }
}

if (!remote) {
  // eslint-disable-next-line no-console
  console.warn("cross-machine test SKIPPED: no reachable second host with bun+tmux");
}

const d = remote ? describe : describe.skip;
const SESSION = `dispatch_xm_${process.pid}`;
const cli = join(import.meta.dir, "cli", "index.ts");
const agent = join(import.meta.dir, "test", "fake-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_xm_"));
const remoteDir = `/tmp/dispatch_agent_${process.pid}`;
const remoteAgent = `${remoteDir}/fake-agent.ts`;
const remoteLauncher = `${remoteDir}/codewith`;

function ssh(host: string, cmd: string) {
  return spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=6", host, cmd], {
    encoding: "utf8",
    timeout: 15000,
  });
}

d("cross-machine dispatch (real second host)", () => {
  beforeAll(async () => {
    const host = remote!.host;
    // Copy the fake agent over and start it in a remote tmux session.
    ssh(host, `mkdir -p ${remoteDir} && ln -sf ${remote!.bun} ${remoteLauncher}`);
    const scp = spawnSync("scp", ["-o", "BatchMode=yes", agent, `${host}:${remoteAgent}`], {
      encoding: "utf8",
      timeout: 15000,
    });
    if (scp.status !== 0) throw new Error(`scp failed: ${scp.stderr}`);
    ssh(host, `${remote!.tmux} kill-session -t ${SESSION} 2>/dev/null; ${remote!.tmux} new-session -d -s ${SESSION} -x 200 -y 50 ${remoteLauncher} run ${remoteAgent}`);
    await Bun.sleep(2000); // let the remote agent boot
  }, 30000);

  afterAll(() => {
    if (remote) {
      ssh(remote.host, `${remote.tmux} kill-session -t ${SESSION} 2>/dev/null; rm -rf ${remoteDir}`);
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  test(`delivers + confirms a dispatch to a tmux pane on ${remote?.host}`, () => {
    const send = spawnSync(
      "bun",
      [
        "run",
        cli,
        "send",
        "--to",
        SESSION,
        "--machine",
        remote!.host,
        "--prompt",
        "cross-machine hello to the remote agent",
        "--json",
      ],
      { encoding: "utf8", input: "", env: { ...process.env, DISPATCH_DATA_DIR: dataDir, DISPATCH_MAX_DELAY_MS: "300" }, timeout: 60000 },
    );
    expect(send.status).toBe(0);
    const rec = JSON.parse(send.stdout);
    expect(rec.machine).toBe(remote!.host);
    expect(rec.status).toBe("delivered");
    expect(rec.confirm.delivered).toBe(true);
  }, 70000);
});
