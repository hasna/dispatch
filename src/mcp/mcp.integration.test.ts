import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codewithFixtureLauncher } from "../test/agent-launcher.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./index.js";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const SESSION = `dispatch_mcp_it_${process.pid}`;
const agent = join(import.meta.dir, "..", "test", "fake-agent.ts");
const dataDir = mkdtempSync(join(tmpdir(), "dispatch_mcp_it_"));

const d = tmuxAvailable ? describe : describe.skip;

async function connect() {
  const store = new Store(join(dataDir, "mcp.db"));
  const server = createServer({ deps: { client: new DispatchClient({ store }), store } });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return { client, store };
}

function textOf(res: any): any {
  return JSON.parse(res.content[0].text);
}

d("MCP server (in-memory transport, real tmux)", () => {
  beforeAll(async () => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    const res = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50", codewithFixtureLauncher(dataDir), "run", agent], {
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`failed to start fake agent: ${res.stderr}`);
    await Bun.sleep(900);
  });
  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("lists all dispatch tools", async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toContain("dispatch_send");
    expect(names).toContain("dispatch_schedule");
    expect(names).toContain("dispatch_daemon_status");
    expect(names).toContain("dispatch_targets");
  });

  test("dispatch_send delivers to a real pane, then dispatch_status finds it", async () => {
    const { client } = await connect();
    const sendRes = await client.callTool({
      name: "dispatch_send",
      arguments: { target: SESSION, prompt: "mcp-driven dispatch to the agent", delayMs: 200 },
    });
    const rec = textOf(sendRes);
    expect(rec.status).toBe("delivered");
    expect(rec.confirm.delivered).toBe(true);

    const statusRes = await client.callTool({ name: "dispatch_status", arguments: { id: rec.id } });
    expect(textOf(statusRes).id).toBe(rec.id);
  }, 20000);

  test("dispatch_targets finds the live session", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "dispatch_targets", arguments: {} });
    const targets = textOf(res) as Array<{ target: string }>;
    expect(targets.some((t) => t.target.startsWith(SESSION))).toBe(true);
  }, 10000);
});
