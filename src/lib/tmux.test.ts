import { describe, expect, test } from "bun:test";
import { Tmux, formatTarget, parseTarget } from "./tmux.js";
import { MockRunner } from "../test/mock-runner.js";

describe("parseTarget / formatTarget", () => {
  test("session only", () => {
    expect(parseTarget("work")).toEqual({ session: "work" });
    expect(formatTarget({ session: "work" })).toBe("work");
  });
  test("session:window", () => {
    expect(parseTarget("work:agent")).toEqual({ session: "work", window: "agent" });
    expect(formatTarget({ session: "work", window: "agent" })).toBe("work:agent");
  });
  test("session:window.pane", () => {
    expect(parseTarget("work:agent.1")).toEqual({ session: "work", window: "agent", pane: "1" });
    expect(formatTarget({ session: "work", window: "agent", pane: "1" })).toBe("work:agent.1");
  });
  test("round-trips", () => {
    for (const s of ["a", "a:b", "a:b.2", "a:0.0"]) {
      expect(formatTarget(parseTarget(s))).toBe(s);
    }
  });
  test("rejects empty", () => {
    expect(() => parseTarget("  ")).toThrow();
  });
});

describe("Tmux command construction", () => {
  test("sendLiteral uses send-keys -l -- (literal, end-of-options)", () => {
    const r = new MockRunner();
    new Tmux(r).sendLiteral("s:w", "hello -n");
    expect(r.lastArgv()).toEqual(["tmux", "send-keys", "-t", "s:w", "-l", "--", "hello -n"]);
  });

  test("sendKey sends a named key", () => {
    const r = new MockRunner();
    new Tmux(r).sendKey("s:w", "Enter");
    expect(r.lastArgv()).toEqual(["tmux", "send-keys", "-t", "s:w", "Enter"]);
  });

  test("capturePane uses -p and returns stdout", () => {
    const r = new MockRunner();
    r.queue.push({ stdout: "pane contents\n" });
    const out = new Tmux(r).capturePane("s:w");
    expect(r.lastArgv()).toEqual(["tmux", "capture-pane", "-t", "s:w", "-p"]);
    expect(out).toBe("pane contents\n");
  });

  test("capturePane with scrollback adds -S -N", () => {
    const r = new MockRunner();
    new Tmux(r).capturePane("s:w", { start: 100 });
    expect(r.lastArgv()).toEqual(["tmux", "capture-pane", "-t", "s:w", "-p", "-S", "-100"]);
  });

  test("capturePane throws on failure", () => {
    const r = new MockRunner();
    r.queue.push({ exitCode: 1, stderr: "no pane" });
    expect(() => new Tmux(r).capturePane("s:w")).toThrow(/capture-pane failed/);
  });

  test("hasSession reflects exit code", () => {
    const ok = new MockRunner();
    expect(new Tmux(ok).hasSession("s")).toBe(true);
    const bad = new MockRunner();
    bad.queue.push({ exitCode: 1 });
    expect(new Tmux(bad).hasSession("s")).toBe(false);
  });

  test("paneExists uses list-panes and requires a pane id", () => {
    const r = new MockRunner();
    r.queue.push({ stdout: "%3\n", exitCode: 0 });
    expect(new Tmux(r).paneExists("s:w.0")).toBe(true);
    expect(r.lastArgv()).toEqual(["tmux", "list-panes", "-t", "s:w.0", "-F", "#{pane_id}"]);

    const empty = new MockRunner();
    empty.queue.push({ stdout: "", exitCode: 0 });
    expect(new Tmux(empty).paneExists("s:w.0")).toBe(false);
  });

  test("loadBuffer pipes text to stdin", () => {
    const r = new MockRunner();
    new Tmux(r).loadBuffer("buf1", "long text");
    const call = r.calls[r.calls.length - 1]!;
    expect(call.argv).toEqual(["tmux", "load-buffer", "-b", "buf1", "-"]);
    expect(call.input).toBe("long text");
  });

  test("pasteBuffer with bracketed + deleteAfter adds -p -d", () => {
    const r = new MockRunner();
    new Tmux(r).pasteBuffer("s:w", "buf1", { bracketed: true, deleteAfter: true });
    expect(r.lastArgv()).toEqual(["tmux", "paste-buffer", "-t", "s:w", "-b", "buf1", "-p", "-d"]);
  });

  test("paste loads a unique buffer then pastes it bracketed and deletes it", () => {
    const r = new MockRunner();
    new Tmux(r).paste("s:w", "multi\nline\ntext");
    expect(r.calls.length).toBe(2);
    const [load, paste] = r.argvs();
    expect(load!.slice(0, 3)).toEqual(["tmux", "load-buffer", "-b"]);
    expect(r.calls[0]!.input).toBe("multi\nline\ntext");
    expect(paste!.slice(0, 4)).toEqual(["tmux", "paste-buffer", "-t", "s:w"]);
    expect(paste).toContain("-p");
    expect(paste).toContain("-d");
    // load and paste reference the same buffer name
    // load: [tmux, load-buffer, -b, <name>, -]; paste: [tmux, paste-buffer, -t, s:w, -b, <name>, ...]
    expect(load![3]).toBe(paste![5]);
  });
});
