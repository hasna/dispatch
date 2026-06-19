import { describe, expect, test } from "bun:test";
import {
  fallbackSshCommand,
  LocalRunner,
  RemoteRunner,
  createRunner,
  isLocalMachine,
  quoteArgv,
  shellQuote,
} from "./runner.js";

describe("isLocalMachine", () => {
  test("undefined / local / localhost are local", () => {
    expect(isLocalMachine(undefined)).toBe(true);
    expect(isLocalMachine("local")).toBe(true);
    expect(isLocalMachine("localhost")).toBe(true);
    expect(isLocalMachine("LOCAL")).toBe(true);
  });
  test("a named machine is not local", () => {
    expect(isLocalMachine("spark01")).toBe(false);
  });
});

describe("shell quoting", () => {
  test("shellQuote wraps and escapes single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  test("quoteArgv joins safely so remote shells see one command per arg", () => {
    expect(quoteArgv(["tmux", "send-keys", "-t", "s:w", "-l", "--", "a b; rm -rf /"])).toBe(
      "'tmux' 'send-keys' '-t' 's:w' '-l' '--' 'a b; rm -rf /'",
    );
  });
});

describe("LocalRunner", () => {
  test("runs a command locally and captures stdout/exit", () => {
    const r = new LocalRunner();
    const res = r.run(["echo", "hi-there"]);
    expect(res.exitCode).toBe(0);
    expect(res.source).toBe("local");
    expect(res.stdout.trim()).toBe("hi-there");
  });
  test("pipes input to stdin", () => {
    const r = new LocalRunner();
    const res = r.run(["cat"], "piped-content");
    expect(res.stdout).toBe("piped-content");
  });
});

describe("RemoteRunner", () => {
  test("wraps argv through the resolver and executes the resolved shell command", () => {
    // Stub the resolver so we exercise the wiring without real ssh.
    const calls: string[] = [];
    const r = new RemoteRunner("box", (machineId, command) => {
      calls.push(`${machineId}:${command}`);
      return { source: "ssh", shellCommand: `echo resolved-for-${machineId}` };
    });
    const res = r.run(["tmux", "send-keys", "-t", "s:w", "-l", "--", "hi"]);
    expect(res.exitCode).toBe(0);
    expect(res.source).toBe("ssh");
    expect(res.stdout.trim()).toBe("resolved-for-box");
    // the resolver received the fully-quoted argv
    expect(calls[0]).toBe("box:'tmux' 'send-keys' '-t' 's:w' '-l' '--' 'hi'");
  });

  test("bounds remote commands with a timeout", () => {
    const start = Date.now();
    const r = new RemoteRunner("box", () => ({ source: "ssh", shellCommand: "sleep 5" }), 50);
    const res = r.run(["tmux", "list-sessions"]);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(res.exitCode).toBe(124);
    expect(res.stderr).toMatch(/timed out/i);
  });

  test("fallback ssh command is noninteractive and bounded", () => {
    const command = fallbackSshCommand("box", "tmux list-sessions");
    expect(command).toContain("BatchMode=yes");
    expect(command).toContain("ConnectTimeout=5");
    expect(command).toContain("ServerAliveInterval=5");
    expect(command).toContain("'box'");
  });
});

describe("createRunner", () => {
  test("returns a LocalRunner for local machines", async () => {
    const r = await createRunner(undefined);
    expect(r).toBeInstanceOf(LocalRunner);
    expect(r.machine).toBe("local");
  });
  test("returns a RemoteRunner for a named machine", async () => {
    const r = await createRunner("some-remote-box");
    expect(r).toBeInstanceOf(RemoteRunner);
    expect(r.machine).toBe("some-remote-box");
  });
});
