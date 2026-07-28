import { spawnSync } from "node:child_process";

const PROBE_SESSION = `dispatch_tmux_probe_${process.pid}`;
/** Opt out of the real-tmux suites in a sandbox that genuinely cannot host tmux. */
const SKIP_ENV = "DISPATCH_SKIP_TMUX_INTEGRATION";

/**
 * Whether the real-tmux integration suites can run here.
 *
 * Skipping is opt-in, never inferred from a failing probe: driving tmux is the
 * only thing this package does, so a tmux that answers `-V` but cannot start a
 * session is a failure rather than a reason to go green. Set the opt-out env
 * var where tmux truly cannot run; having no tmux at all still skips quietly.
 */
export function canRunTmuxIntegration(): boolean {
  if (process.env[SKIP_ENV] === "1") return false;
  if (spawnSync("tmux", ["-V"], { encoding: "utf8" }).status !== 0) return false;

  spawnSync("tmux", ["kill-session", "-t", PROBE_SESSION], { encoding: "utf8" });
  const started = spawnSync("tmux", ["new-session", "-d", "-s", PROBE_SESSION, "-x", "80", "-y", "24"], {
    encoding: "utf8",
  });
  if (started.status !== 0) {
    const detail = started.stderr?.trim() || started.error?.message || `exit ${started.status ?? "signal"}`;
    throw new Error(
      `tmux is installed but cannot start a session: ${detail}. ` +
        `Repair the tmux environment, or set ${SKIP_ENV}=1 to skip the real-tmux integration suites.`,
    );
  }

  spawnSync("tmux", ["kill-session", "-t", PROBE_SESSION], { encoding: "utf8" });
  return true;
}
