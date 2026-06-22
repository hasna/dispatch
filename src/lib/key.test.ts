import { describe, expect, test } from "bun:test";
import { performKeyDispatch, normalizeSpecialKey } from "./key.js";
import { Store } from "./store.js";
import { Tmux } from "./tmux.js";
import { MockRunner } from "../test/mock-runner.js";

const codewithComposerCapture = `
╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (v0.1.42)                             │
│ model:       gpt-5.5 xhigh   fast   /model to change    │
│ directory:   ~/workspace/hasna/opensource/open-dispatch │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
› Fix native chat
`;

function runner(command: string, capture = "> idle composer", processTree = ""): MockRunner {
  const r = new MockRunner();
  r.responder = (argv) => {
    if (argv[1] === "list-panes") return { stdout: "%1\n", stderr: "", exitCode: 0, source: "local" };
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_current_command}") {
      return { stdout: `${command}\n`, stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_in_mode}") {
      return { stdout: "0\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[1] === "display-message" && argv.at(-1) === "#{pane_pid}") {
      return { stdout: "1234\n", stderr: "", exitCode: 0, source: "local" };
    }
    if (argv[0] === "ps") return { stdout: processTree, stderr: "", exitCode: processTree ? 0 : 1, source: "local" };
    if (argv[1] === "capture-pane") return { stdout: capture, stderr: "", exitCode: 0, source: "local" };
    return { stdout: "", stderr: "", exitCode: 0, source: "local" };
  };
  return r;
}

describe("normalizeSpecialKey", () => {
  test("normalizes safe aliases", () => {
    expect(normalizeSpecialKey("enter")).toBe("Enter");
    expect(normalizeSpecialKey("Tab")).toBe("Tab");
    expect(normalizeSpecialKey("esc")).toBe("Escape");
    expect(normalizeSpecialKey("ArrowUp")).toBe("Up");
    expect(normalizeSpecialKey("page-down")).toBe("PageDown");
  });

  test("rejects control keys and arbitrary tmux key names", () => {
    expect(normalizeSpecialKey("C-c")).toBeUndefined();
    expect(normalizeSpecialKey("C-z")).toBeUndefined();
    expect(normalizeSpecialKey("F12")).toBeUndefined();
    expect(normalizeSpecialKey("; rm -rf /")).toBeUndefined();
  });
});

describe("performKeyDispatch", () => {
  test("sends an allowlisted key to a direct agent composer and records it", async () => {
    const r = runner("codewith");
    const store = new Store(":memory:");
    const rec = await performKeyDispatch({ target: "work:agent", key: "Tab" }, { tmux: new Tmux(r), store });

    expect(rec.kind).toBe("key");
    expect(rec.status).toBe("delivered");
    expect(rec.prompt).toBe("<key:Tab>");
    expect(store.getDispatch(rec.id)!.prompt).toBe("<key:Tab>");
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("Tab"))).toBe(true);
    store.close();
  });

  test("accepts node wrapped Codewith composers only when pane content proves it", async () => {
    const r = runner(
      "node",
      codewithComposerCapture,
      "1234 1 Ss /usr/bin/bash\n1240 1234 Sl+ node /home/hasna/.bun/bin/codewith\n",
    );
    const rec = await performKeyDispatch({ target: "work:node", key: "Enter" }, { tmux: new Tmux(r) });

    expect(rec.status).toBe("delivered");
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("Enter"))).toBe(true);
  });

  test("skips disallowed keys before target inspection or delivery", async () => {
    const r = runner("codewith");
    const rec = await performKeyDispatch({ target: "work:agent", key: "C-c\nEnter" }, { tmux: new Tmux(r) });

    expect(rec.status).toBe("skipped");
    expect(rec.detail).toMatch(/not allowlisted/i);
    expect(rec.detail).toContain('"C-c\\nEnter"');
    expect(rec.detail).not.toContain("C-c\nEnter");
    expect(r.argvs()).toHaveLength(0);
  });

  test("refuses shell panes", async () => {
    const r = runner("bash");
    const rec = await performKeyDispatch({ target: "work:shell", key: "Enter" }, { tmux: new Tmux(r) });

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/shell.*dispatch exec/i);
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("Enter"))).toBe(false);
  });

  test("refuses arbitrary node panes", async () => {
    const r = runner("node", "node server.js\nListening on 3000\n");
    const rec = await performKeyDispatch({ target: "work:node", key: "Tab" }, { tmux: new Tmux(r) });

    expect(rec.status).toBe("failed");
    expect(rec.detail).toMatch(/not a recognized agent composer/i);
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("Tab"))).toBe(false);
  });
});
