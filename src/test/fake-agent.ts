#!/usr/bin/env bun
/**
 * Test fixture: a minimal stand-in for a coding-agent TUI. It shows an idle
 * composer, and when it receives a submitted line (Enter) it clears the
 * composer line and prints a "working / esc to interrupt" footer — exactly the
 * transition delivery-confirmation looks for.
 */
process.stdout.write("> awaiting prompt — idle\n");

if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let buf = "";
let working = false;
process.stdin.on("data", (chunk: Buffer) => {
  buf += chunk.toString("utf8");
  if (!working && (buf.includes("\n") || buf.includes("\r"))) {
    working = true;
    // Clear the current line (simulate the composer emptying) and show the
    // working footer.
    process.stdout.write("\x1b[2K\r");
    process.stdout.write("\n✶ Working… (esc to interrupt)\n");
  }
});

setInterval(() => {}, 1 << 30);
