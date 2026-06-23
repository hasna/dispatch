import type { Command } from "commander";
import { Store } from "../lib/store.js";
import { daemonStatus, stopDaemon } from "../daemon/control.js";
import { runDaemon, startDaemon } from "../daemon/daemon.js";
import { serviceAction, type ServiceAction } from "../daemon/service.js";

export interface DaemonCommandDeps {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Register the `daemon` command group (start | stop | status | run). */
export function registerDaemonCommands(program: Command, deps: DaemonCommandDeps): void {
  const daemon = program.command("daemon").description("Manage the dispatch daemon (scheduled-dispatch queue)");

  const cliEntry = (): string | undefined => process.argv[1];

  const startCurrentDaemon = async (): Promise<Awaited<ReturnType<typeof startDaemon>> | undefined> => {
    const entry = cliEntry();
    if (!entry) return undefined;
    return startDaemon({ cliEntry: entry });
  };

  daemon
    .command("start")
    .description("Start the daemon in the background")
    .action(async () => {
      const entry = cliEntry();
      if (!entry) {
        deps.err("cannot determine CLI entry to launch the daemon");
        process.exitCode = 1;
        return;
      }
      const res = await startDaemon({ cliEntry: entry });
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
    .command("ensure")
    .description("Idempotently ensure the daemon is running; recover stale state")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const store = new Store();
      try {
        const before = daemonStatus(store);
        if (before.health === "alive") {
          const result = { ok: true, action: "ensure", started: false, alreadyRunning: true, before, after: before };
          deps.out(opts.json ? JSON.stringify(result, null, 2) : `daemon already healthy (pid ${before.pid})`);
          return;
        }
        if (before.running || before.stale) await stopDaemon();
        const started = await startCurrentDaemon();
        if (!started) {
          deps.err("cannot determine CLI entry to launch the daemon");
          process.exitCode = 1;
          return;
        }
        const after = daemonStatus(store);
        const result = { ok: after.running, action: "ensure", started: started.started, alreadyRunning: started.alreadyRunning, before, after };
        deps.out(opts.json ? JSON.stringify(result, null, 2) : after.running ? `daemon ensured (pid ${after.pid})` : "daemon ensure failed");
        if (!after.running) process.exitCode = 1;
      } finally {
        store.close();
      }
    });

  daemon
    .command("restart")
    .description("Restart the daemon safely")
    .option("--json", "output JSON")
    .action(async (opts) => {
      const stopped = await stopDaemon();
      const started = await startCurrentDaemon();
      if (!started) {
        deps.err("cannot determine CLI entry to launch the daemon");
        process.exitCode = 1;
        return;
      }
      const result = { action: "restart", stopped, started, ok: started.started || started.alreadyRunning };
      deps.out(opts.json ? JSON.stringify(result, null, 2) : result.ok ? `daemon restarted (pid ${started.pid})` : "daemon restart failed");
      if (!result.ok) process.exitCode = 1;
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
        deps.out(`  health: ${st.health}${st.heartbeatAgeMs !== undefined ? `  heartbeat_age_ms: ${st.heartbeatAgeMs}` : ""}`);
        if (st.lastTickAt) deps.out(`  last tick: ${st.lastTickAt}`);
        if (st.nextDue) deps.out(`  next due: ${st.nextDue.id} ${st.nextDue.kind ?? "schedule"} ${st.nextDue.nextRun} ${st.nextDue.machine ?? "local"}/${st.nextDue.target}`);
        deps.out(`  scheduled: ${st.scheduled}  paused: ${st.paused}  fired: ${st.fired}  cancelled: ${st.cancelled}  failed: ${st.failed}`);
        if (st.recentFailures.length > 0) {
          deps.out("  recent failures:");
          for (const f of st.recentFailures) deps.out(`    ${f.id} ${f.lastFailureAt} ${f.lastFailureReason ?? "unknown failure"}`);
        }
        deps.out(`  dispatches recorded: ${st.recentDispatches}`);
        deps.out(`  log: ${st.logPath}`);
        deps.out(`  state: ${st.statePath}`);
      } finally {
        store.close();
      }
    });

  daemon
    .command("doctor")
    .description("Check daemon health and print small actionable diagnostics")
    .option("--json", "output JSON")
    .action((opts) => {
      const store = new Store();
      try {
        const st = daemonStatus(store);
        const findings: string[] = [];
        if (st.health === "dead") findings.push("daemon is not running; run `dispatch daemon ensure` or install the user service");
        if (st.health === "stale") findings.push("daemon health is stale; run `dispatch daemon restart`");
        if (st.scheduled > 0 && st.health !== "alive") findings.push(`${st.scheduled} scheduled item(s) cannot fire until the daemon is alive`);
        if (st.recentFailures.length > 0) findings.push(`${st.recentFailures.length} recent schedule/loop failure(s) recorded`);
        const result = { ok: findings.length === 0, status: st, findings };
        if (opts.json) {
          deps.out(JSON.stringify(result, null, 2));
        } else {
          deps.out(result.ok ? "daemon doctor: ok" : "daemon doctor: attention needed");
          for (const f of findings) deps.out(`  - ${f}`);
        }
        if (!result.ok) process.exitCode = 1;
      } finally {
        store.close();
      }
    });

  daemon
    .command("service <action>")
    .description("Manage the user-level systemd service (install|start|stop|restart|status|uninstall)")
    .option("--start", "start/restart the service after install")
    .option("--json", "output JSON")
    .action((action: ServiceAction, opts) => {
      const allowed = new Set<ServiceAction>(["install", "start", "stop", "restart", "status", "uninstall"]);
      if (!allowed.has(action)) {
        deps.err(`unknown service action: ${action}`);
        process.exitCode = 1;
        return;
      }
      const res = serviceAction(action, {
        execPath: process.execPath,
        cliEntry: cliEntry(),
        startAfterInstall: opts.start === true,
      });
      if (opts.json) {
        deps.out(JSON.stringify(res, null, 2));
      } else {
        deps.out(res.detail);
        if (res.unitPath) deps.out(`unit: ${res.unitPath}`);
        if (res.stdout?.trim()) deps.out(res.stdout.trim());
        if (res.stderr?.trim()) deps.err(res.stderr.trim());
      }
      if (!res.ok) process.exitCode = 1;
    });

  daemon
    .command("run")
    .description("Run the daemon in the foreground (used internally by `start`)")
    .option("--interval <ms>", "tick interval", (v) => parseInt(v, 10))
    .action(async (opts) => {
      await runDaemon({ intervalMs: opts.interval });
    });
}
