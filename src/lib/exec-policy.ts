import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import type { ExecFilterResult, ExecPolicy, ExecTargetKind } from "../types.js";

const SHELL_COMMANDS = new Set(["bash", "csh", "dash", "fish", "ksh", "nu", "sh", "tcsh", "zsh"]);
const AGENT_COMMANDS = new Set([
  "aider",
  "claude",
  "codewith",
  "codex",
  "gemini",
  "opencode",
  "takumi",
]);

const DEFAULT_ALLOW_PREFIXES = [
  "mailery status",
  "mailery doctor",
  "dispatch --help",
  "dispatch help",
  "dispatch version",
  "dispatch targets",
  "dispatch list",
  "pwd",
  "ls",
  "rg",
  "git status",
  "git diff",
  "git log",
  "git show",
  "bun test",
  "bun run typecheck",
  "bun run build",
];

function basename(command: string): string {
  const trimmed = command.trim();
  const part = trimmed.split(/[\\/]/).at(-1) ?? trimmed;
  return part.trim().toLowerCase();
}

/** Classify a tmux pane by its current command. */
export function classifyPaneCommand(currentCommand: string): ExecTargetKind {
  const name = basename(currentCommand);
  if (SHELL_COMMANDS.has(name)) return "shell";
  if (AGENT_COMMANDS.has(name)) return "agent";
  return "unknown";
}

/** Best-effort content check for test fixtures and agent TUIs launched through wrappers like bun/node. */
export function looksLikeAgentPane(text: string): boolean {
  return (
    looksLikeCodewithComposer(text) ||
    /\b(?:esc to interrupt|working on the previous task|messages to be submitted after next tool call)\b/i.test(text) ||
    /^>\s+(?:awaiting prompt|idle|idle composer)\b/im.test(text) ||
    /[✶✻●]\s*Working/i.test(text)
  );
}

function looksLikeCodewithComposer(text: string): boolean {
  const brand =
    /\b(?:Hasna\s+Codewith|Codewith|Codex)\s+\(v[0-9][^)]+\)/i.test(text) ||
    /\bAsk\s+(?:Codewith|Codex)\s+to\s+do\s+anything\b/i.test(text);
  if (!brand) return false;

  const hasStartupFields =
    /\bmodel:\s*\S+/i.test(text) && /\bdirectory:\s*\S+/i.test(text) && /\bpermissions:\s*\S+/i.test(text);
  const hasStatusFooter = /^\s*(?:gpt|o[0-9]|claude|gemini|qwen|llama)[^\n]*\s+·\s+[^\n]*(?:account|left|%)/im.test(text);
  if (!hasStartupFields && !hasStatusFooter) return false;

  const tail = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-24);
  return tail.some((line) => /^\s*›(?:\s*$|\s+(?!\d+\.|\[[^\]]+\])\S)/.test(line));
}

/** Short stable SHA-256 command hash for audit displays. */
export function hashCommand(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex").slice(0, 16);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/[ \t]+/g, " ");
}

export function redactedCommand(commandHash: string): string {
  return `<exec-command sha256:${commandHash}>`;
}

function result(input: {
  allowed: boolean;
  code: string;
  reason: string;
  command: string;
  targetKind: ExecTargetKind;
  matchedRule?: string;
}): ExecFilterResult {
  return {
    allowed: input.allowed,
    code: input.code,
    reason: input.reason,
    commandHash: hashCommand(input.command),
    normalizedCommand: normalizeCommand(input.command),
    targetKind: input.targetKind,
    matchedRule: input.matchedRule,
  };
}

