import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Test-only launcher name so tmux reports fixture panes as direct agent commands. */
export function codewithFixtureLauncher(dir: string): string {
  const launcher = join(dir, "codewith");
  if (!existsSync(launcher)) symlinkSync(process.execPath, launcher);
  return launcher;
}
