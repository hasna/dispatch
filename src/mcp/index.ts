#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPackageVersion } from "../lib/version.js";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";
import { TOOLS, type ToolDeps } from "./tools.js";

export interface CreateServerOptions {
  /** Inject deps (tests). When omitted, a default store + client are created. */
  deps?: ToolDeps;
}

/**
 * Build the MCP server with every dispatch verb exposed as a tool, so agents can
 * dispatch, schedule, and manage the daemon over MCP — full parity with the CLI.
 */
export function createServer(opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: "dispatch", version: getPackageVersion() });

  let deps = opts.deps;
  const resolveDeps = (): ToolDeps => {
    if (deps) return deps;
    const store = new Store();
    deps = { client: new DispatchClient({ store }), store };
    return deps;
  };

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(resolveDeps(), args ?? {});
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { TOOLS } from "./tools.js";
