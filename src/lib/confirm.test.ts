import { describe, expect, test } from "bun:test";
import {
  confirmDelivery,
  detectQueued,
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

describe("detectQueued", () => {
  test("matches busy-agent staging messages", () => {
    expect(detectQueued("Messages to be submitted after next tool call")).toBe(true);
    expect(detectQueued("1 message queued")).toBe(true);
    expect(detectQueued("will be submitted when the agent is free")).toBe(true);
  });
  test("does not match ordinary content", () => {
    expect(detectQueued("> type your prompt")).toBe(false);
    expect(detectQueued("running the test suite")).toBe(false);
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

  // --- regressions for the busy-pane / command-echo false negatives ---

  test("raw shell: command echoed + output printed => delivered (not 'still in composer')", () => {
    const res = evaluateDelivery({
      before: "user@host:~$ ",
      afterTyped: "user@host:~$ echo MARKER_123",
      after: "user@host:~$ echo MARKER_123\nMARKER_123\nuser@host:~$ ",
      prompt: "echo MARKER_123",
    });
    expect(res.delivered).toBe(true);
    expect(res.queued).toBe(false);
    expect(res.reason).toMatch(/advanced|acted on/i);
  });

  test("line-wrapped command echo still recognized as delivered", () => {
    // The shell prompt + command wrap across lines; the tail is split.
    const res = evaluateDelivery({
      before: "hasna@spark02:~/very/long/path$ ",
      afterTyped: "hasna@spark02:~/very/long/path$ echo REPRO_MARKER_62\n300",
      after: "hasna@spark02:~/very/long/path$ echo REPRO_MARKER_62\n300\nREPRO_MARKER_62300\nhasna@spark02:~/very/long/path$ ",
      prompt: "echo REPRO_MARKER_62300",
    });
    expect(res.delivered).toBe(true);
  });

  test("busy agent queues the message => delivered + queued", () => {
    const before = "✶ Working… (esc to interrupt)\n  doing a tool call";
    const res = evaluateDelivery({
      before,
      afterTyped: `${before}\n> apply the lease-loss fix now`,
      after: "✶ Working… (esc to interrupt)\nMessages to be submitted after next tool call:\n  apply the lease-loss fix now",
      prompt: "apply the lease-loss fix now",
    });
    expect(res.delivered).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.reason).toMatch(/queued/i);
  });

  test("busy spinner frame change with prompt still parked is not delivered", () => {
    const res = evaluateDelivery({
      before: "✶ Working (esc to interrupt) frame1",
      afterTyped: "✶ Working (esc to interrupt) frame1\n> DO_NOT_SUBMIT_YET",
      after: "✶ Working (esc to interrupt) frame2\n> DO_NOT_SUBMIT_YET",
      prompt: "DO_NOT_SUBMIT_YET",
    });
    expect(res.delivered).toBe(false);
    expect(res.queued).toBe(false);
    expect(res.reason).toMatch(/parked|not submitted/i);
  });

  test("busy agent with no recognized indicator but the pane advanced => delivered", () => {
    // Even if our working/queued patterns miss the agent's exact wording, the
    // pane changing after Enter is enough to know the prompt was acted on.
    const res = evaluateDelivery({
      before: "agent is busy running\n  some opaque footer",
      afterTyped: "agent is busy running\n  some opaque footer\n> dispatched prompt tail",
      after: "agent is busy running\n  some opaque footer\n  (received: dispatched prompt tail)",
      prompt: "dispatched prompt tail",
    });
    expect(res.delivered).toBe(true);
  });

  test("genuine unsent: Enter was a no-op, pane unchanged => not delivered", () => {
    const idle = "> please do the thing\n  /help for commands";
    const res = evaluateDelivery({
      before: "> \n  /help for commands",
      afterTyped: idle,
      after: idle, // pressing Enter changed nothing
      prompt: "please do the thing",
    });
    expect(res.delivered).toBe(false);
    expect(res.reason).toMatch(/not submitted|parked/i);
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
