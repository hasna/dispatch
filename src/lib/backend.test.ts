import { describe, expect, test } from "bun:test";
import { normalizeBackend } from "./backend.js";

describe("normalizeBackend", () => {
  test("defaults to tmux", () => {
    expect(normalizeBackend(undefined, {})).toBe("tmux");
  });

  test("accepts explicit and env Mosaic selection", () => {
    expect(normalizeBackend("mosaic", {})).toBe("mosaic");
    expect(normalizeBackend(undefined, { DISPATCH_BACKEND: "mosaic" })).toBe("mosaic");
  });

  test("rejects unknown backends", () => {
    expect(() => normalizeBackend("screen", {})).toThrow(/unsupported dispatch backend/i);
  });
});