function stripLeadingSafeCd(command: string): { cwd?: string; command: string; invalid?: string } {
  const match = command.match(/^cd\s+((?:"[^"]+"|'[^']+'|[^\s;&|`$()]+))\s*&&\s*(.+)$/);
  if (!match) return { command };
  const rawPath = match[1] ?? "";
  const rest = match[2] ?? command;
  const cwd = rawPath.replace(/^['"]|['"]$/g, "");
  if (!cwd || /(?:^|\/)\.\.(?:\/|$)/.test(cwd)) {
    return { cwd, command: rest.trim(), invalid: "cd path contains traversal or is empty" };
  }
  return { cwd, command: rest.trim() };
}

function prefixMatches(command: string, prefix: string): boolean {
  const normalizedPrefix = normalizeCommand(prefix);
  if (command === normalizedPrefix) return true;
  return command.startsWith(`${normalizedPrefix} `) && !hasShellMetacharacters(command.slice(normalizedPrefix.length));
}

function targetMatches(target: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

function canonicalPath(p: string): string | undefined {
  if (!p.startsWith("/")) return undefined;
  if (/(?:^|\/)\.\.(?:\/|$)/.test(p)) return undefined;
  return path.normalize(p).replace(/\/+$/, "") || "/";
}

function pathAllowed(cwd: string | undefined, allowedPaths: string[] | undefined): boolean {
  if (!cwd || !allowedPaths || allowedPaths.length === 0) return false;
  const normalizedCwd = canonicalPath(cwd);
  if (!normalizedCwd) return false;
  return allowedPaths.some((allowed) => {
    if (allowed === "*") return true;
    const normalizedAllowed = canonicalPath(allowed);
    return normalizedAllowed
      ? normalizedCwd === normalizedAllowed || normalizedCwd.startsWith(`${normalizedAllowed}/`)
      : false;
  });
}

function hasControlChars(command: string): boolean {
  return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command);
}

function hasShellMetacharacters(command: string): boolean {
  return /(?:;|&&|\|\||\||[<>]|`|\$\(|<\(|>\(|\s&(?:\s|$))/.test(command);
}

function blockedPattern(command: string): { code: string; reason: string } | undefined {
  const lower = command.toLowerCase();
  if (/\brm\s+(?:-[^\s]*[rR][^\s]*[fF]|-[^\s]*[fF][^\s]*[rR])\s+(?:(?:--no-preserve-root|--)\s+)*(?:\/|\/\*|~(?:\/|\s|$)|\$home(?:\/|\s|$)|\$\{home\}(?:\/|\s|$))/i.test(command)) {
    return { code: "blocked_destructive", reason: "destructive root/home removal is blocked" };
  }
  if (/\bmkfs(?:\.[\w-]+)?\b/i.test(command)) {
    return { code: "blocked_destructive", reason: "filesystem formatting commands are blocked" };
  }
  if (/\bdd\s+.*\bof=\/dev\//i.test(command)) {
    return { code: "blocked_destructive", reason: "raw writes to block devices are blocked" };
  }
  if (/:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i.test(command)) {
    return { code: "blocked_destructive", reason: "fork bombs are blocked" };
  }
  if (/\b(?:curl|wget)\b.+\|\s*(?:sudo\s+|env\s+)?(?:\/[\w./-]+\/)?(?:ba|z)?sh\b/i.test(command)) {
    return { code: "blocked_remote_code", reason: "piping curl/wget directly to a shell is blocked" };
  }
  if (/\b(?:ba|z)?sh\s+-c\s+["']?\$\(.*\b(?:curl|wget)\b/i.test(command)) {
    return { code: "blocked_remote_code", reason: "remote shell execution through command substitution is blocked" };
  }
  if (/\b(?:bash|sh|zsh)\s+<\s*<\s*\(\s*(?:curl|wget)\b/i.test(command)) {
    return { code: "blocked_remote_code", reason: "process-substitution remote shell execution is blocked" };
  }
  if (/(?:>{1,2}\s*|tee\s+(?:-[a-zA-Z]+\s+)?)(?:"|')?(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+)\/\.ssh\//.test(command)) {
    return { code: "blocked_ssh_rewrite", reason: "rewriting ~/.ssh is blocked" };
  }
  if (/\b(?:curl|wget|nc|netcat|scp|sftp|rsync)\b/i.test(command) && /(?:~|\$HOME|\$\{HOME\}|\/home\/[^/\s]+)\/(?:\.ssh|\.aws\/credentials|\.npmrc)|(?:^|[\s/])\.env(?:\s|$)/i.test(command)) {
    return { code: "blocked_credential_exfil", reason: "network transfer of credential-looking paths is blocked" };
  }
  if (/\b(?:shutdown|reboot|halt|poweroff)\b/i.test(lower)) {
    return { code: "blocked_destructive", reason: "host power-control commands are blocked" };
  }
  return undefined;
}

/** Evaluate whether an exec command may be sent to the target pane. */
export function evaluateExecPolicy(input: {
  target: string;
  targetKind: ExecTargetKind;
  command: string;
  policy?: ExecPolicy;
  /** Require an explicit target allowlist, used for non-dry-run exec. */
  requireTargetOptIn?: boolean;
}): ExecFilterResult {
  const command = normalizeCommand(input.command);
  if (command.length === 0) {
    return result({
      allowed: false,
      code: "blocked_empty",
      reason: "command is empty",
      command,
      targetKind: input.targetKind,
    });
  }
  if (input.command.includes("\n") || input.command.includes("\r")) {
    return result({
      allowed: false,
      code: "blocked_multiline",
      reason: "dispatch exec only accepts single-line commands",
      command,
      targetKind: input.targetKind,
    });
  }
  if (hasControlChars(input.command)) {
    return result({
      allowed: false,
      code: "blocked_control_chars",
      reason: "control characters are blocked in exec commands",
      command,
      targetKind: input.targetKind,
    });
  }

  const blocked = blockedPattern(command);
  if (blocked) {
    return result({ allowed: false, code: blocked.code, reason: blocked.reason, command, targetKind: input.targetKind });
  }

  if (input.targetKind !== "shell") {
    const label = input.targetKind === "agent" ? "agent composer" : "non-shell pane";
    return result({
      allowed: false,
      code: "blocked_target_kind",
      reason: `target appears to be a ${label}; use dispatch send for prompts and dispatch exec only for shell panes`,
      command,
      targetKind: input.targetKind,
    });
  }

  const policy = input.policy;
  if (input.requireTargetOptIn && (!policy?.allowTargets || policy.allowTargets.length === 0)) {
    return result({
      allowed: false,
      code: "blocked_target_policy",
      reason: "non-dry-run exec requires a reviewed policy with allowTargets for this target/session class",
      command,
      targetKind: input.targetKind,
    });
  }
  if (policy?.allowTargets && !policy.allowTargets.some((pattern) => targetMatches(input.target, pattern))) {
    return result({
      allowed: false,
      code: "blocked_target_policy",
      reason: "target is not allowed by the exec policy file",
      command,
      targetKind: input.targetKind,
    });
  }

  const stripped = stripLeadingSafeCd(command);
  if (stripped.invalid) {
    return result({
      allowed: false,
      code: "blocked_cd_path",
      reason: stripped.invalid,
      command,
      targetKind: input.targetKind,
    });
  }
  const commandForPrefix = stripped.command;
  if (hasShellMetacharacters(commandForPrefix)) {
    return result({
      allowed: false,
      code: "blocked_shell_metachar",
      reason: "shell chaining, pipes, redirects, substitutions, and background operators are blocked",
      command,
      targetKind: input.targetKind,
    });
  }
  if (/\bgit\s+reset\s+--hard\b/i.test(commandForPrefix) && !pathAllowed(stripped.cwd, policy?.allowGitResetHardPaths)) {
    return result({
      allowed: false,
      code: "blocked_git_reset_hard",
      reason: "git reset --hard requires an exec policy that allows the current path",
      command,
      targetKind: input.targetKind,
    });
  }

  const prefixes = [...DEFAULT_ALLOW_PREFIXES, ...(policy?.allowPrefixes ?? [])];
  const matched = prefixes.find((prefix) => prefixMatches(commandForPrefix, prefix));
  if (!matched) {
    return result({
      allowed: false,
      code: "blocked_not_allowlisted",
      reason: "command prefix is not allowlisted; pass --allow with a reviewed exec policy file",
      command,
      targetKind: input.targetKind,
    });
  }

  return result({
    allowed: true,
    code: "allowed_prefix",
    reason: "command prefix is allowlisted",
    command,
    targetKind: input.targetKind,
    matchedRule: matched,
  });
}

/** Load an exec policy JSON file for `dispatch exec --allow`. */
export function loadExecPolicy(path: string): ExecPolicy {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ExecPolicy;
  return {
    allowPrefixes: Array.isArray(parsed.allowPrefixes) ? parsed.allowPrefixes.map(String) : undefined,
    allowTargets: Array.isArray(parsed.allowTargets) ? parsed.allowTargets.map(String) : undefined,
    allowGitResetHardPaths: Array.isArray(parsed.allowGitResetHardPaths)
      ? parsed.allowGitResetHardPaths.map(String)
      : undefined,
  };
}
