#!/usr/bin/env bun
/**
 * @hasna/dispatch daemon entrypoint. Owns the scheduled-dispatch queue and
 * fires due dispatches on an interval. Usually launched via
 * `dispatch daemon start`; can also be run directly as `dispatch-daemon`.
 */
import { runDaemon } from "./daemon.js";

function intervalFromEnv(): number | undefined {
  const raw = process.env.DISPATCH_DAEMON_INTERVAL_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

if (import.meta.main) {
  runDaemon({ intervalMs: intervalFromEnv() }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { runDaemon, startDaemon } from "./daemon.js";
