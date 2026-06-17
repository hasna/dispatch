import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRunner } from "./runner.js";
import { Tmux } from "./tmux.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const SESSION = `dispatch_it_${process.pid}`;
// Target the session by name; tmux resolves to its active window/pane. This
// avoids assuming a base-index (the host may use base-index 1).
const TARGET = SESSION;
const tmux = new Tmux(new LocalRunner());

const d = tmuxAvailable ? describe : describe.skip;

async function settle(ms = 350): Promise<void> {
  await Bun.sleep(ms);
}

let fileCounter = 0;
const created: string[] = [];

/**
 * Deliver `payload` into a real pane by running `cat > file`, sending the
 * payload, flushing with Enter, then reading the file back. Returns the raw
 * bytes the pane's program actually received — a deterministic fidelity probe.
 */
async function captureViaCat(
  payload: string,
  deliver: (file: string) => void,
): Promise<string> {
  const file = join(tmpdir(), `${SESSION}_cap_${fileCounter++}.txt`);
  created.push(file);
  tmux.sendLiteral(TARGET, `cat > ${file}`);
  tmux.sendKey(TARGET, "Enter");
  await settle();
  deliver(file);
  await settle();
  tmux.sendKey(TARGET, "Enter"); // complete the final line
  await settle();
  const out = readFileSync(file, "utf8");
  tmux.sendKey(TARGET, "C-d"); // EOF -> cat exits, back to shell
  await settle();
  return out;
}

d("Tmux against a real tmux server", () => {
  beforeAll(() => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    // Start the default shell (no command) so we can run `cat` per test.
    const res = spawnSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "200", "-y", "50"], {
      encoding: "utf8",
    });
    if (res.status !== 0) throw new Error(`failed to create tmux session: ${res.stderr}`);
  });

  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", SESSION], { encoding: "utf8" });
    for (const f of created) {
      try {
        rmSync(f);
      } catch {
        /* ignore */
      }
    }
  });
  afterEach(async () => {
    await settle(150);
  });

  test("hasSession / paneExists detect the live session", () => {
    expect(tmux.hasSession(SESSION)).toBe(true);
    expect(tmux.paneExists(TARGET)).toBe(true);
    expect(tmux.hasSession(`${SESSION}_nope`)).toBe(false);
    expect(tmux.paneExists(`${SESSION}_nope`)).toBe(false);
  });

  test("sendLiteral delivers single-line text verbatim", async () => {
    const out = await captureViaCat("marker_alpha_42", () => tmux.sendLiteral(TARGET, "marker_alpha_42"));
    expect(out).toBe("marker_alpha_42\n");
  });

  test("paste delivers a long multi-line payload byte-for-byte (no corruption)", async () => {
    const payload = Array.from({ length: 40 }, (_, i) => `line_${i}: the quick brown fox jumps over ${i}`).join("\n");
    const out = await captureViaCat(payload, () => tmux.paste(TARGET, payload, { bracketed: false }));
    expect(out).toBe(payload + "\n");
  });

  test("bracketed paste wraps the payload in paste-mode markers for a paste-aware app", async () => {
    // A real TUI enables bracketed-paste mode; tmux then wraps `paste -p` content
    // in ESC[200~ ... ESC[201~ so embedded newlines are NOT treated as submits.
    const sink = join(import.meta.dir, "..", "test", "bracket-sink.ts");
    const file = join(tmpdir(), `${SESSION}_bracket_${fileCounter++}.txt`);
    created.push(file);
    tmux.sendLiteral(TARGET, `bun run ${sink} ${file}`);
    tmux.sendKey(TARGET, "Enter");
    await settle(800); // let bun start and enable mode 2004

    const payload = "alpha\nbeta\ngamma";
    tmux.paste(TARGET, payload, { bracketed: true });
    await settle(500);
    const out = readFileSync(file, "utf8");
    tmux.sendKey(TARGET, "C-c"); // kill the sink
    await settle();

    expect(out).toContain("\x1b[200~");
    expect(out).toContain("\x1b[201~");
    // At the pty byte level, paste line breaks arrive as CR; a bracketed-paste
    // -aware TUI treats them as text, not as submits. Normalize to compare.
    expect(out.replace(/\r/g, "\n")).toContain("alpha\nbeta\ngamma");
    expect(out.indexOf("\x1b[200~")).toBeLessThan(out.indexOf("alpha"));
    expect(out.indexOf("\x1b[201~")).toBeGreaterThan(out.indexOf("gamma"));
  });
});
