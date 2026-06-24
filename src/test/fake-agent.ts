#!/usr/bin/env bun
/**
 * Test fixture: a minimal stand-in for a coding-agent TUI launched through bun.
 * It shows a Codewith-like idle composer, and when it receives a submitted line
 * (Enter) it clears the composer line and prints a "working / esc to interrupt"
 * footer — exactly the transition delivery-confirmation looks for.
 */
process.stdout.write(`╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (test fixture)                        │
│                                                         │
│ model:       test-model                                 │
│ directory:   ${process.cwd()} │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
› awaiting prompt — idle
`);
process.stdout.write("\x1b[?2004h"); // enable bracketed paste

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let working = false;
let inPaste = false;
let pending = "";

function visiblePending(text: string): string {
  if (text.length > 200 || text.includes("\n")) {
    const lines = Math.max(0, text.split("\n").length - 1);
    return lines > 0 ? `[Pasted text +${lines} lines]` : "[Pasted text]";
  }
  return text;
}

function renderPending(): void {
  if (working || pending.length === 0) return;
  process.stdout.write(`\n› ${visiblePending(pending)}\n`);
}

function submitPending(): void {
  if (working) return;
  working = true;
  process.stdout.write("\x1b[2K\r");
  process.stdout.write("\n✶ Working… (esc to interrupt)\n");
}

process.stdin.on("data", (chunk: Buffer) => {
  const s = chunk.toString("utf8");
  let changed = false;
  for (let i = 0; i < s.length; i += 1) {
    if (s.startsWith("\x1b[200~", i)) {
      inPaste = true;
      i += "\x1b[200~".length - 1;
      continue;
    }
    if (s.startsWith("\x1b[201~", i)) {
      inPaste = false;
      i += "\x1b[201~".length - 1;
      changed = true;
      continue;
    }
    const ch = s[i]!;
    if (!inPaste && (ch === "\n" || ch === "\r")) {
      submitPending();
      continue;
    }
    pending += ch;
    changed = true;
  }
  if (changed) renderPending();
});

setInterval(() => {}, 1 << 30);
