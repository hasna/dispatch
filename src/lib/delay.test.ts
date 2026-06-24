import { afterEach, describe, expect, test } from "bun:test";
import { computeSubmitDelay, countWords } from "./delay.js";

describe("countWords", () => {
  test("counts whitespace-delimited words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords("hello")).toBe(1);
    expect(countWords("hello world")).toBe(2);
    expect(countWords("a\nb\tc   d")).toBe(4);
  });
});

describe("computeSubmitDelay", () => {
  test("empty prompt gets the floor", () => {
    expect(computeSubmitDelay("")).toBe(400);
    expect(computeSubmitDelay("", { minMs: 150 })).toBe(150);
  });

  test("longer prompts get longer delays (monotonic)", () => {
    const short = computeSubmitDelay("write a function");
    const medium = computeSubmitDelay("write a function ".repeat(20));
    const long = computeSubmitDelay("write a function ".repeat(200));
    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
  });

  test("clamps to max", () => {
    const huge = "word ".repeat(100000);
    expect(computeSubmitDelay(huge, { maxMs: 4000 })).toBe(4000);
  });

  test("never below min even with custom coefficients", () => {
    expect(computeSubmitDelay("x", { minMs: 500, msPerWord: 0, msPerChar: 0 })).toBe(500);
  });

  test("respects explicit coefficients", () => {
    // min 100 + 2 words*10 + 11 chars*0 = 120
    expect(computeSubmitDelay("hello world", { minMs: 100, msPerWord: 10, msPerChar: 0 })).toBe(120);
  });

  describe("env overrides", () => {
    afterEach(() => {
      delete process.env.DISPATCH_MIN_DELAY_MS;
      delete process.env.DISPATCH_MAX_DELAY_MS;
    });
    test("DISPATCH_MIN_DELAY_MS raises the floor", () => {
      process.env.DISPATCH_MIN_DELAY_MS = "777";
      expect(computeSubmitDelay("")).toBe(777);
    });
    test("DISPATCH_MAX_DELAY_MS lowers the ceiling", () => {
      process.env.DISPATCH_MAX_DELAY_MS = "200";
      expect(computeSubmitDelay("word ".repeat(10000))).toBe(200);
    });
  });
});
