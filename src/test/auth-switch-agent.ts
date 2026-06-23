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

let buf = "";
let queued = false;
process.stdin.on("data", (chunk: Buffer) => {
  if (file) appendFileSync(file, chunk);
  buf += chunk.toString("utf8");
  const text = buf.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n\t]+/g, " ").trim();
  if (!queued && text.length > 0) {
    queued = true;
    process.stdout.write("\nAuto-switching auth profile to account010...\n");
    process.stdout.write("Your prompt will continue with that account\n");
    process.stdout.write("Queued follow-up inputs:\n");
    process.stdout.write(`  ${text}\n`);
  }
});

setInterval(() => {}, 1 << 30);
