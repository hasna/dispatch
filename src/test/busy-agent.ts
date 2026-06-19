#!/usr/bin/env bun
/**
 * Test fixture: a coding agent that is ALREADY BUSY (running a tool call) when a
 * prompt arrives, like Codewith/Claude Code mid-task. It shows a working footer
 * from the start and, on receiving input, stages it under a "Messages to be
 * submitted after next tool call" queue while staying busy — it never clears the
 * composer and never starts a fresh working indicator. This is the case that
 * used to be misreported as "not delivered".
 */
import { appendFileSync, writeFileSync } from "node:fs";

const file = process.argv[2]; // optional: record what was received
if (file) writeFileSync(file, "");

process.stdout.write("\x1b[?2004h"); // enable bracketed paste
process.stdout.write("● Working on the previous task… (esc to interrupt)\n");
process.stdout.write("  running a tool call\n");

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let buf = "";
let queued = false;
process.stdin.on("data", (chunk: Buffer) => {
  if (file) appendFileSync(file, chunk);
  buf += chunk.toString("utf8");
  // Strip bracketed-paste markers + control bytes to recover the message text.
  const text = buf.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n]+/g, " ").trim();
  if (!queued && text.length > 0) {
    queued = true;
    process.stdout.write("\nMessages to be submitted after next tool call:\n");
    process.stdout.write(`  ${text}\n`);
  }
});

setInterval(() => {}, 1 << 30);
