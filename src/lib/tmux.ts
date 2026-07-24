import type { RunResult, Runner } from "./runner.js";
import type { TmuxTarget } from "../types.js";

export type RemoteTargetEnumerationErrorCategory = "auth" | "transport" | "remote_command";

function safeMachineLabel(machine: string): string {
  const trimmed = machine.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) ? trimmed : "remote";
}

function classifyRemoteTargetFailure(result: RunResult): RemoteTargetEnumerationErrorCategory {
  const diagnostic = `${result.stderr}\n${result.stdout}`.slice(0, 8192);
  if (result.exitCode === 124) return "transport";
  if (
    /authentication failed|unable to authenticate|too many authentication failures|no supported (?:authentication )?methods(?: remain)?|permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi[^,)]*)(?:,[^)]+)*\)/i.test(diagnostic)
  ) {
    return "auth";
  }
  if (
    result.exitCode === 255 ||
    /timed out|no route to host|network is unreachable|connection (?:refused|reset|closed)|could not resolve hostname|host key verification failed|remote host identification has changed|ssh(?:_exchange_identification|: handshake failed)|broken pipe/i.test(
      diagnostic,
    )
  ) {
    return "transport";
  }
  return "remote_command";
}

function isTmuxServerAbsent(result: RunResult): boolean {
  if (result.exitCode !== 1 || result.stdout.trim().length > 0) return false;
  const diagnostic = result.stderr.trim();
  return (
    /^no server running on [^\r\n]+$/i.test(diagnostic) ||
    /^error connecting to [^\r\n]+ \(No such file or directory\)$/i.test(diagnostic) ||
    /^failed to connect to server(?:: No such file or directory)?$/i.test(diagnostic)
  );
}

/**
 * A remote target-enumeration command did not complete successfully.
 *
 * The remote command's stdout/stderr are deliberately not retained: they can
 * contain pane targets, shell output, or credential diagnostics and must not be
 * surfaced by discovery APIs or the CLI.
 */
export class RemoteTargetEnumerationError extends Error {
  readonly name = "RemoteTargetEnumerationError";
  readonly code: "DISPATCH_REMOTE_AUTH_FAILED" | "DISPATCH_REMOTE_TRANSPORT_FAILED" | "DISPATCH_REMOTE_COMMAND_FAILED";
  readonly category: RemoteTargetEnumerationErrorCategory;
  readonly machine: string;
  readonly source: Exclude<RunResult["source"], "local">;
  readonly exitCode: number;

  constructor(input: {
    machine: string;
    source: Exclude<RunResult["source"], "local">;
    exitCode: number;
    category: RemoteTargetEnumerationErrorCategory;
  }) {
    super("remote target enumeration failed");
    this.category = input.category;
    this.code =
      input.category === "auth"
        ? "DISPATCH_REMOTE_AUTH_FAILED"
        : input.category === "transport"
          ? "DISPATCH_REMOTE_TRANSPORT_FAILED"
          : "DISPATCH_REMOTE_COMMAND_FAILED";
    this.machine = safeMachineLabel(input.machine);
    this.source = input.source;
    this.exitCode = Number.isInteger(input.exitCode) ? input.exitCode : 1;
  }

  toJSON() {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      machine: this.machine,
      source: this.source,
      exitCode: this.exitCode,
    };
  }
}

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

/** Strip embedded bracketed-paste boundary markers from user-controlled text. */
export function stripBracketedPasteMarkers(text: string): string {
  return text.replace(/\x1b\[200~/g, "").replace(/\x1b\[201~/g, "");
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
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
  capturePane(target: string, opts: { start?: number; maxChars?: number } = {}): string {
    const args = ["capture-pane", "-t", target, "-p"];
    if (opts.start && opts.start > 0) args.push("-S", String(-opts.start));
    let lastStdout = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = this.tmux(args);
      if (res.exitCode !== 0) {
        throw new Error(`capture-pane failed for ${target}: ${res.stderr.trim() || res.stdout.trim()}`);
      }
      lastStdout = opts.maxChars && res.stdout.length > opts.maxChars ? res.stdout.slice(-opts.maxChars) : res.stdout;
      if (lastStdout.trim().length > 0 || attempt === 2) return lastStdout;
      sleepSync(80);
    }
    return lastStdout;
  }

  /**
   * Enumerate dispatchable targets (every pane across all sessions) on this
   * machine, so an agent can discover where to send a prompt.
   */
  listTargets(): { target: string; window: string; active: boolean; paneCommand?: string; cwd?: string; panePid?: string }[] {
    const res = this.tmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}",
    ]);
    if (res.exitCode !== 0) {
      if (isTmuxServerAbsent(res)) return [];
      if (res.source !== "local") {
        throw new RemoteTargetEnumerationError({
          machine: this.machine,
          source: res.source,
          exitCode: res.exitCode,
          category: classifyRemoteTargetFailure(res),
        });
      }
      return [];
    }
    return res.stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((line) => {
        const [target = "", window = "", active = "0", paneCommand = "", cwd = "", panePid = ""] = line.split("\t");
        return {
          target,
          window,
          active: active.trim() === "1",
          paneCommand: paneCommand || undefined,
          cwd: cwd || undefined,
          panePid: panePid || undefined,
        };
      });
  }

  /** Read a pane property via display-message, e.g. "pane_in_mode". */
  paneProperty(target: string, property: string): string {
    const res = this.tmux(["display-message", "-p", "-t", target, `#{${property}}`]);
    return res.exitCode === 0 ? res.stdout.replace(/\n$/, "") : "";
  }

  /** Best-effort process tree for the pane's process group. */
  processTree(
    target: string,
    panePid?: string,
    opts: { maxLines?: number; maxLineChars?: number } = {},
  ): string {
    const pid = panePid ?? this.paneProperty(target, "pane_pid");
    if (!/^\d+$/.test(pid)) return "";
    const bounded = opts.maxLines || opts.maxLineChars;
    if (bounded) {
      const maxLines = String(Math.max(1, Math.trunc(opts.maxLines ?? 80)));
      const maxLineChars = String(Math.max(80, Math.trunc(opts.maxLineChars ?? 1000)));
      const script =
        'ps -o pid=,ppid=,stat=,command= --forest -g "$1" 2>/dev/null | head -n "$2" | cut -c "1-$3"';
      const group = this.runner.run(["sh", "-c", script, "dispatch-process-tree", pid, maxLines, maxLineChars]);
      if (group.exitCode === 0 && group.stdout.trim()) return group.stdout;
      const singleScript = 'ps -o pid=,ppid=,stat=,command= -p "$1" 2>/dev/null | head -n "$2" | cut -c "1-$3"';
      const single = this.runner.run(["sh", "-c", singleScript, "dispatch-process-tree", pid, maxLines, maxLineChars]);
      return single.exitCode === 0 ? single.stdout : "";
    }
    const group = this.runner.run(["ps", "-o", "pid=,ppid=,stat=,command=", "--forest", "-g", pid]);
    if (group.exitCode === 0 && group.stdout.trim()) return group.stdout;
    const single = this.runner.run(["ps", "-o", "pid=,ppid=,stat=,command=", "-p", pid]);
    return single.exitCode === 0 ? single.stdout : "";
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
    const res = this.tmux(["copy-mode", "-q", "-t", target]);
    return res.exitCode === 0 && !this.paneInMode(target);
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
    this.loadBuffer(name, stripBracketedPasteMarkers(text));
    this.pasteBuffer(target, name, { bracketed: opts.bracketed ?? true, deleteAfter: true });
  }
}
