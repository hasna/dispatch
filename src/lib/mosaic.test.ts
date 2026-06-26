import { describe, expect, test } from "bun:test";
import { Mosaic, parseMosaicTarget, performMosaicCapture, performMosaicDispatch } from "./mosaic.js";
import { MockRunner } from "../test/mock-runner.js";
import { Store } from "./store.js";

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("parseMosaicTarget", () => {
  test("parses session:pane_id", () => {
    expect(parseMosaicTarget("work:terminal_1")).toEqual({ session: "work", paneId: "terminal_1" });
  });

  test("requires session and pane id", () => {
    expect(() => parseMosaicTarget("work")).toThrow(/<session>:<pane_id>/);
    expect(() => parseMosaicTarget("work:")).toThrow(/<session>:<pane_id>/);
  });
});

describe("Mosaic native CLI adapter", () => {
  test("discovers sessions, tabs, and panes through native Mosaic list commands", () => {
    const r = new MockRunner();
    r.responder = (argv) => {
      if (argv.join(" ") === "mosaic sessions list") {
        return { stdout: json({ schema_version: "mosaic.control.v1", data: [{ name: "work" }] }), stderr: "", exitCode: 0, source: "local" };
      }
      if (argv.join(" ") === "mosaic --session work tabs list --all") {
        return {
          stdout: json({ schema_version: "mosaic.control.v1", data: [{ tab_id: "tab_1", name: "Agent", active: true }] }),
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      if (argv.join(" ") === "mosaic --session work panes list --all") {
        return {
          stdout: json({ schema_version: "mosaic.control.v1", data: [{ pane_id: "terminal_1", tab_id: "tab_1", active: true }] }),
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      return { stdout: "", stderr: `unexpected ${argv.join(" ")}`, exitCode: 1, source: "local" };
    };

    expect(new Mosaic(r).listTargets()).toEqual([
      {
        backend: "mosaic",
        target: "work:terminal_1",
        session: "work",
        paneId: "terminal_1",
        tabId: "tab_1",
        window: "Agent",
        active: true,
        raw: { pane_id: "terminal_1", tab_id: "tab_1", active: true },
      },
    ]);
    expect(r.argvs()).toEqual([
      ["mosaic", "sessions", "list"],
      ["mosaic", "--session", "work", "tabs", "list", "--all"],
      ["mosaic", "--session", "work", "panes", "list", "--all"],
    ]);
  });

  test("records accepted prompt receipts from Mosaic", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        event: "receipt",
        id: "mosaic-123",
        operation: "prompt.send",
        session: "work",
        pane_id: "terminal_1",
        status: "accepted",
        ack: "server_accepted",
        timestamp_ms: 1782290000000,
        error: null,
      }),
    });
    const store = new Store(":memory:");
    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "status?" },
      { mosaic: new Mosaic(r), store },
    );

    expect(rec).toMatchObject({
      backend: "mosaic",
      status: "delivered",
      receipt: { id: "mosaic-123", status: "accepted" },
      confirm: { delivered: true },
    });
    expect(store.getDispatch(rec.id)).toMatchObject({ backend: "mosaic", receipt: { id: "mosaic-123" } });
    expect(r.lastArgv()).toEqual([
      "mosaic",
      "--session",
      "work",
      "prompt",
      "send",
      "--pane-id",
      "terminal_1",
      "--text",
      "status?",
    ]);
  });

  test("preserves queued prompt semantics", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        event: "receipt",
        operation: "prompt.send",
        session: "work",
        pane_id: "terminal_1",
        id: "queued-1",
        status: "accepted",
        ack: "queued",
      }),
    });

    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "next task", queue: true },
      { mosaic: new Mosaic(r) },
    );

    expect(r.lastArgv()).toContain("--queue");
    expect(rec.status).toBe("delivered");
    expect(rec.confirm?.queued).toBe(true);
    expect(rec.detail).toMatch(/queued/);
  });

  test("uses top-level Mosaic dry-run and resolved text delivery", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        event: "receipt",
        operation: "prompt.send",
        session: "work",
        pane_id: "terminal_1",
        id: "dry-1",
        status: "accepted",
      }),
    });

    const rec = await performMosaicDispatch(
      {
        backend: "mosaic",
        target: "work:terminal_1",
        prompt: "from file",
        promptFile: "prompt.md",
        dryRun: true,
      },
      { mosaic: new Mosaic(r) },
    );

    expect(rec).toMatchObject({ status: "skipped", dryRun: true, receipt: { id: "dry-1" } });
    expect(r.lastArgv()).toEqual([
      "mosaic",
      "--session",
      "work",
      "--dry-run",
      "prompt",
      "send",
      "--pane-id",
      "terminal_1",
      "--text",
      "from file",
    ]);
  });

  test("uses --text instead of --file when goal prefixing changes prompt contents", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        event: "receipt",
        operation: "prompt.send",
        session: "work",
        pane_id: "terminal_1",
        id: "goal-1",
        status: "accepted",
      }),
    });

    await performMosaicDispatch(
      {
        backend: "mosaic",
        target: "work:terminal_1",
        prompt: "Fix it",
        promptFile: "prompt.md",
        goal: true,
      },
      { mosaic: new Mosaic(r) },
    );

    expect(r.lastArgv()).toContain("--text");
    expect(r.lastArgv()).toContain("/goal Fix it");
    expect(r.lastArgv()).not.toContain("--file");
  });

  test("maps no-submit delivery to native --no-submit", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        event: "receipt",
        operation: "prompt.send",
        session: "work",
        pane_id: "terminal_1",
        id: "typed-1",
        status: "accepted",
      }),
    });

    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "draft", submit: false },
      { mosaic: new Mosaic(r) },
    );

    expect(r.lastArgv()).toContain("--no-submit");
    expect(rec.status).toBe("delivered");
    expect(rec.detail).toMatch(/without submitting/);
  });

  test("surfaces Mosaic command failures as failed dispatch records", async () => {
    const r = new MockRunner();
    r.queue.push({
      stderr: json({
        schema_version: "mosaic.control.v1",
        event: "error",
        code: "no_active_session",
        message: "no active Mosaic session found",
      }),
      exitCode: 1,
    });

    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "status?" },
      { mosaic: new Mosaic(r) },
    );

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/no active Mosaic session found/);
  });

  test("rejects malformed Mosaic receipts instead of false-positive delivery", async () => {
    const r = new MockRunner();
    r.queue.push({ stdout: json({ schema_version: "mosaic.control.v1", data: { ok: true } }) });

    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "status?" },
      { mosaic: new Mosaic(r) },
    );

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/receipt event|operation|missing/i);
  });

  test("rejects Mosaic receipt target mismatches", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        event: "receipt",
        operation: "prompt.send",
        session: "other",
        pane_id: "terminal_1",
        status: "accepted",
      }),
    });

    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "status?" },
      { mosaic: new Mosaic(r) },
    );

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/session mismatch/);
  });

  test("maps submitKey Tab to Mosaic queue mode", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        event: "receipt",
        operation: "prompt.send",
        session: "work",
        pane_id: "terminal_1",
        id: "tab-1",
        status: "accepted",
        ack: "queued",
      }),
    });

    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "queue", submitKey: "Tab" },
      { mosaic: new Mosaic(r) },
    );

    expect(r.lastArgv()).toContain("--queue");
    expect(rec.confirm?.queued).toBe(true);
  });

  test("fails closed for Mosaic if-idle when not queued or forced", async () => {
    const r = new MockRunner();
    const rec = await performMosaicDispatch(
      { backend: "mosaic", target: "work:terminal_1", prompt: "status?", ifIdle: true },
      { mosaic: new Mosaic(r) },
    );

    expect(rec.status).toBe("skipped");
    expect(rec.detail).toMatch(/cannot prove target idleness/i);
    expect(r.calls).toHaveLength(0);
  });

  test("captures recent Mosaic pane output and redacts secrets", async () => {
    const r = new MockRunner();
    r.queue.push({
      stdout: json({
        schema_version: "mosaic.control.v1",
        data: { text: "old\nvisible token=supersecret\nlast\n" },
      }),
    });

    const result = await performMosaicCapture(
      { backend: "mosaic", target: "work:terminal_1", lines: 2 },
      { mosaic: new Mosaic(r) },
    );

    expect(r.lastArgv()).toEqual(["mosaic", "--session", "work", "capture", "--pane-id", "terminal_1", "--scrollback"]);
    expect(result).toMatchObject({ backend: "mosaic", status: "captured", lines: 2 });
    expect(result.text).toBe("visible token=<redacted:secret>\nlast\n");
  });

  test("builds native subscribe argv for ndjson and raw streams", () => {
    const mosaic = new Mosaic(new MockRunner());
    expect(mosaic.subscribeArgv("work:terminal_1")).toEqual([
      "mosaic",
      "--session",
      "work",
      "subscribe",
      "--pane-id",
      "terminal_1",
      "--format",
      "ndjson",
    ]);
    expect(mosaic.subscribeArgv("work:terminal_1", "raw").at(-1)).toBe("raw");
  });
});
