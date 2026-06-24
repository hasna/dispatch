import { describe, expect, test } from "bun:test";
import {
  confirmDelivery,
  detectActionNeeded,
  detectHandledOutput,
  detectQueued,
  detectWorking,
  evaluateDelivery,
  isPromptParkedInComposer,
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

describe("detectActionNeeded", () => {
  test("matches Codewith auth profile auto-switch/account limit states", () => {
    expect(detectActionNeeded("Auto-switching auth profile to account010...")).toBe(true);
    expect(detectActionNeeded("Your prompt will continue with that account")).toBe(true);
    expect(detectActionNeeded("account005 exhausted; switching profiles")).toBe(true);
  });

  test("does not match ordinary queued follow-up wording by itself", () => {
    expect(detectActionNeeded("Queued follow-up inputs")).toBe(false);
    expect(detectActionNeeded("Messages to be submitted after next tool call")).toBe(false);
  });
});

describe("detectHandledOutput", () => {
  test("matches disabled slash-command output", () => {
    expect(detectHandledOutput("The /model slash command is disabled while a response is streaming.")).toBe(true);
    expect(detectHandledOutput("Command /permissions is not available right now.")).toBe(true);
    expect(detectHandledOutput("Unknown slash command: /workflow")).toBe(true);
  });
  test("does not match ordinary busy output", () => {
    expect(detectHandledOutput("Messages to be submitted after next tool call")).toBe(false);
    expect(detectHandledOutput("Working on the request")).toBe(false);
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

describe("isPromptParkedInComposer", () => {
  test("treats Claude collapsed pasted-text placeholders as parked input", () => {
    const prompt = `${"very long pasted content ".repeat(600)}FINAL_TAIL_NOT_VISIBLE`;

    expect(isPromptParkedInComposer("❯ [Pasted text]", prompt)).toBe(true);
    expect(isPromptParkedInComposer("❯ [Pasted text #1 +11 lines]", prompt)).toBe(true);
    expect(isPromptParkedInComposer("> [Pasted text #2 +1 line]", prompt)).toBe(true);
  });

  test("does not treat a submitted prompt in scrollback above a working footer as parked", () => {
    const prompt = "Please refactor the tokenizer and add unit tests for edge cases.";
    const capture = `› awaiting prompt — idle

› ${prompt}

✶ Working… (esc to interrupt)
`;

    expect(isPromptParkedInComposer(capture, prompt)).toBe(false);
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

  test("working indicator appearing after a submitted prompt left in scrollback = delivered", () => {
    const res = evaluateDelivery({
      before: "› awaiting prompt — idle",
      after: `› awaiting prompt — idle

› ${prompt}

✶ Working… (esc to interrupt)`,
      prompt,
    });
    expect(res.delivered).toBe(true);
    expect(res.workingDetected).toBe(true);
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

  test("raw shell: echoed long command with no immediate output => delivered", () => {
    const prompt =
      "cd /home/hasna/workspace/hasna/opensource/open-codewith-qa/codex-rs && just test-fast -p codex-state managed_worktree";
    const echoed = `hasna@spark01:~/workspace$ ${prompt}`;
    const res = evaluateDelivery({
      before: "hasna@spark01:~/workspace$ ",
      afterTyped: echoed,
      after: echoed,
      prompt,
      shellCommand: true,
    });
    expect(res.delivered).toBe(true);
    expect(res.reason).toMatch(/shell command echo/i);
  });

  test("agent composer: unchanged prompt is still not delivered", () => {
    const prompt =
      "cd /home/hasna/workspace/hasna/opensource/open-codewith-qa/codex-rs && just test-fast -p codex-state managed_worktree";
    const parked = `> ${prompt}`;
    const res = evaluateDelivery({
      before: "> ",
      afterTyped: parked,
      after: parked,
      prompt,
    });
    expect(res.delivered).toBe(false);
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

  test("auth auto-switch with queued follow-up input is action-needed, not delivered", () => {
    const prompt = "retry after account switch";
    const before = "● Working on previous task… (esc to interrupt)\n  checking account limits";
    const res = evaluateDelivery({
      before,
      afterTyped: `${before}\n› ${prompt}`,
      after: `Auto-switching auth profile to account010...
Your prompt will continue with that account
Queued follow-up inputs:
  ${prompt}`,
      prompt,
    });

    expect(res.delivered).toBe(false);
    expect(res.queued).toBe(true);
    expect(res.actionNeeded).toBe(true);
    expect(res.authSwitchDetected).toBe(true);
    expect(res.reason).toMatch(/auth profile|action needed/i);
  });

  test("auth-switch words inside the queued prompt body do not trigger action-needed", () => {
    const prompt = "Document the text: Auto-switching auth profile to account010";
    const before = "● Working on previous task… (esc to interrupt)\n  normal tool call";
    const res = evaluateDelivery({
      before,
      afterTyped: `${before}\n› ${prompt}`,
      after: `● Working on previous task… (esc to interrupt)
Messages to be submitted after next tool call:
  ${prompt}`,
      prompt,
    });

    expect(res.delivered).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.actionNeeded).toBe(false);
    expect(res.authSwitchDetected).toBe(false);
  });

  test("ordinary task output about auth profile limits does not block a normal queue", () => {
    const prompt = "continue the normal queued task";
    const before = "● Working… (esc to interrupt)\n  Investigating auth profile limit handling";
    const res = evaluateDelivery({
      before,
      afterTyped: `${before}\n› ${prompt}`,
      after: `● Working… (esc to interrupt)
  Investigating auth profile limit handling
Messages to be submitted after next tool call:
  ${prompt}`,
      prompt,
    });

    expect(res.delivered).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.actionNeeded).toBe(false);
  });

  test("auth-switch text after the queue label still marks action-needed", () => {
    const prompt = "retry after profile switch";
    const before = "● Working on previous task… (esc to interrupt)\n  checking account limits";
    const res = evaluateDelivery({
      before,
      afterTyped: `${before}\n› ${prompt}`,
      after: `Queued follow-up inputs:
Auto-switching auth profile to account010...
Your prompt will continue with that account
  ${prompt}`,
      prompt,
    });

    expect(res.delivered).toBe(false);
    expect(res.queued).toBe(true);
    expect(res.actionNeeded).toBe(true);
    expect(res.authSwitchDetected).toBe(true);
  });

  test("busy agent disabled slash-command output => delivered, not retried", () => {
    const before = "✶ Working… (esc to interrupt)\n  streaming mock response";
    const res = evaluateDelivery({
      before,
      afterTyped: `${before}\n> /workflow`,
      after: "✻ Working… (esc to interrupt)\n  The /workflow slash command is disabled while a response is streaming.\n> /workflow",
      prompt: "/workflow",
    });
    expect(res.delivered).toBe(true);
    expect(res.handledOutput).toBe(true);
    expect(res.queued).toBe(false);
    expect(res.reason).toMatch(/disabled|rejection/i);
  });

  test("old disabled output plus parked busy prompt is still not delivered", () => {
    const before = "✶ Working… (esc to interrupt)\n  The /model slash command is disabled.";
    const res = evaluateDelivery({
      before,
      afterTyped: `${before}\n> /model`,
      after: "✻ Working… (esc to interrupt)\n  The /model slash command is disabled.\n> /model",
      prompt: "/model",
    });
    expect(res.delivered).toBe(false);
    expect(res.handledOutput).toBe(false);
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

  test("historical working text does not make a submitted active turn look parked", () => {
    const prompt = "Finish validation and report changed files summary";
    const before = `
Earlier transcript:
• Working through prior validation notes.
• Ran git diff --stat

──────────────────────────────────────────────────────────────────────────────

• Pursuing goal (18m • esc to interrupt)

› Use /skills to list available skills

  gpt-5.5 xhigh fast · account007 · 5h 37% left · Main [default]       Goal achieved (21s)
`;
    const afterTyped = `${before}
› ${prompt}`;
    const after = `
Earlier transcript:
• Working through prior validation notes.
• Ran git diff --stat

User
${prompt}

• Ran just check-fast -p codex-tui
  └ Finished dev profile

• Working (2m 58s • esc to interrupt)


› Use /skills to list available skills

  gpt-5.5 xhigh fast · account007 · 5h 37% left · Main [default]       Pursuing goal (2m)
`;

    const res = evaluateDelivery({ before, afterTyped, after, prompt });
    expect(res.delivered).toBe(true);
    expect(res.reason).toMatch(/advanced|working|acted on|composer/i);
  });

  test("existing busy queue plus newly appended prompt is delivered", () => {
    const prompt = "add the missing adversarial regression";
    const before = `✶ Working… (esc to interrupt)
Messages to be submitted after next tool call:
  old queued task`;
    const afterTyped = `${before}
> ${prompt}`;
    const after = `✶ Working… (esc to interrupt)
Messages to be submitted after next tool call:
  old queued task
  ${prompt}`;

    const res = evaluateDelivery({ before, afterTyped, after, prompt });
    expect(res.delivered).toBe(true);
    expect(res.queued).toBe(true);
    expect(res.reason).toMatch(/queued/i);
  });

  test("long parked composer remains not delivered even when it pushes busy text out of the live tail", () => {
    const prompt = `START ${Array.from({ length: 35 }, (_, i) => `line-${i}`).join("\n")} FINAL_UNSENT_MARKER`;
    const before = "✶ Working… (esc to interrupt)\n  running previous task";
    const afterTyped = `${before}
› ${prompt}`;
    const after = `✻ Working… (esc to interrupt)
  running previous task
› ${prompt}`;

    const res = evaluateDelivery({ before, afterTyped, after, prompt });
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
