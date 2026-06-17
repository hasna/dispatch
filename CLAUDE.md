# CLAUDE.md

This repository's contributor guide lives in **[AGENTS.md](AGENTS.md)** — stack, layout,
the Runner abstraction, TDD/parity conventions, build commands, and tmux gotchas.

Quick reference:

```bash
bun install
bun test           # unit + real-tmux integration
bun run typecheck
bun run build
```

Deeper docs are in [docs/](docs/): architecture, reliability (auto-submit / bracketed
paste / delivery confirmation), and cross-machine dispatch.
