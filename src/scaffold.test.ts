import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageVersion } from "./lib/version.js";
import { dataDir, dbPath } from "./lib/paths.js";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as Record<string, any>;

describe("scaffold", () => {
  test("package metadata is correct", () => {
    expect(pkg.name).toBe("@hasna/dispatch");
    expect(pkg.type).toBe("module");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.publishConfig.access).toBe("public");
  });

  test("exposes the three binaries", () => {
    expect(pkg.bin.dispatch).toBeDefined();
    expect(pkg.bin["dispatch-mcp"]).toBeDefined();
    expect(pkg.bin["dispatch-daemon"]).toBeDefined();
  });

  test("getPackageVersion resolves the real version", () => {
    expect(getPackageVersion()).toBe(pkg.version);
  });

  test("paths resolve under the data dir", () => {
    expect(dbPath().startsWith(dataDir())).toBe(true);
  });
});
