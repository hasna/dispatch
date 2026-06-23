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

const activeCodewithCapture = `
• Working (38s • esc to interrupt)

› Find and fix a bug in @filename

  gpt-5.5 xhigh fast · 5h 90% left · account010 · Main [default]      Pursuing goal (10s)
`;

const codewithProcessTree = `
1234 1 Ss /usr/bin/bash
1240 1234 Sl+ node /home/hasna/.bun/bin/codewith --auth-profile account005
1241 1240 Sl+ /home/hasna/.bun/install/global/node_modules/@hasna/codewith/node_modules/@hasna/codewith-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codewith --auth-profile account005
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

  test("refuses Enter key on active agents by default", async () => {
    const r = runner("node", activeCodewithCapture, codewithProcessTree);
    const rec = await performKeyDispatch({ target: "open-dispatch:1.1", key: "Enter" }, { tmux: new Tmux(r) });

    expect(rec.status).toBe("skipped");
    expect(rec.detection).toMatchObject({ agentKind: "codewith", composerState: "active", canQueuePrompt: true });
    expect(rec.detail).toMatch(/refusing Enter key/);
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("Enter"))).toBe(false);
  });

  test("allows Tab key on active Codewith agents with proven queue support", async () => {
    const r = runner("node", activeCodewithCapture, codewithProcessTree);
    const rec = await performKeyDispatch({ target: "open-dispatch:1.1", key: "Tab" }, { tmux: new Tmux(r) });

    expect(rec.status).toBe("delivered");
    expect(rec.detection).toMatchObject({ agentKind: "codewith", composerState: "active", canQueuePrompt: true });
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("Tab"))).toBe(true);
  });

  test("refuses Tab key on active agents without queue support", async () => {
    const r = runner("codex", "✶ Working… (esc to interrupt)");
    const rec = await performKeyDispatch({ target: "work:codex", key: "Tab" }, { tmux: new Tmux(r) });

    expect(rec.status).toBe("skipped");
    expect(rec.detection).toMatchObject({ agentKind: "codex", composerState: "active", canQueuePrompt: false });
    expect(rec.detail).toMatch(/does not advertise Tab support/);
    expect(r.argvs().some((a) => a[1] === "send-keys" && a.includes("Tab"))).toBe(false);
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
