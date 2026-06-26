import { describe, expect, test } from "bun:test";
import { chooseMode, performDispatch } from "./engine.js";
import { Tmux } from "./tmux.js";
import { Store } from "./store.js";
import { MockRunner } from "../test/mock-runner.js";

const noSleep = async () => {};

describe("chooseMode", () => {
  test("multiline always pastes", () => {
    expect(chooseMode("a\nb")).toBe("paste");
  });
  test("short single line is literal", () => {
    expect(chooseMode("hello world")).toBe("literal");
  });
  test("very long single line pastes", () => {
    expect(chooseMode("x".repeat(2000))).toBe("paste");
  });
  test("explicit mode wins", () => {
    expect(chooseMode("a\nb", "literal")).toBe("literal");
    expect(chooseMode("short", "paste")).toBe("paste");
  });
});

/**
 * Build a MockRunner that simulates a TUI: capture-pane returns an idle
 * composer until an Enter key is sent, after which it returns a working footer.
 */
function tuiRunner(): MockRunner {
  const r = new MockRunner();
  let submitted = false;
  r.responder = (argv) => {
    if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
      return { stdout: "codewith\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "send-keys" && argv.includes("Enter")) {
      submitted = true;
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "capture-pane") {
      const stdout = submitted ? "✶ Working… (esc to interrupt)" : "> idle composer";
      return { stdout, stderr: "", exitCode: 0, source: "local" };
    }
    return { stdout: "", stderr: "", exitCode: 0, source: "local" };
  };
  return r;
}

