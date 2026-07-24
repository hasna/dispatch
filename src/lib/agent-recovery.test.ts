import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performAgentRecovery, performAgentTriage } from "./agent-recovery.js";
import { MAX_CAPTURE_CHARS } from "./capture.js";
import { Tmux } from "./tmux.js";
import { MockRunner } from "../test/mock-runner.js";

const codewithProcessTree = `
1234 1 Ss /usr/bin/bash
1240 1234 Sl+ node /home/hasna/.bun/bin/codewith --auth-profile account009
1241 1240 Sl+ /home/hasna/.bun/install/global/node_modules/@hasna/codewith/node_modules/@hasna/codewith-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codewith --auth-profile account009
`;

const idleCodewithCapture = `
╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (v0.1.42)                             │
│ model:       gpt-5.5 xhigh   fast   /model to change    │
│ directory:   ~/workspace/hasna/opensource/open-dispatch │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
token=supersecret123
› Fix native chat
`;

const activeCodewithCapture = `
Goal active Objective: Investigate dispatch target failures

› Follow-up recovery prompt

  gpt-5.5 xhigh fast · account009 · 5h 9% left · Main [default]       Pursuing goal (3m)
`;

function recoveryRunner(visible: string, processTree = codewithProcessTree): MockRunner {
  const r = new MockRunner();
  r.responder = (argv) => {
    if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
      return { stdout: "node\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_path}") {
      return { stdout: "/repo\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_pid}") {
      return { stdout: "1234\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_in_mode}") {
      return { stdout: "0\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[0] === "sh" && argv[2]?.includes("ps -o pid=,ppid=,stat=,command=")) {
      return { stdout: processTree, stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[0] === "ps") {
      return { stdout: processTree, stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "capture-pane") return { stdout: visible, stderr: "", exitCode: 0, source: "local" };
    return { stdout: "", stderr: "", exitCode: 0, source: "local" };
  };
  return r;
}

describe("agent triage and recovery", () => {
  test("triage classifies Codewith, redacts excerpts, and writes full redacted artifacts by path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch_triage_"));
    const previousDataDir = process.env.DISPATCH_DATA_DIR;
    process.env.DISPATCH_DATA_DIR = dir;
    const r = recoveryRunner(idleCodewithCapture);

    try {
      const result = await performAgentTriage(
        { target: "work:1.0", lines: 50, excerptChars: 500, artifactPath: "capture.txt" },
        { tmux: new Tmux(r) },
      );

      expect(result).toMatchObject({
        schemaVersion: "dispatch.agentTriage.v1",
        status: "ok",
        action: { kind: "send", submitKey: "Enter", safeToApply: true },
        detection: { agentKind: "codewith", composerState: "idle", canReceivePrompt: true },
      });
      expect(result.capture.excerpt).toContain("token=<redacted:secret>");
      expect(result.capture.excerpt).not.toContain("supersecret123");
      expect(result.capture.artifact).toMatchObject({ path: join(dir, "artifacts", "capture.txt"), redacted: true });
      expect(readFileSync(result.capture.artifact!.path, "utf8")).toContain("token=<redacted:secret>");
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DISPATCH_DATA_DIR;
      } else {
        process.env.DISPATCH_DATA_DIR = previousDataDir;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("triage refuses artifact paths outside the dispatch artifact directory", async () => {
    const r = recoveryRunner(idleCodewithCapture);

    const result = await performAgentTriage(
      { target: "work:1.0", artifactPath: "/tmp/dispatch-triage-outside.txt" },
      { tmux: new Tmux(r) },
    );

    expect(result.status).toBe("failed");
    expect(result.capture.artifact).toBeUndefined();
    expect(result.capture.artifactError).toMatch(/relative to the dispatch artifacts directory/);
  });

  test("triage refuses artifact paths that resolve through symlinks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch_triage_symlink_"));
    const previousDataDir = process.env.DISPATCH_DATA_DIR;
    process.env.DISPATCH_DATA_DIR = dir;
    const outside = join(dir, "outside.txt");
    const link = join(dir, "artifacts", "capture.txt");
    writeFileSync(outside, "outside", "utf8");
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    symlinkSync(outside, link);
    const r = recoveryRunner(idleCodewithCapture);

    try {
      const result = await performAgentTriage(
        { target: "work:1.0", artifactPath: "capture.txt" },
        { tmux: new Tmux(r) },
      );

      expect(result.status).toBe("failed");
      expect(result.capture.artifact).toBeUndefined();
      expect(result.capture.artifactError).toMatch(/symlink/);
      expect(readFileSync(outside, "utf8")).toBe("outside");
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DISPATCH_DATA_DIR;
      } else {
        process.env.DISPATCH_DATA_DIR = previousDataDir;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("triage caps huge capture text and artifacts by characters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch_triage_cap_"));
    const previousDataDir = process.env.DISPATCH_DATA_DIR;
    process.env.DISPATCH_DATA_DIR = dir;
    const r = recoveryRunner(`${idleCodewithCapture}\n${"x".repeat(MAX_CAPTURE_CHARS + 10_000)}`);

    try {
      const result = await performAgentTriage(
        { target: "work:1.0", lines: 2000, artifactPath: "huge.txt", excerptChars: 100 },
        { tmux: new Tmux(r) },
      );

      expect(result.capture.maxChars).toBe(MAX_CAPTURE_CHARS);
      expect(result.capture.textLength).toBeLessThanOrEqual(MAX_CAPTURE_CHARS);
      expect(result.capture.truncatedChars).toBe(true);
      expect(result.capture.excerpt?.length).toBeLessThanOrEqual(100);
      expect(result.capture.artifact?.bytes).toBeLessThanOrEqual(MAX_CAPTURE_CHARS);
    } finally {
      if (previousDataDir === undefined) {
        delete process.env.DISPATCH_DATA_DIR;
      } else {
        process.env.DISPATCH_DATA_DIR = previousDataDir;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recover defaults to dry-run and plans queued Tab recovery for active Codewith panes", async () => {
    const r = recoveryRunner(activeCodewithCapture);

    const result = await performAgentRecovery(
      { target: "work:1.0", prompt: "token=supersecret123 Please continue with a concise status.", lines: 20 },
      { tmux: new Tmux(r) },
    );

    expect(result).toMatchObject({
      schemaVersion: "dispatch.agentRecover.v1",
      status: "planned",
      dryRun: true,
      action: { kind: "queue", submitKey: "Tab", safeToApply: true },
      triage: { detection: { agentKind: "codewith", composerState: "active", canQueuePrompt: true } },
    });
    expect(result.dispatch).toMatchObject({ status: "skipped", detail: expect.stringMatching(/^dry run:/) });
    expect(result.promptPreview).toContain("token=<redacted:secret>");
    expect(result.promptPreview).not.toContain("supersecret123");
    expect(r.argvs().some((a) => a[1] === "send-keys" || a[1] === "paste-buffer")).toBe(false);
  });

  test("recover refuses arbitrary node panes even with copied agent-looking text", async () => {
    const r = recoveryRunner(
      `${idleCodewithCapture}\nnode server.js\nListening\n`,
      "1234 1 Ss /usr/bin/bash\n1240 1234 Sl+ node /srv/transcript-viewer.js codewith\n",
    );

    const result = await performAgentRecovery(
      { target: "work:server", prompt: "Do not send this", apply: true },
      { tmux: new Tmux(r) },
    );

    expect(result.status).toBe("refused");
    expect(result.action).toMatchObject({ kind: "refuse", safeToApply: false });
    expect(r.argvs().some((a) => a[1] === "send-keys" || a[1] === "paste-buffer")).toBe(false);
  });
});
