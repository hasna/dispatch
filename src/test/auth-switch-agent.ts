#!/usr/bin/env bun
/**
 * Test fixture: a Codewith-like active pane that accepts queued follow-up input
 * while an auth-profile auto-switch is visible. The queued input intentionally
 * never drains, matching the production failure mode where dispatch must report
 * action-needed instead of delivered.
 */
import { appendFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (file) writeFileSync(file, "");

process.stdout.write("\x1b[?2004h");
process.stdout.write(`╭─────────────────────────────────────────────────────────╮
│ ⎔  Hasna Codewith (test fixture)                        │
│                                                         │
│ model:       test-model                                 │
│ directory:   ${process.cwd()} │
│ permissions: YOLO mode                                  │
╰─────────────────────────────────────────────────────────╯
`);
process.stdout.write("● Working on the previous task… (esc to interrupt)\n");
process.stdout.write("  checking account limits\n");

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
  const text = pending.replace(/[\r\n\t]+/g, " ").trim();
  process.stdout.write("\nAuto-switching auth profile to account010...\n");
  process.stdout.write("Your prompt will continue with that account\n");
  process.stdout.write("Queued follow-up inputs:\n");
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
