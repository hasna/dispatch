import { homedir } from "node:os";
import { join } from "node:path";

/** Root data directory for @hasna/dispatch state. */
export function dataDir(): string {
  return process.env.DISPATCH_DATA_DIR || join(homedir(), ".hasna", "dispatch");
}

/** Path to the sqlite database file. */
export function dbPath(): string {
  return join(dataDir(), "dispatch.db");
}

/** Path to the daemon pid file. */
export function pidFilePath(): string {
  return join(dataDir(), "daemon.pid");
}

/** Path to the daemon log file. */
export function daemonLogPath(): string {
  return join(dataDir(), "daemon.log");
}
