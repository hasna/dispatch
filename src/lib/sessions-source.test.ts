import { describe, expect, test } from "bun:test";
import { MockRunner } from "../test/mock-runner.js";
import { parseSessionsTargets, resolveSessionsTargets } from "./sessions-source.js";

describe("sessions target source", () => {
  test("parses flexible sessions JSON and dedupes targets", () => {
    const targets = parseSessionsTargets(
      JSON.stringify({
        sessions: [
          { target: "open-router:1.1", machine: "spark01", status: "idle", project: "router" },
          { tmux_target: "open-router:1.1", machine: "spark01", status: "idle", project: "router duplicate" },
          { paneTarget: "open-sessions:2.1", machine_id: "spark02", activity: "active", project: "sessions" },
          { pane: "", machine: "spark03" },
        ],
      }),
    );

    expect(targets).toEqual([
      { target: "open-router:1.1", machine: "spark01", source: "sessions-query", state: "idle" },
      { target: "open-sessions:2.1", machine: "spark02", source: "sessions-query", state: "active" },
    ]);
  });

  test("filters sessions results by query text", () => {
    const targets = parseSessionsTargets(
      JSON.stringify([
        { target: "open-router:1.1", machine: "spark01", project: "router" },
        { target: "open-browser:1.1", machine: "spark01", project: "browser" },
      ]),
      undefined,
      "browser",
    );

    expect(targets.map((t) => t.target)).toEqual(["open-browser:1.1"]);
  });

  test("probes sessions live first and falls back to sessions status", async () => {
    const r = new MockRunner("spark02");
    r.responder = (argv) => {
      if (argv.join(" ") === "sessions live --json --once") {
        return { stdout: "", stderr: "unknown command", exitCode: 1, source: "spark02" };
      }
      if (argv.join(" ") === "sessions status --json") {
        return {
          stdout: JSON.stringify({ targets: [{ target: "open-router:1.1", status: "idle" }] }),
          stderr: "",
          exitCode: 0,
          source: "spark02",
        };
      }
      return { stdout: "", stderr: "unexpected", exitCode: 1, source: "spark02" };
    };

    await expect(resolveSessionsTargets({ runner: r, machine: "spark02" })).resolves.toEqual([
      { target: "open-router:1.1", machine: "spark02", source: "sessions-query", state: "idle" },
    ]);
    expect(r.argvs()).toEqual([
      ["sessions", "live", "--json", "--once"],
      ["sessions", "status", "--json"],
    ]);
  });

  test("fails actionably when sessions registry commands are unavailable", async () => {
    const r = new MockRunner();
    r.responder = (argv) => ({ stdout: "", stderr: `unknown command ${argv[1]}`, exitCode: 1, source: "local" });

    await expect(resolveSessionsTargets({ runner: r })).rejects.toThrow(/expected sessions live\/status JSON output/);
  });
});
