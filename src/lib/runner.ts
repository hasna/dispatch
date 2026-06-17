import { spawnSync } from "node:child_process";

/** Result of running a command. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Where the command ran: local, or the remote route used. */
  source: "local" | "lan" | "tailscale" | "ssh";
}

/**
 * A Runner executes a command (given as an argv array) and returns its result.
 * Optional `input` is piped to the command's stdin (used for `tmux load-buffer -`).
 *
 * The argv abstraction (rather than a shell string) keeps tmux text payloads
 * safe from shell quoting; remote runners are responsible for safely quoting
 * argv into a single shell command for transport over SSH.
 */
export interface Runner {
  run(argv: string[], input?: string): RunResult;
  /** Machine id this runner targets ("local" for the local host). */
  readonly machine: string;
}

/** POSIX single-quote a value for safe embedding in a shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Quote an argv array into a single shell command string. */
export function quoteArgv(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** Runs commands on the local host via spawnSync. */
export class LocalRunner implements Runner {
  readonly machine = "local";

  run(argv: string[], input?: string): RunResult {
    const [cmd, ...args] = argv;
    if (!cmd) throw new Error("LocalRunner.run: empty argv");
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      input,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      return { stdout: "", stderr: String(result.error.message ?? result.error), exitCode: 127, source: "local" };
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
      source: "local",
    };
  }
}

/**
 * Runs commands on a remote machine via @hasna/machines (`resolveMachineCommand`),
 * falling back to a plain `ssh <machine>` when the package or a route is absent.
 *
 * Construct via {@link createRemoteRunner} so the optional dependency can be
 * dynamically imported.
 */
export class RemoteRunner implements Runner {
  constructor(
    readonly machine: string,
    private readonly resolve: (machineId: string, command: string) => { source: RunResult["source"]; shellCommand: string },
  ) {}

  run(argv: string[], input?: string): RunResult {
    const command = quoteArgv(argv);
    const resolved = this.resolve(this.machine, command);
    const result = spawnSync("bash", ["-c", resolved.shellCommand], {
      encoding: "utf8",
      input,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      return { stdout: "", stderr: String(result.error.message ?? result.error), exitCode: 127, source: resolved.source };
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
      source: resolved.source,
    };
  }
}

/** True when a machine id refers to the local host. */
export function isLocalMachine(machine: string | undefined): boolean {
  if (!machine) return true;
  const m = machine.toLowerCase();
  return m === "local" || m === "localhost" || m === (process.env.HOSTNAME ?? "").toLowerCase();
}

/**
 * Build a Runner for the given machine. Local machines get a {@link LocalRunner};
 * remote machines load `@hasna/machines/consumer` dynamically for route
 * resolution and fall back to plain `ssh <machine> <cmd>` if unavailable.
 */
export async function createRunner(machine?: string): Promise<Runner> {
  if (isLocalMachine(machine)) return new LocalRunner();
  const machineId = machine as string;
  try {
    const mod = (await import("@hasna/machines/consumer")) as {
      resolveMachineCommand: (id: string, command: string) => { source: RunResult["source"]; shellCommand: string };
    };
    return new RemoteRunner(machineId, mod.resolveMachineCommand);
  } catch {
    // Fallback: plain ssh, no route resolution.
    return new RemoteRunner(machineId, (id, command) => ({
      source: "ssh",
      shellCommand: `ssh ${shellQuote(id)} ${shellQuote(command)}`,
    }));
  }
}
