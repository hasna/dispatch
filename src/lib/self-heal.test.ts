import { describe, expect, test } from "bun:test";
import { diagnoseDispatchSelfHeal, redactSelfHealText } from "./self-heal.js";

describe("dispatch self-heal diagnosis", () => {
  test("redacts common secret-looking values", () => {
    const apiKey = "sk-" + "proj-" + "abc123xyz";
    const githubToken = "ghp" + "_abcdef";
    const npmToken = "npm" + "_npmsecret";
    const awsKey = "AKIA" + "ABCDEFGHIJKLMNOP";
    const redacted = redactSelfHealText(
      `Authorization: Bearer ${apiKey} token=value ${githubToken} ${npmToken} ${awsKey}`,
    );

    expect(redacted).toContain("[REDACTED:credential]");
    expect(redacted).toContain("[REDACTED:github-token]");
    expect(redacted).toContain("[REDACTED:npm-token]");
    expect(redacted).toContain("[REDACTED:aws-access-key]");
    expect(redacted).not.toContain(apiKey);
    expect(redacted).not.toContain(githubToken);
    expect(redacted).not.toContain(npmToken);
    expect(redacted).not.toContain(awsKey);
  });

  test("classifies auth failures and forbids tmux paste fallback by default", () => {
    const apiKey = "sk-" + "ant-" + "secret";
    const diagnosis = diagnoseDispatchSelfHeal({
      target: "work:agent",
      machine: "spark01",
      errorText: `Codewith auth profile switch blocked queued input with 401 token=${apiKey}`,
    });

    expect(diagnosis).toMatchObject({
      dryRun: true,
      mutates: false,
      category: "auth",
      fallbackPolicy: { tmuxPasteFallbackAllowed: false },
    });
    expect(diagnosis.redacted.errorText).not.toContain(apiKey);
    expect(diagnosis.nextActions.join("\n")).toMatch(/do not use tmux prompt paste fallback/i);
    expect(diagnosis.affectedMachineChecks.check).toEqual(["spark01", "spark02", "apple03"]);
    expect(diagnosis.affectedMachineChecks.ignoreIfNonresponsive).toEqual(["apple01"]);
  });

  test("classifies stale package failures and records explicit legacy handoff authorization", () => {
    const diagnosis = diagnoseDispatchSelfHeal({
      errorText: "dispatch: unknown option '--from sessions-query' after stale package install",
      legacyHandoffAuthorized: true,
    });

    expect(diagnosis.category).toBe("stale_package");
    expect(diagnosis.fallbackPolicy.tmuxPasteFallbackAllowed).toBe(true);
    expect(diagnosis.recommendedAction).toMatch(/publish.*update @hasna\/dispatch/i);
  });

  test("routes machine failures toward machine reachability checks", () => {
    const diagnosis = diagnoseDispatchSelfHeal({
      machine: "spark02",
      errorText: "ssh: connect to host spark02 port 22: Connection timed out",
    });

    expect(diagnosis.category).toBe("machine");
    expect(diagnosis.repairRoute).toMatch(/open-machines/);
    expect(diagnosis.nextActions.join("\n")).toMatch(/spark01, spark02, and apple03/);
  });
});
