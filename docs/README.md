# Dispatch documentation

Start with the page that matches the surface you use:

- [CLI reference](cli.md) — every command, command group, important option, and output/exit behavior.
- [SDK and MCP reference](sdk-mcp.md) — `DispatchClient`, API-routed clients, all MCP tools, and compact responses.
- [Scheduling and daemon](scheduling.md) — timing, retries, queue ownership, health, and systemd service actions.
- [Architecture](architecture.md) — layers, backends, runner routing, client authority selection, and state.
- [Reliable delivery](reliability.md) — delivery, settle, submit retries, and confirmation.
- [Cross-machine dispatch](cross-machine.md) — `@hasna/machines`, SSH fallback, requirements, and scheduling.
- [Self-healing runbook](self-healing.md) — bounded diagnosis and safe repair routing.
- [`/v1` authority contract](api-v1.md) — endpoints and response schemas for API mode.

The root [README](../README.md) is the installation guide and feature overview.
Runtime help is the authoritative CLI syntax; [cli.md](cli.md) explains behavior
and relationships that do not fit in help output.

Contributions are PR-first. Follow [AGENTS.md](../AGENTS.md): write tests first
for behavior changes, use conventional commits without `Co-Authored-By`, scan
staged files for secrets, and use patch version bumps only.
