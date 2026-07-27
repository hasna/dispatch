import { spawnSync } from "node:child_process";

const PROBE_SESSION = `dispatch_tmux_probe_${process.pid}`;

export function canRunTmuxIntegration(): boolean {
  if (spawnSync("tmux", ["-V"], { encoding: "utf8" }).status !== 0) return false;

  spawnSync("tmux", ["kill-session", "-t", PROBE_SESSION], { encoding: "utf8" });
  const started = spawnSync("tmux", ["new-session", "-d", "-s", PROBE_SESSION, "-x", "80", "-y", "24"], {
    encoding: "utf8",
  });
  if (started.status !== 0) return false;

  spawnSync("tmux", ["kill-session", "-t", PROBE_SESSION], { encoding: "utf8" });
  return true;
}
