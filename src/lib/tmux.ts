import type { Runner } from "./runner.js";
import type { TmuxTarget } from "../types.js";

/**
 * Parse a tmux target string `session[:window[.pane]]` into its parts.
 * The session name may itself contain no `:`; window/pane are optional.
 */
export function parseTarget(target: string): TmuxTarget {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("Empty tmux target");
  const colon = trimmed.indexOf(":");
  if (colon === -1) return { session: trimmed };
  const session = trimmed.slice(0, colon);
  const rest = trimmed.slice(colon + 1);
  const dot = rest.indexOf(".");
  if (dot === -1) return { session, window: rest || undefined };
  return {
    session,
    window: rest.slice(0, dot) || undefined,
    pane: rest.slice(dot + 1) || undefined,
  };
}

/** Format a {@link TmuxTarget} back into a tmux target string. */
export function formatTarget(t: TmuxTarget): string {
  let s = t.session;
  if (t.window !== undefined) s += `:${t.window}`;
  if (t.pane !== undefined) s += `.${t.pane}`;
  return s;
}

let bufferCounter = 0;

/** Generate a process-unique tmux buffer name. */
export function nextBufferName(): string {
  bufferCounter += 1;
  return `dispatch_${process.pid}_${bufferCounter}_${Math.floor(Math.random() * 1e6)}`;
}

/** Thin, testable wrapper over the tmux CLI, parameterized by a {@link Runner}. */
export class Tmux {
  constructor(private readonly runner: Runner) {}

  get machine(): string {
    return this.runner.machine;
  }

  private tmux(args: string[], input?: string) {
    return this.runner.run(["tmux", ...args], input);
  }

  /** Whether the tmux server is reachable on the target machine. */
  serverRunning(): boolean {
    return this.tmux(["list-sessions"]).exitCode === 0;
  }

  /** Whether a session exists. */
  hasSession(session: string): boolean {
    return this.tmux(["has-session", "-t", session]).exitCode === 0;
  }

  /**
   * Whether a full target (session:window.pane) resolves to a live pane.
   * Uses list-panes, which fails cleanly on a bad target — unlike
   * display-message, which silently falls back to the current pane.
   */
  paneExists(target: string): boolean {
    const res = this.tmux(["list-panes", "-t", target, "-F", "#{pane_id}"]);
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  /**
   * Capture the visible (or scrollback) contents of a pane as plain text.
   * `start` is the number of scrollback lines to include above the visible area.
   */
  capturePane(target: string, opts: { start?: number } = {}): string {
    const args = ["capture-pane", "-t", target, "-p"];
    if (opts.start && opts.start > 0) args.push("-S", String(-opts.start));
    const res = this.tmux(args);
    if (res.exitCode !== 0) {
      throw new Error(`capture-pane failed for ${target}: ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return res.stdout;
  }

  /**
   * Enumerate dispatchable targets (every pane across all sessions) on this
   * machine, so an agent can discover where to send a prompt.
   */
  listTargets(): { target: string; window: string; active: boolean }[] {
    const res = this.tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{pane_active}",
    ]);
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [target = "", window = "", active = "0"] = line.split("\t");
        return { target, window, active: active.trim() === "1" };
      });
  }

  /** Read a pane property via display-message, e.g. "pane_in_mode". */
  paneProperty(target: string, property: string): string {
    const res = this.tmux(["display-message", "-p", "-t", target, `#{${property}}`]);
    return res.exitCode === 0 ? res.stdout.replace(/\n$/, "") : "";
  }

  /** Whether the pane is in a tmux mode (copy-mode, view-mode, …). */
  paneInMode(target: string): boolean {
    return this.paneProperty(target, "pane_in_mode") === "1";
  }

  /**
   * Exit any active tmux mode (e.g. copy-mode from scrollback) on the pane.
   * While a pane is in copy-mode, send-keys/paste are interpreted as mode
   * commands rather than delivered to the program, so a dispatch would be
   * silently swallowed. Returns true if the pane was in a mode and was exited.
   */
  exitCopyMode(target: string): boolean {
    if (!this.paneInMode(target)) return false;
    this.tmux(["copy-mode", "-q", "-t", target]);
    return true;
  }

  /**
   * Send literal text to a pane (no key-name interpretation). Newlines in the
   * text are sent as Enter keypresses, so this is for short single-line text;
   * use {@link paste} for multi-line / long prompts.
   */
  sendLiteral(target: string, text: string): void {
    const res = this.tmux(["send-keys", "-t", target, "-l", "--", text]);
    if (res.exitCode !== 0) {
      throw new Error(`send-keys -l failed for ${target}: ${res.stderr.trim()}`);
    }
  }

  /** Send a named key (e.g. "Enter", "C-c", "Escape") to a pane. */
  sendKey(target: string, key: string): void {
    const res = this.tmux(["send-keys", "-t", target, key]);
    if (res.exitCode !== 0) {
      throw new Error(`send-keys ${key} failed for ${target}: ${res.stderr.trim()}`);
    }
  }

  /** Load text into a named tmux buffer (via stdin, so any size/content is safe). */
  loadBuffer(name: string, text: string): void {
    const res = this.tmux(["load-buffer", "-b", name, "-"], text);
    if (res.exitCode !== 0) {
      throw new Error(`load-buffer failed: ${res.stderr.trim()}`);
    }
  }

  /**
   * Paste a named buffer into a pane. `bracketed` wraps the content in
   * bracketed-paste escape sequences so the receiving TUI treats embedded
   * newlines as text rather than submits. `deleteAfter` frees the buffer.
   */
  pasteBuffer(target: string, name: string, opts: { bracketed?: boolean; deleteAfter?: boolean } = {}): void {
    const args = ["paste-buffer", "-t", target, "-b", name];
    if (opts.bracketed) args.push("-p");
    if (opts.deleteAfter) args.push("-d");
    const res = this.tmux(args);
    if (res.exitCode !== 0) {
      throw new Error(`paste-buffer failed for ${target}: ${res.stderr.trim()}`);
    }
  }

  /**
   * Paste arbitrary (possibly long, multi-line) text into a pane via a unique
   * buffer using bracketed paste. This is the corruption-free path for long
   * prompts: the whole text arrives as a single paste with no premature submit.
   */
  paste(target: string, text: string, opts: { bracketed?: boolean } = {}): void {
    const name = nextBufferName();
    this.loadBuffer(name, text);
    this.pasteBuffer(target, name, { bracketed: opts.bracketed ?? true, deleteAfter: true });
  }
}
