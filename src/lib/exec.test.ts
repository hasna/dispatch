import { describe, expect, test } from "bun:test";
import { performExec } from "./exec.js";
import { Tmux } from "./tmux.js";
import { Store } from "./store.js";
import { MockRunner } from "../test/mock-runner.js";

const noSleep = async () => {};

function shellRunner(currentCommand = "bash"): MockRunner {
  const r = new MockRunner();
  r.responder = (argv) => {
    if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
      return { stdout: `${currentCommand}\n`, stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_in_mode}") {
      return { stdout: "0\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "capture-pane") return { stdout: "$ ", stderr: "", exitCode: 0, source: "local" };
    return { stdout: "", stderr: "", exitCode: 0, source: "local" };
  };
  return r;
}

describe("performExec", () => {
  test("dry-run records the exact paste plan without sending tmux input", async () => {
    const r = shellRunner();
    const store = new Store(":memory:");
    const rec = await performExec(
      { target: "open-mailery:01", command: "mailery status", dryRun: true },
      { tmux: new Tmux(r), store, sleep: noSleep },
    );

    expect(rec.kind).toBe("exec");
    expect(rec.status).toBe("skipped");
    expect(rec.dryRun).toBe(true);
    expect(rec.commandHash).toMatch(/^[a-f0-9]{16}$/);
    expect(rec.filter?.allowed).toBe(true);
    expect(rec.execPlan).toEqual({ interrupt: false, pasteText: "mailery status", submitKey: "Enter" });
    expect(r.argvs().some((a) => a[1] === "load-buffer" || a[1] === "paste-buffer")).toBe(false);
    store.close();
  });

  test("pastes via tmux buffer and presses Enter without C-c by default", async () => {
    const r = shellRunner();
    const rec = await performExec(
      { target: "open-mailery:01", command: "mailery status", policy: { allowTargets: ["open-mailery:*"] } },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("delivered");
    const argvs = r.argvs();
    expect(argvs.some((a) => a[1] === "load-buffer")).toBe(true);
    expect(argvs.some((a) => a[1] === "paste-buffer" && a.includes("-p"))).toBe(true);
    expect(argvs.some((a) => a[1] === "send-keys" && a.includes("Enter"))).toBe(true);
    expect(argvs.some((a) => a[1] === "send-keys" && a.includes("C-c"))).toBe(false);
  });

  test("sends C-c only when forceInterrupt is explicitly set", async () => {
    const r = shellRunner();
    const rec = await performExec(
      {
        target: "open-mailery:01",
        command: "mailery status",
        forceInterrupt: true,
        policy: { allowTargets: ["open-mailery:*"] },
      },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("delivered");
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("C-c"))).toBe(true);
  });

  test("skips blocked commands before delivery", async () => {
    const r = shellRunner();
    const rec = await performExec(
      { target: "work:shell", command: "rm -rf /" },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("skipped");
    expect(rec.filter?.allowed).toBe(false);
    expect(rec.detail).toMatch(/destructive/i);
    expect(r.argvs().some((a) => a[1] === "load-buffer" || a[1] === "paste-buffer")).toBe(false);
  });

  test("skips non-dry-run exec without explicit target opt-in", async () => {
    const r = shellRunner();
    const rec = await performExec(
      { target: "open-mailery:01", command: "mailery status" },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("skipped");
    expect(rec.filter?.code).toBe("blocked_target_policy");
    expect(r.argvs().some((a) => a[1] === "load-buffer" || a[1] === "paste-buffer")).toBe(false);
  });

  test("refuses agent composer panes for shell commands", async () => {
    const r = shellRunner("codewith");
    const rec = await performExec(
      { target: "work:agent", command: "mailery status" },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("skipped");
    expect(rec.filter?.code).toBe("blocked_target_kind");
    expect(r.argvs().some((a) => a[1] === "load-buffer" || a[1] === "paste-buffer")).toBe(false);
  });
});
