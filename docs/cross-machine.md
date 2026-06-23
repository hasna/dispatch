# Cross-machine dispatch

`dispatch` can deliver a prompt to a tmux window on **another machine** — the same
delivery/auto-submit/confirmation logic, just executed over SSH.

```bash
dispatch send --machine spark01 --to work:agent --prompt "build it"
dispatch targets --machine spark01            # discover panes on the remote host
```

## How it routes

The `Runner` abstraction is the only thing that changes between local and remote:

- **Local** (`--machine` omitted, `local`, `localhost`, or this hostname) → `LocalRunner`
  runs tmux via `spawnSync`.
- **Remote** → `RemoteRunner` quotes the tmux argv into a single shell command and resolves
  how to reach the host through the optional [`@hasna/machines`](https://github.com/hasna/machines)
  consumer SDK:

  ```ts
  import { resolveMachineCommand } from "@hasna/machines/consumer";
  resolveMachineCommand("spark01", "tmux send-keys ...");
  // → { source: "tailscale", shellCommand: "ssh spark01.<tailnet>.ts.net 'tmux send-keys ...'" }
  ```

  It picks the best live route (LAN address or Tailscale MagicDNS name), so it keeps
  working even when DHCP rotates an IP. If `@hasna/machines` isn't installed, `dispatch`
  falls back to plain `ssh <machine> '<cmd>'` (resolved by your SSH config / DNS).

Because tmux text payloads travel as a properly-quoted single argument and large prompts
are piped via stdin (`load-buffer -`), long and multi-line prompts cross the SSH boundary
without corruption — bracketed paste still applies on the remote pane.

Remote commands default to a 20s timeout because real tmux operations over SSH/Tailscale
can take several seconds during route setup. Override it with
`DISPATCH_REMOTE_TIMEOUT_MS=<ms>` when you need faster failure behavior, especially for
bulk runs against machines that may be down.

## Requirements

- Passwordless SSH to the target host (key/agent), reachable over LAN or Tailscale.
- `tmux` installed on the target host.
- For Tailscale/LAN route resolution: `@hasna/machines` available (optional dependency).
  Without it, name resolution falls to your SSH config.

## Scheduling + cross-machine

A scheduled dispatch carries its `machine`, so the daemon fires cross-machine dispatches
too:

```bash
dispatch schedule --machine spark01 --to work:agent --prompt "nightly" --cron "0 2 * * *"
```
