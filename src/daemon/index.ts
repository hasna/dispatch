#!/usr/bin/env bun
/**
 * @hasna/dispatch daemon — owns the scheduled-dispatch queue and delivery
 * tracking. Filled in by the daemon task.
 */
async function main(): Promise<void> {
  console.error("dispatch-daemon: not yet implemented");
  process.exit(1);
}

if (import.meta.main) {
  main();
}
