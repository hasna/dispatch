#!/usr/bin/env bun
/**
 * Test fixture: a stand-in coding agent that BOTH records exactly what it
 * receives (to verify a long prompt arrives intact) AND enters a working state
 * on submit (so delivery confirmation has something to detect). It enables
 * bracketed-paste mode so tmux wraps pasted content in ESC[200~ … ESC[201~.
 *
 * Usage: bun run recorder-agent.ts <outfile>
 */
import { appendFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: recorder-agent.ts <outfile>");
  process.exit(2);
}

writeFileSync(file, "");
process.stdout.write("> idle — awaiting prompt\n");
process.stdout.write("\x1b[?2004h"); // enable bracketed paste

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let sawPasteEnd = false;
let working = false;
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(file, chunk);
  const s = chunk.toString("utf8");
  if (s.includes("\x1b[201~")) sawPasteEnd = true;
  // Enter the working state once we get a submit (a bare CR/LF after the paste,
  // or any line break for short literal sends).
  if (!working && (sawPasteEnd ? /[\r\n]/.test(s.replace(/\x1b\[20[01]~/g, "")) : /[\r\n]/.test(s))) {
    working = true;
    process.stdout.write("\n✶ Working… (esc to interrupt)\n");
  }
});

setInterval(() => {}, 1 << 30);
