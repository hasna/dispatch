import { describe, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildProgram } from "./index.js";
import { formatRecord, formatSchedule, resolvePrompt } from "./format.js";
import { DispatchClient } from "../sdk/index.js";
import { Store } from "../lib/store.js";

describe("resolvePrompt", () => {
  test("prefers --prompt", () => {
    expect(resolvePrompt({ prompt: "inline", file: "/nope" })).toBe("inline");
  });
  test("reads --file", () => {
    const f = join(tmpdir(), `dispatch_prompt_${process.pid}.txt`);
    writeFileSync(f, "from file");
    expect(resolvePrompt({ file: f })).toBe("from file");
    rmSync(f);
  });
  test("falls back to stdin", () => {
    expect(resolvePrompt({}, "piped prompt")).toBe("piped prompt");
  });
  test("throws when no source", () => {
    expect(() => resolvePrompt({})).toThrow(/no prompt/);
  });
});

describe("formatters", () => {
  test("formatRecord shows icon, id, status, target, preview", () => {
    const line = formatRecord({
      id: "abc123abc123",
      target: "work:agent",
      machine: "local",
      prompt: "do the thing",
      status: "delivered",
      detail: "working detected",
      createdAt: "x",
      updatedAt: "x",
    });
    expect(line).toContain("✓");
    expect(line).toContain("abc123abc123");
    expect(line).toContain("work:agent");
    expect(line).toContain("do the thing");
  });
  test("formatSchedule shows cron and next run", () => {
    const line = formatSchedule({
      id: "s1",
      options: { target: "work:agent", prompt: "later" },
      cron: "*/5 * * * *",
      nextRun: "2026-06-17T10:05:00.000Z",
      status: "scheduled",
      createdAt: "x",
      updatedAt: "x",
    });
    expect(line).toContain("cron(*/5 * * * *)");
    expect(line).toContain("2026-06-17T10:05:00.000Z");
  });
});

function runner() {
  const store = new Store(":memory:");
  const client = new DispatchClient({ store });
  const out: string[] = [];
  const err: string[] = [];
  const program = buildProgram({
    clientFactory: () => client,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { store, client, out, err, program };
}

describe("CLI read/schedule commands (in-memory client)", () => {
  test("status: found and not-found", async () => {
    const { store, program, out, err } = runner();
    const rec = store.createDispatch({ target: "s:w", prompt: "hi", status: "delivered" });
    await program.parseAsync(["status", rec.id], { from: "user" });
    expect(out.join("\n")).toContain(rec.id);

    process.exitCode = 0;
    await program.parseAsync(["status", "missing"], { from: "user" });
    expect(err.join("\n")).toMatch(/not found/);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  test("list --json returns recorded dispatches", async () => {
    const { store, program, out } = runner();
    store.createDispatch({ target: "s:w", prompt: "a", status: "delivered" });
    store.createDispatch({ target: "s:w", prompt: "b", status: "failed" });
    await program.parseAsync(["list", "--json"], { from: "user" });
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveLength(2);
  });

  test("schedule then schedules then cancel", async () => {
    const { program, out } = runner();
    await program.parseAsync(
      ["schedule", "--to", "work:agent", "--prompt", "later", "--cron", "*/5 * * * *", "--json"],
      { from: "user" },
    );
    const sched = JSON.parse(out.join("\n"));
    expect(sched.status).toBe("scheduled");
    out.length = 0;

    await program.parseAsync(["schedules", "--json"], { from: "user" });
    expect(JSON.parse(out.join("\n"))).toHaveLength(1);
    out.length = 0;

    await program.parseAsync(["cancel", sched.id], { from: "user" });
    expect(out.join("\n")).toContain("cancelled");
  });

  test("schedule rejects missing at/cron", async () => {
    const { program } = runner();
    await expect(
      program.parseAsync(["schedule", "--to", "s:w", "--prompt", "x"], { from: "user" }),
    ).rejects.toThrow(/at.*cron/);
  });
});