describe("performDispatch", () => {
  test("refuses prompt delivery to detected shell panes before text with parentheses can hit bash", async () => {
    const r = new MockRunner();
    r.responder = (argv) => {
      if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
      if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
        return { stdout: "bash\n", stderr: "", exitCode: 0, source: "local" };
      }
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };

    const rec = await performDispatch(
      { target: "live-codewith:0", prompt: "Refactor parser (but do not interrupt)" },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/shell.*dispatch exec/i);
    expect(r.argvs().some((a) => a[1] === "send-keys" || a[1] === "paste-buffer")).toBe(false);
  });

  test("refuses prompt delivery to unknown non-agent panes", async () => {
    const r = new MockRunner();
    r.responder = (argv) => {
      if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
      if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
        return { stdout: "vim\n", stderr: "", exitCode: 0, source: "local" };
      }
      if (argv[1] === "capture-pane") return { stdout: "-- INSERT --", stderr: "", exitCode: 0, source: "local" };
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };

    const rec = await performDispatch(
      { target: "work:editor", prompt: "Refactor parser (but do not interrupt)" },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/not a recognized agent composer/i);
    expect(r.argvs().some((a) => a[1] === "send-keys" || a[1] === "paste-buffer")).toBe(false);
  });

  for (const wrapperCommand of ["node", "bun"]) {
    test(`delivers to an idle Codewith composer running under a ${wrapperCommand} wrapper`, async () => {
      const r = new MockRunner();
      const codewithPane = `
╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (v0.1.42)                             │
│                                                         │
│ model:       gpt-5.5 xhigh   fast   /model to change    │
│ directory:   ~/workspace/hasna/opensource/open-codewith │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯

›

  gpt-5.5 xhigh fast · account013 · 5h 55% left
${"\n".repeat(32)}`;

      r.responder = (argv) => {
        if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
        if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
          return { stdout: `${wrapperCommand}\n`, stderr: "", exitCode: 0, source: "local" };
        }
        if (argv[1] === "display-message" && argv.at(-1) === "#{pane_in_mode}") {
          return { stdout: "0\n", stderr: "", exitCode: 0, source: "local" };
        }
        if (argv[1] === "capture-pane") return { stdout: codewithPane, stderr: "", exitCode: 0, source: "local" };
        return { stdout: "", stderr: "", exitCode: 0, source: "local" };
      };

      const rec = await performDispatch(
        { target: "open-codewith-04:1.1", prompt: "Harmless smoke prompt", submit: false },
        { tmux: new Tmux(r), sleep: noSleep },
      );

      expect(rec.status).toBe("delivered");
      expect(rec.detail).toMatch(/without submitting/);
      expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("-l"))).toBe(true);
    });
  }

  test("still refuses arbitrary node panes", async () => {
    const r = new MockRunner();
    r.responder = (argv) => {
      if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
      if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
        return { stdout: "node\n", stderr: "", exitCode: 0, source: "local" };
      }
      if (argv[1] === "capture-pane") {
        return {
          stdout: 'Welcome to Node.js v22.0.0.\nType ".help" for more information.\n> ',
          stderr: "",
          exitCode: 0,
          source: "local",
        };
      }
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };

    const rec = await performDispatch(
      { target: "work:node", prompt: "Do not type this", submit: false },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/not a recognized agent composer.*node/i);
    expect(r.argvs().some((a) => a[1] === "send-keys" || a[1] === "paste-buffer")).toBe(false);
  });

  test("delivers + confirms against a simulated TUI and records it", async () => {
    const r = tuiRunner();
    const store = new Store(":memory:");
    const rec = await performDispatch(
      { target: "work:agent", prompt: "Refactor the parser and add tests" },
      { tmux: new Tmux(r), store, sleep: noSleep },
    );
    expect(rec.status).toBe("delivered");
    expect(rec.confirm?.delivered).toBe(true);
    expect(rec.submitDelayMs).toBeGreaterThan(0);
    expect(rec.deliveredAt).toBeDefined();
    // persisted
    expect(store.getDispatch(rec.id)!.status).toBe("delivered");
    store.close();
  });

  test("fails cleanly when the target pane does not exist", async () => {
    const r = new MockRunner();
    r.responder = (argv) => ({
      stdout: "",
      stderr: argv[1] === "list-panes" ? "can't find window" : "",
      exitCode: argv[1] === "list-panes" ? 1 : 0,
      source: "local",
    });
    const rec = await performDispatch(
      { target: "nope:0", prompt: "hi" },
      { tmux: new Tmux(r), sleep: noSleep },
    );
    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/target pane not found/);
  });

  test("multiline prompt uses bracketed paste (load-buffer + paste-buffer)", async () => {
    const r = tuiRunner();
    await performDispatch(
      { target: "work:agent", prompt: "line one\nline two\nline three" },
      { tmux: new Tmux(r), sleep: noSleep },
    );
    const argvs = r.argvs();
    expect(argvs.some((a) => a[1] === "load-buffer")).toBe(true);
    expect(argvs.some((a) => a[1] === "paste-buffer" && a.includes("-p"))).toBe(true);
  });

  test("short prompt uses literal send-keys", async () => {
    const r = tuiRunner();
    await performDispatch(
      { target: "work:agent", prompt: "do it" },
      { tmux: new Tmux(r), sleep: noSleep },
    );
    const argvs = r.argvs();
    expect(argvs.some((a) => a[1] === "send-keys" && a.includes("-l"))).toBe(true);
  });

  test("submit:false types without pressing Enter", async () => {
    const r = tuiRunner();
    const rec = await performDispatch(
      { target: "work:agent", prompt: "draft this", submit: false },
      { tmux: new Tmux(r), sleep: noSleep },
    );
    expect(rec.status).toBe("delivered");
    expect(rec.detail).toMatch(/without submitting/);
    expect(r.argvs().some((a) => a.includes("Enter"))).toBe(false);
  });

  test("confirm:false marks delivered without probing", async () => {
    const r = tuiRunner();
    const rec = await performDispatch(
      { target: "work:agent", prompt: "go", confirm: false },
      { tmux: new Tmux(r), sleep: noSleep },
    );
    expect(rec.status).toBe("delivered");
    expect(rec.detail).toMatch(/confirmation disabled/);
  });

  test("explicit submitDelayMs overrides the auto delay", async () => {
    const r = tuiRunner();
    const rec = await performDispatch(
      { target: "work:agent", prompt: "go now", submitDelayMs: 42 },
      { tmux: new Tmux(r), sleep: noSleep },
    );
    expect(rec.submitDelayMs).toBe(42);
  });

  test("disabled slash-command output is confirmed without Enter retries", async () => {
    const r = new MockRunner();
    let typed = false;
    let enterCount = 0;
    r.responder = (argv) => {
      if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
      if (argv[1] === "display-message") return { stdout: "codewith\n", stderr: "", exitCode: 0, source: "local" };
      if (argv[1] === "send-keys" && argv.includes("-l")) {
        typed = true;
        return { stdout: "", stderr: "", exitCode: 0, source: "local" };
      }
      if (argv[1] === "send-keys" && argv.includes("Enter")) {
        enterCount += 1;
        return { stdout: "", stderr: "", exitCode: 0, source: "local" };
      }
      if (argv[1] === "capture-pane") {
        const stdout =
          enterCount > 0
            ? "✻ Working… (esc to interrupt)\nThe /workflow slash command is disabled while a response is streaming.\n> /workflow"
            : typed
              ? "✶ Working… (esc to interrupt)\n> /workflow"
              : "✶ Working… (esc to interrupt)";
        return { stdout, stderr: "", exitCode: 0, source: "local" };
      }
      return { stdout: "", stderr: "", exitCode: 0, source: "local" };
    };

    const rec = await performDispatch(
      { target: "work:agent", prompt: "/workflow", submitDelayMs: 0 },
      { tmux: new Tmux(r), sleep: noSleep },
    );

    expect(rec.status).toBe("delivered");
    expect(rec.confirm?.handledOutput).toBe(true);
    expect(rec.detail).toMatch(/disabled|rejection/i);
    expect(enterCount).toBe(1);
  });
});
