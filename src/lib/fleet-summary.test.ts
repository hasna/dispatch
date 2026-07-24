import { describe, expect, test } from "bun:test";
import { Tmux } from "./tmux.js";
import { performFleetSummary } from "./fleet-summary.js";
import { MockRunner } from "../test/mock-runner.js";

const codewithComposerCapture = `
╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (v0.1.42)                             │
│ model:       gpt-5.5 xhigh   fast   /model to change    │
│ directory:   ~/workspace/hasna/opensource/open-dispatch │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
› Fix native chat
gpt-5.5 xhigh fast · account010 · 5h 90% left · Main [default]       Goal achieved (21s)
token=supersecret123
`;

const codexWorkingCapture = `
╭────────────────────────────────────────╮
│ ✦ OpenAI Codex                         │
│ model:       gpt-5-codex               │
│ directory:   /home/hasna/workspace/app │
│ permissions: workspace-write           │
╰────────────────────────────────────────╯
› Continue task
gpt-5-codex xhigh · account010 · 5h 90% left · Main [default]       Pursuing goal (20m)
✶ Working… (esc to interrupt)
`;

function fleetRunner(): MockRunner {
  const r = new MockRunner();
  r.responder = (argv) => {
    if (argv[1] === "list-panes") {
      return {
        stdout: [
          "work:1.0\tcodewith\t1\tnode\t/repo\t1111",
          "work:2.0\tcodex\t0\tbun\t/repo\t2222",
          "work:3.0\tserver\t0\tnode\t/srv\t3333",
          "other:1.0\tcodewith\t0\tnode\t/repo\t4444",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
        source: "local",
      };
    }
    if (argv[1] === "capture-pane") {
      const target = argv[argv.indexOf("-t") + 1];
      if (target === "work:1.0") return { stdout: codewithComposerCapture, stderr: "", exitCode: 0, source: "local" };
      if (target === "work:2.0") return { stdout: codexWorkingCapture, stderr: "", exitCode: 0, source: "local" };
      if (target === "work:3.0") return { stdout: "node server.js\nListening on http://127.0.0.1:3000\n", stderr: "", exitCode: 0, source: "local" };
      return { stdout: codewithComposerCapture, stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[0] === "sh" && argv[2]?.includes("ps -o pid=,ppid=,stat=,command=")) {
      const pid = argv[4];
      if (pid === "1111" || pid === "4444") {
        return {
          stdout: `${pid} 1 Sl+ node --max-old-space-size=6144 /home/hasna/.bun/bin/codewith --auth-profile account010\n`,
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      if (pid === "2222") {
        return { stdout: "2222 1 Sl+ bun /home/hasna/.bun/bin/codex\n", stderr: "", exitCode: 0, source: "local" };
      }
      return { stdout: "3333 1 Sl+ node /srv/server.js codewith\n", stderr: "", exitCode: 0, source: "local" };
    }
    return { stdout: "", stderr: "", exitCode: 0, source: "local" };
  };
  return r;
}

describe("performFleetSummary", () => {
  test("classifies bounded Codewith/Codex wrappers and refuses arbitrary node panes", () => {
    const r = fleetRunner();
    const result = performFleetSummary(
      { targets: "work:*", changedSince: "5m", maxPaneChars: 80, limit: 3 },
      { tmux: new Tmux(r) },
    );

    expect(result).toMatchObject({
      schemaVersion: "dispatch.fleet_summary.v1",
      status: "completed",
      totalTargets: 4,
      matchedTargets: 3,
      inspectedTargets: 3,
      maxPaneChars: 80,
      totals: { idle: 1, stuck: 1, blocked: 1 },
    });
    expect(result.items.every((item) => item.excerpt.length <= 80)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("supersecret123");
    expect(JSON.stringify(result)).toContain("<redacted:secret>");

    expect(result.items.find((item) => item.target === "work:1.0")).toMatchObject({
      detection: { agentKind: "codewith", canReceivePrompt: true },
      classification: { state: "idle", uncertainty: "low" },
    });
    expect(result.items.find((item) => item.target === "work:2.0")).toMatchObject({
      detection: { agentKind: "codex" },
      classification: { state: "stuck", uncertainty: "medium", observedActivityAgeMs: 20 * 60_000 },
    });
    expect(result.items.find((item) => item.target === "work:3.0")).toMatchObject({
      detection: { agentKind: "unknown", canReceivePrompt: false },
      classification: { state: "blocked" },
    });
    expect(r.argvs().some((argv) => argv[0] === "ps")).toBe(false);
    expect(r.argvs().some((argv) => argv[0] === "sh" && argv[2]?.includes("head -n") && argv[2]?.includes("cut -c"))).toBe(true);
  });

  test("applies limit before bounded capture and process-tree inspection", () => {
    const r = fleetRunner();
    const result = performFleetSummary({ targets: "*", limit: 1 }, { tmux: new Tmux(r) });

    expect(result).toMatchObject({ totalTargets: 4, matchedTargets: 4, inspectedTargets: 1, omittedTargets: 3 });
    const capturedTargets = r
      .argvs()
      .filter((argv) => argv[1] === "capture-pane")
      .map((argv) => argv[argv.indexOf("-t") + 1]);
    expect(capturedTargets).toEqual(["work:1.0"]);
  });

  test("fails AI preflight before tmux probing when no provider is configured", () => {
    const r = fleetRunner();
    const result = performFleetSummary({ preflightAi: true }, { tmux: new Tmux(r), env: {} });

    expect(result).toMatchObject({
      schemaVersion: "dispatch.fleet_summary.v1",
      status: "failed",
      inspectedTargets: 0,
      preflight: { ok: false, provider: "none" },
    });
    expect(r.argvs()).toHaveLength(0);
  });

  test("returns deterministic failed JSON shape for invalid changed-since", () => {
    const r = fleetRunner();
    const result = performFleetSummary({ changedSince: "soon" }, { tmux: new Tmux(r) });

    expect(result).toMatchObject({
      schemaVersion: "dispatch.fleet_summary.v1",
      status: "failed",
      inspectedTargets: 0,
      items: [],
    });
    expect(result.detail).toMatch(/invalid changed-since/);
    expect(r.argvs()).toHaveLength(0);
  });

  test("passes AI preflight without exposing the API key", () => {
    const r = fleetRunner();
    const result = performFleetSummary(
      { preflightAi: true, ai: { provider: "openai" }, limit: 1 },
      { tmux: new Tmux(r), env: { OPENAI_API_KEY: "fixture-openai-key" } },
    );

    expect(result.status).toBe("completed");
    expect(result.preflight).toMatchObject({ ok: true, provider: "openai", keyEnv: "OPENAI_API_KEY" });
    expect(JSON.stringify(result)).not.toContain("fixture-openai-key");
  });
});
