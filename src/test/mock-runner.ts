import type { RunResult, Runner } from "../lib/runner.js";

export interface RecordedCall {
  argv: string[];
  input?: string;
}

export type Responder = (argv: string[], input?: string) => RunResult;

/**
 * A Runner that records every call and returns canned results, for unit tests.
 * Provide a `responder` for dynamic behavior, or push results onto `queue`.
 */
export class MockRunner implements Runner {
  readonly machine: string;
  readonly calls: RecordedCall[] = [];
  responder?: Responder;
  queue: Partial<RunResult>[] = [];
  defaultResult: RunResult = { stdout: "", stderr: "", exitCode: 0, source: "local" };

  constructor(machine = "local") {
    this.machine = machine;
  }

  run(argv: string[], input?: string): RunResult {
    this.calls.push({ argv, input });
    if (this.responder) return this.responder(argv, input);
    const next = this.queue.shift();
    if (next) return { ...this.defaultResult, ...next };
    return { ...this.defaultResult };
  }

  /** The argv of the last recorded call. */
  lastArgv(): string[] {
    return this.calls[this.calls.length - 1]?.argv ?? [];
  }

  /** All recorded argvs. */
  argvs(): string[][] {
    return this.calls.map((c) => c.argv);
  }
}
