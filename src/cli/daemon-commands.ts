import type { Command } from "commander";
import { Store } from "../lib/store.js";
import { daemonStatus, stopDaemon } from "../daemon/control.js";
import { runDaemon, startDaemon } from "../daemon/daemon.js";

export interface DaemonCommandDeps {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Register the `daemon` command group (start | stop | status | run). */
export function registerDaemonCommands(program: Command, deps: DaemonCommandDeps): void {
  const daemon = program.command("daemon").description("Manage the dispatch daemon (scheduled-dispatch queue)");

  daemon
    .command("start")
    .description("Start the daemon in the background")
    .action(async () => {
      const cliEntry = process.argv[1];
      if (!cliEntry) {
        deps.err("cannot determine CLI entry to launch the daemon");
        process.exitCode = 1;
        return;
      }
      const res = await startDaemon({ cliEntry });
      if (res.alreadyRunning) {
        deps.out(`daemon already running (pid ${res.pid})`);
      } else if (res.started) {
        deps.out(`daemon started (pid ${res.pid})`);
      } else {
        deps.err("daemon failed to start (check the log)");
        process.exitCode = 1;
      }
    });

  daemon
    .command("stop")
    .description("Stop the running daemon and wait for it to exit")
    .action(async () => {
      const res = await stopDaemon();
      if (res.stopped) {
        deps.out(`daemon stopped (pid ${res.pid})${res.forced ? " [forced]" : ""}`);
      } else if (res.pid && !res.wasRunning) {
        deps.out(`removed stale pidfile (pid ${res.pid} was not running)`);
      } else {
        deps.out("daemon is not running");
      }
    });

  daemon
    .command("status")
    .description("Show daemon + queue status")
    .option("--json", "output JSON")
    .action((opts) => {
      const store = new Store();
      try {
        const st = daemonStatus(store);
        if (opts.json) {
          deps.out(JSON.stringify(st, null, 2));
          return;
        }
        const head = st.running
          ? `daemon running (pid ${st.pid})`
          : st.stale
            ? `daemon not running (stale pidfile, pid ${st.pid})`
            : "daemon not running";
        deps.out(head);
        deps.out(`  scheduled: ${st.scheduled}  paused: ${st.paused}  fired: ${st.fired}  cancelled: ${st.cancelled}  failed: ${st.failed}`);
        deps.out(`  dispatches recorded: ${st.recentDispatches}`);
        deps.out(`  log: ${st.logPath}`);
      } finally {
        store.close();
      }
    });

  daemon
    .command("run")
    .description("Run the daemon in the foreground (used internally by `start`)")
    .option("--interval <ms>", "tick interval", (v) => parseInt(v, 10))
    .action(async (opts) => {
      await runDaemon({ intervalMs: opts.interval });
    });
}
