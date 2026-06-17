import { describe, expect, test } from "bun:test";
import {
  confirmDelivery,
  detectWorking,
  evaluateDelivery,
  promptTail,
} from "./confirm.js";
import { Tmux } from "./tmux.js";
import { MockRunner } from "../test/mock-runner.js";

describe("detectWorking", () => {
  test("matches common agent working indicators", () => {
    expect(detectWorking("✶ Forming… (esc to interrupt)")).toBe(true);
    expect(detectWorking("Thinking...")).toBe(true);
    expect(detectWorking("Working (ctrl+c to interrupt)")).toBe(true);
    expect(detectWorking("⠹ generating response")).toBe(true);
  });
  test("does not match an idle composer", () => {
    expect(detectWorking("> \n  /help for commands")).toBe(false);
    expect(detectWorking("$ ")).toBe(false);
  });
});

describe("promptTail", () => {
  test("uses the last non-empty line, capped", () => {
    expect(promptTail("first line\nsecond and final line")).toBe("second and final line");
    expect(promptTail("only line")).toBe("only line");
  });
  test("caps length", () => {
    const tail = promptTail("x".repeat(100), 10);
    expect(tail.length).toBe(10);
  });
});

describe("evaluateDelivery", () => {
  const prompt = "Refactor the auth module and add tests";

  test("working indicator appearing = delivered", () => {
    const res = evaluateDelivery({
      before: "> Refactor the auth module and add tests",
      after: "✶ Working… (esc to interrupt)",
      prompt,
    });
    expect(res.delivered).toBe(true);
    expect(res.workingDetected).toBe(true);
    expect(res.reason).toMatch(/working/i);
  });

  test("composer clears (with typed snapshot) = delivered", () => {
    const res = evaluateDelivery({
      before: "> ",
      afterTyped: "> Refactor the auth module and add tests",
      after: "> \n  ⏎ to send", // prompt gone from composer
      prompt,
    });
    expect(res.composerCleared).toBe(true);
    expect(res.delivered).toBe(true);
  });

  test("prompt still in composer = not delivered", () => {
    const res = evaluateDelivery({
      before: "> ",
      afterTyped: "> Refactor the auth module and add tests",
      after: "> Refactor the auth module and add tests", // unchanged, still sitting there
      prompt,
    });
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/still visible|not submitted/i);
  });

  test("working indicator already present before is not counted", () => {
    const res = evaluateDelivery({
      before: "✶ Working… (esc to interrupt) > Refactor the auth module and add tests",
      after: "✶ Working… (esc to interrupt)",
      afterTyped: "✶ Working… (esc to interrupt) > Refactor the auth module and add tests",
      prompt,
    });
    // working was already there; rely on composer clearing instead
    expect(res.workingDetected).toBe(false);
    expect(res.composerCleared).toBe(true);
    expect(res.delivered).toBe(true);
  });
});

describe("confirmDelivery", () => {
  const noSleep = async () => {};

  test("polls and returns delivered once the working indicator appears", async () => {
    const r = new MockRunner();
    // first two captures: still idle; third: working
    r.responder = (argv) => {
      if (argv[1] === "capture-pane") {
        const idx = r.calls.filter((c) => c.argv[1] === "capture-pane").length;
        const stdout = idx >= 3 ? "✶ Working… (esc to interrupt)" : "> still composing the prompt tail";
        return { stdout, stderr: "", exitCode: 0, source: "local" };
      }
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };
    const res = await confirmDelivery(new Tmux(r), "s:w", {
      before: "> ",
      prompt: "do the thing",
      maxPolls: 5,
      sleep: noSleep,
    });
    expect(res.delivered).toBe(true);
  });

  test("returns not-delivered if no signal ever appears", async () => {
    const r = new MockRunner();
    r.responder = (argv) => ({
      stdout: argv[1] === "capture-pane" ? "> do the thing" : "",
      stderr: "",
      exitCode: 0,
      source: "local",
    });
    const res = await confirmDelivery(new Tmux(r), "s:w", {
      before: "> ",
      afterTyped: "> do the thing",
      prompt: "do the thing",
      maxPolls: 3,
      sleep: noSleep,
    });
    expect(res.delivered).toBe(false);
  });
});
