#!/usr/bin/env bun
/**
 * Test fixture: a tiny program that enables bracketed-paste mode (DECSET 2004)
 * and records every byte it receives on stdin to a file. Used by the tmux
 * integration test to verify that `paste -p` wraps content in bracketed-paste
 * markers when (and only when) the receiving app supports paste mode — the
 * behavior that prevents TUIs from submitting on embedded newlines.
 *
 * Usage: bun run bracket-sink.ts <outfile>
 */
import { appendFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: bracket-sink.ts <outfile>");
  process.exit(2);
}

writeFileSync(file, "");
// Tell the terminal (tmux) we understand bracketed paste.
process.stdout.write("\x1b[?2004h");

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(file, chunk);
});

// Stay alive until killed by the test (C-c).
setInterval(() => {}, 1 << 30);
