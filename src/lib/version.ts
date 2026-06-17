import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the package version from the nearest package.json, walking up from the
 * compiled module location. Works in both `src` (dev) and `dist` (published).
 */
export function getPackageVersion(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "@hasna/dispatch" && pkg.version) return pkg.version;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}
