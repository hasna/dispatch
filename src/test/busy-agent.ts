#!/usr/bin/env bun
/**
 * Test fixture: a coding agent that is ALREADY BUSY (running a tool call) when a
 * prompt arrives, like Codewith/Claude Code mid-task. It shows a Codewith-like
 * banner plus working footer from the start and, on receiving input, stages it
 * under a "Messages to be submitted after next tool call" queue while staying
 * busy — it never clears the composer and never starts a fresh working
 * indicator. This is the case that used to be misreported as "not delivered".
 */
import { appendFileSync, writeFileSync } from "node:fs";

const file = process.argv[2]; // optional: record what was received
if (file) writeFileSync(file, "");

process.stdout.write("\x1b[?2004h"); // enable bracketed paste
process.stdout.write(`╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (test fixture)                        │
│                                                         │
│ model:       test-model                                 │
│ directory:   ${process.cwd()} │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
`);
process.stdout.write("● Working on the previous task… (esc to interrupt)\n");
process.stdout.write("  running a tool call\n");

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let queued = false;
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
  if (queued || pending.length === 0) return;
  process.stdout.write(`\n› ${visiblePending(pending)}\n`);
}

function queuePending(): void {
  if (queued || pending.trim().length === 0) return;
  queued = true;
  const text = pending.replace(/[\r\n]+/g, " ").trim();
  process.stdout.write("\nMessages to be submitted after next tool call:\n");
  process.stdout.write(`  ${text}\n`);
}

process.stdin.on("data", (chunk: Buffer) => {
  if (file) appendFileSync(file, chunk);
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
    if (!inPaste && ch === "\t") {
      queuePending();
      continue;
    }
    pending += ch;
    changed = true;
  }
  if (changed) renderPending();
});

setInterval(() => {}, 1 << 30);
