# GOAL — Build & ship `open-dispatch` (`@hasna/dispatch`)

You are the autonomous builder for **open-dispatch**, an open-source tool that lets agents (and
humans) **dispatch prompts/messages to coding agents running in tmux windows** — locally and across
machines — reliably. Repo: GitHub **hasna/dispatch** (public OSS), npm **`@hasna/dispatch`**, folder
`~/workspace/hasna/opensource/open-dispatch`. **Drive this to DONE — do not stop until it is live
(published + working), with every "Done when" box verified.**

## Why this exists
We constantly drive coding agents (Claude Code, Codex/codewith, etc.) running in tmux windows by
`tmux send-keys`. Doing it by hand is unreliable: the Enter often doesn't submit (text sits in the
composer), long prompts get mangled, there's no delivery confirmation, and it doesn't work across
machines. `open-dispatch` makes this a first-class, reliable tool.

## Orient first
- Study sibling repos for structure/conventions (Bun+TS, CLI + MCP + daemon/server + SDK, tests,
  docs, packaging): **`~/workspace/hasna/opensource/open-todos`** (CLI+MCP+SDK+dashboard layout,
  AGENTS.md/CLAUDE.md, scripts, publishing) and others under `~/workspace/hasna/opensource/open-*`.
- Integrate cross-machine via the **open-machines SDK (`@hasna/machines`)** at
  `~/workspace/hasna/opensource/open-machines` — read its README/SDK to learn how to enumerate/reach
  machines (LAN/Tailscale/MagicDNS) so a dispatch can target a tmux window on another host.
- Follow `~/.claude/rules/` (TDD, secrets scan before every commit/push, conventional commits, NO
  Co-Authored-By, patch-version bumps, Bun over npm, **use the `projects` CLI for repo create/publish**).

## Core features (build all)
1. **Dispatch to a tmux target.** `dispatch send --to <session:window> --prompt "..."` (and `--file`
   for long prompts). Types the prompt into the target pane and submits it.
2. **Reliable auto-submit (THE key feature).** Solve the flaky-Enter problem: after typing/pasting the
   prompt, **auto-calculate a delay from the prompt's word/char count** (longer text → longer wait) so
   the full text is registered by the target TUI *before* pressing Enter, then press Enter — and if it
   didn't submit, retry Enter. Make submission deterministic regardless of prompt length.
3. **Long prompts.** Handle large multi-line prompts without corruption (prefer paste/bracketed-paste
   or chunked send; avoid newline-triggered premature submits).
4. **Delivery confirmation (smart).** After dispatching, **verify it was actually received/submitted**
   — capture the target pane before/after, detect that the agent started processing (e.g. the TUI
   footer changed to a "working/esc-to-interrupt" state and the composer cleared), and return a clear
   delivered/not-delivered status (with a reason). Expose `dispatch status <id>`.
5. **Cross-machine.** Using `@hasna/machines`, dispatch to a tmux window on **another machine**
   (`dispatch send --machine spark01 --to <session:window> ...`) over SSH/Tailscale; sync machine
   inventory via the open-machines SDK. Works for the 5 machines (spark01/02, apple01/03/06).
6. **Scheduled dispatches.** `dispatch schedule --at <time>|--cron <expr> --to ... --prompt ...` —
   queue a dispatch to fire later; list/cancel scheduled dispatches.
7. **Live daemon.** A background daemon that owns the dispatch queue, scheduled dispatches,
   cross-machine routing, and delivery tracking (`dispatch daemon start|stop|status`). Persist state
   (so scheduled dispatches survive restarts).
8. **Surfaces (mirror open-todos):** a first-class **CLI**, an **MCP server** (every verb as a tool so
   agents dispatch via MCP), an **SDK** (`@hasna/dispatch` programmatic API), and the daemon.

## Engineering
- **Bun + TypeScript.** TDD throughout — tests first, full suite green, nothing skipped.
- Model package layout, scripts, MCP/CLI parity, and publishing on `open-todos`.
- Secrets: never hardcode; scan staged files before every commit/push.

## Publish & go live
- Create the GitHub repo via the **`projects` CLI** (`projects workspaces import <path>` then
  `projects workspaces publish`, or `import-github`) → **hasna/dispatch (public)**. Register in todos.
- Publish **`@hasna/dispatch`** to npm (public access, patch version). `bun install -g @hasna/dispatch`
  and verify the CLI works.
- Use `/skill-goal-execute` (`/gosl`): create a todos plan under the open-dispatch project and execute
  tasks one by one, verifying each. Keep todos + the conversations space updated.

## Done when (all verified, not assumed)
- [x] `bun run build` clean; full `bun test` green (nothing skipped). — 140 tests pass across 23 files.
- [x] `dispatch send` reliably delivers a prompt to a tmux window AND auto-submits it, **verified with
      a long multi-paragraph prompt** (no premature submit, no mangling), with delivery confirmed. —
      `src/e2e.integration.test.ts` records a 5-paragraph prompt byte-for-byte off a real pane; verified
      again against the built `dist` CLI.
- [x] Delivery-confirmation reports delivered/not-delivered correctly (test against a real tmux pane). —
      `src/lib/confirm.integration.test.ts` (working-state detected vs unsent prompt).
- [x] Scheduled dispatch fires at the scheduled time; daemon runs and survives restart. —
      `src/daemon/daemon.integration.test.ts` (fires + delivers; schedule survives a full daemon restart).
- [x] Cross-machine dispatch works. — `src/cross-machine.integration.test.ts` dispatches to a tmux pane
      on **spark01** over Tailscale via `@hasna/machines`; delivered + confirmed.
- [x] Published: `npm view @hasna/dispatch` shows `0.0.1`; installs + runs (verified on spark02 + apple03).
      GitHub **hasna/dispatch** is public (default branch `main`).
- [x] todos plan complete; final summary posted to the conversations space.
