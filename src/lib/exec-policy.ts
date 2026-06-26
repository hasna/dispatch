import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import type {
  AgentActivityState,
  AgentKind,
  AgentTargetInfo,
  ComposerState,
  ExecFilterResult,
  ExecPolicy,
  ExecTargetKind,
  SubmitKey,
} from "../types.js";

const SHELL_COMMANDS = new Set(["bash", "csh", "dash", "fish", "ksh", "nu", "sh", "tcsh", "zsh"]);
const AGENT_COMMANDS = new Set([
  "aider",
  "claude",
  "claude-code",
  "codewith",
  "codex",
  "gemini",
  "opencode",
  "takumi",
]);
const AGENT_WRAPPER_COMMANDS = new Set(["bun", "bunx", "node", "npx", "npm", "pnpm", "yarn"]);

const DIRECT_AGENT_KINDS: Record<string, AgentKind> = {
  claude: "claude",
  "claude-code": "claude",
  codewith: "codewith",
  codex: "codex",
  opencode: "opencode",
};

const QUEUE_CAPABLE_AGENTS = new Set<AgentKind>(["codewith", "claude"]);

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

function tokenBasename(token: string | undefined): string {
  if (!token) return "";
  return basename(token.replace(/^["']|["']$/g, ""));
}

function commandPartFromPsLine(line: string): string {
  return line
    .trim()
    .replace(/^\d+\s+\d+\s+\S+\s+/, "")
    .replace(/^\\_\s*/, "")
    .trim();
}

function commandTokens(line: string): string[] {
  return commandPartFromPsLine(line).split(/\s+/).filter(Boolean);
}

function agentKindForName(name: string): AgentKind {
  return DIRECT_AGENT_KINDS[name.toLowerCase()] ?? "unknown";
}

/** Classify a tmux pane by its current command. */
export function classifyPaneCommand(currentCommand: string): ExecTargetKind {
  const name = basename(currentCommand);
  if (SHELL_COMMANDS.has(name)) return "shell";
  if (AGENT_COMMANDS.has(name)) return "agent";
  return "unknown";
}

/** True when the pane command is a known JS runtime wrapper for agent CLIs. */
export function isAgentWrapperCommand(currentCommand: string): boolean {
  return AGENT_WRAPPER_COMMANDS.has(basename(currentCommand));
}

export function detectAgentKindFromCommand(currentCommand: string): AgentKind {
  return agentKindForName(basename(currentCommand));
}

function agentKindFromPackageToken(
  token: string | undefined,
  options: { allowBareName?: boolean; allowTrustedBinPath?: boolean } = {},
): AgentKind {
  const value = token?.replace(/^["']|["']$/g, "").toLowerCase() ?? "";
  if (!value) return "unknown";
  const hasPathSeparator = /[\\/]/.test(value);
  const baseKind = agentKindForName(basename(value));
  if (!hasPathSeparator && options.allowBareName !== false && baseKind !== "unknown") return baseKind;
  if (options.allowTrustedBinPath !== false && baseKind !== "unknown") {
    const trustedBinPath =
      /^\/(?:home|users)\/[^/]+\/(?:\.bun\/bin|\.bun\/install\/global\/bin|\.local\/bin|\.npm-global\/bin|\.yarn\/bin)\//.test(
        value,
      ) ||
      /^\/usr\/local\/bin\//.test(value) ||
      /^\/opt\/homebrew\/bin\//.test(value) ||
      /^\/home\/linuxbrew\/\.linuxbrew\/bin\//.test(value);
    if (trustedBinPath) return baseKind;
  }
  if (/(?:^|\/)node_modules\/@hasna\/codewith(?:@[^/]+)?(?:\/|$)/.test(value)) return "codewith";
  if (/(?:^|\/)node_modules\/(?:@openai\/)?codex(?:@[^/]+)?(?:\/|$)/.test(value)) return "codex";
  if (/(?:^|\/)node_modules\/(?:@anthropic-ai\/claude-code|claude-code)(?:@[^/]+)?(?:\/|$)/.test(value)) return "claude";
  if (/(?:^|\/)node_modules\/(?:opencode|opencode-ai|@opencode\/opencode)(?:@[^/]+)?(?:\/|$)/.test(value)) return "opencode";
  if (options.allowBareName !== false) {
    if (/^@hasna\/codewith(?:@[^/]+)?$/.test(value)) return "codewith";
    if (/^(?:@openai\/)?codex(?:@[^/]+)?$/.test(value)) return "codex";
    if (/^(?:@anthropic-ai\/claude-code|claude-code)(?:@[^/]+)?$/.test(value)) return "claude";
    if (/^(?:opencode|opencode-ai|@opencode\/opencode)(?:@[^/]+)?$/.test(value)) return "opencode";
  }
  return "unknown";
}

const RUNTIME_VALUE_FLAGS = new Set([
  "-C",
  "-r",
  "--conditions",
  "--env-file",
  "--experimental-config-file",
  "--experimental-loader",
  "--icu-data-dir",
  "--import",
  "--inspect-port",
  "--loader",
  "--max-old-space-size",
  "--max-semi-space-size",
  "--require",
  "--stack_size",
  "--title",
]);

const RUNTIME_CODE_FLAGS = new Set(["-e", "-p", "--eval", "--print", "--test"]);

function runtimeFlagName(token: string): string {
  return token.split("=")[0] ?? token;
}

function isRuntimeCodeFlag(flag: string): boolean {
  return RUNTIME_CODE_FLAGS.has(flag) || /^-[^-]*[ep]/.test(flag);
}

function firstRuntimeEntrypointToken(tokens: string[]): string | undefined {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "--") return tokens[i + 1];
    if (!token.startsWith("-")) return token;

    const flag = runtimeFlagName(token);
    if (isRuntimeCodeFlag(flag)) return undefined;
    if (!token.includes("=") && RUNTIME_VALUE_FLAGS.has(flag)) i += 1;
  }
  return undefined;
}

function packageRunnerAgentKind(tokens: string[], start = 1): AgentKind {
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    if (token === "--") continue;
    const flag = runtimeFlagName(token);
    if (flag === "--package" || flag === "-p") {
      const kind = agentKindFromPackageToken(tokens[i + 1], { allowBareName: true });
      if (kind !== "unknown") return kind;
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return agentKindFromPackageToken(token, { allowBareName: true });
  }
  return "unknown";
}

function detectAgentKindFromProcessLine(line: string): AgentKind {
  const tokens = commandTokens(line);
  const firstBase = tokenBasename(tokens[0]);
  const direct = agentKindForName(firstBase);
  if (direct !== "unknown") return direct;

  if (firstBase === "node" || firstBase === "bun") {
    return agentKindFromPackageToken(firstRuntimeEntrypointToken(tokens), {
      allowBareName: false,
      allowTrustedBinPath: true,
    });
  }

  if (firstBase === "bunx" || firstBase === "npx") {
    return packageRunnerAgentKind(tokens, 1);
  }

  if (firstBase === "npm" || firstBase === "pnpm" || firstBase === "yarn") {
    const execIndex = tokens.findIndex((t) => /^(?:exec|dlx|x|create)$/.test(t));
    const start = execIndex >= 0 ? execIndex + 1 : 1;
    return packageRunnerAgentKind(tokens, start);
  }

  return "unknown";
}

export function detectAgentKindFromProcessTree(processTree = ""): AgentKind {
  for (const line of processTree.split("\n")) {
    const kind = detectAgentKindFromProcessLine(line);
    if (kind !== "unknown") return kind;
  }
  return "unknown";
}

function stripTuiLineChrome(line: string): string {
  return line
    .trim()
    .replace(/^[│┃║╎╏┆┇┊┋▏▎▌▐]\s*/, "")
    .replace(/\s*[│┃║╎╏┆┇┊┋▏▎▌▐]$/, "")
    .trim()
    .replace(/^[⎔✦✧◆◇●○◉◎⦿]\s*/, "")
    .trim();
}

function hasNamedAgentComposer(text: string): boolean {
  const normalized = text.split("\n").map(stripTuiLineChrome).join("\n");
  const hasKnownBanner =
    /^[ \t]*(?:Hasna[ \t]+)?Codewith(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized) ||
    /^[ \t]*(?:OpenAI[ \t]+)?Codex(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized) ||
    /^[ \t]*(?:Anthropic[ \t]+)?Claude(?:[ \t]+Code)?(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized) ||
    /^[ \t]*(?:OpenCode|opencode)(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized);
  if (!hasKnownBanner) return false;

  const contextSignals = [
    /^[ \t]*model:[^\n]+/im,
    /^[ \t]*(?:directory|cwd|workspace):[^\n]+/im,
    /^[ \t]*permissions:[^\n]+/im,
  ].filter((pattern) => pattern.test(normalized)).length;
  const hasComposerPrompt = /^[ \t]*(?:›|>|❯)(?:\s|$).*/m.test(normalized);
  const hasBusySignal =
    /\b(?:esc to interrupt|esc to cancel|ctrl\+c to (?:stop|interrupt|cancel))\b/i.test(normalized) ||
    /[✶✻●]\s*Working/i.test(normalized);

  return contextSignals >= 1 && (hasComposerPrompt || hasBusySignal);
}

export function detectAgentKindFromText(text: string): AgentKind {
  const normalized = text.split("\n").map(stripTuiLineChrome).join("\n");
  if (
    /^[ \t]*(?:Hasna[ \t]+)?Codewith(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized) ||
    /\bGoal achieved\b.*\bMain\s+\[[^\]]+\]/i.test(normalized) ||
    /\bMain\s+\[[^\]]+\].*\b(?:Pursuing goal|Goal achieved|Goal blocked|Goal failed|Goal cancelled)\b/i.test(normalized)
  ) {
    return "codewith";
  }
  if (/^[ \t]*(?:OpenAI[ \t]+)?Codex(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized)) {
    return "codex";
  }
  if (/^[ \t]*(?:Anthropic[ \t]+)?Claude(?:[ \t]+Code)?(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized)) {
    return "claude";
  }
  if (/^[ \t]*(?:OpenCode|opencode)(?:[ \t]+(?:CLI|v?\d[\w.-]*)|[ \t]*\([^)]+\))?[ \t]*$/im.test(normalized)) {
    return "opencode";
  }
  return "unknown";
}

function hasWrappedAgentProcessEvidence(processTree = ""): boolean {
  return detectAgentKindFromProcessTree(processTree) !== "unknown";
}

function hasCompletedCodewithComposer(text: string, processTree?: string): boolean {
  if (detectAgentKindFromProcessTree(processTree) !== "codewith") return false;
  const lines = text
    .split("\n")
    .map(stripTuiLineChrome)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const statusLine = lines.at(-1) ?? "";
  const inlineGoal = /\s+Goal achieved(?:\s*\([^)]+\))?$/i;
  const goalOnly = /^Goal achieved(?:\s*\([^)]+\))?$/i;
  const isWrappedGoal = goalOnly.test(statusLine);
  const metadataLine = isWrappedGoal ? (lines.at(-2) ?? "") : statusLine.replace(inlineGoal, "").trim();
  const composerLine = isWrappedGoal ? (lines.at(-3) ?? "") : (lines.at(-2) ?? "");
  const model = String.raw`(?:gpt|o\d|codex|claude|glm|gemini|qwen|deepseek|llama|mistral|kimi|grok)[\w.+:-]*(?:\s+\w+){0,4}`;
  const account = String.raw`account[\w-]+`;
  const budget = String.raw`\d+\s*[dhms]\s+(?:100|[1-9]?\d)%\s+left`;
  const branch = String.raw`[^·\[\]\s]+(?:\s+[^·\[\]\s]+){0,4}\s+\[[^\]\n]+\]`;
  const metadataPattern = new RegExp(
    String.raw`^${model}\s+·\s+(?:${account}\s+·\s+${budget}|${budget}\s+·\s+${account})(?:\s+·\s+${branch})?$`,
    "i",
  );
  const hasGoal = isWrappedGoal || inlineGoal.test(statusLine);

  return hasGoal && /^›(?:\s|$).+/.test(composerLine) && metadataPattern.test(metadataLine);
}

function hasIdleCodewithStatusComposer(text: string, processTree?: string): boolean {
  if (detectAgentKindFromProcessTree(processTree) !== "codewith") return false;
  const lines = text
    .split("\n")
    .map(stripTuiLineChrome)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const statusLine = lines.at(-1) ?? "";
  const composerLine = lines.at(-2) ?? "";
  const model = String.raw`(?:gpt|o\d|codex|claude|glm|gemini|qwen|deepseek|llama|mistral|kimi|grok)[\w.+:-]*(?:\s+\w+){0,4}`;
  const account = String.raw`account[\w-]+`;
  const budget = String.raw`(?:\d+\s*[dhms]\s+)?(?:100|[1-9]?\d)%\s+left`;
  const branch = String.raw`[^·\[\]\s]+(?:\s+[^·\[\]\s]+){0,4}\s+\[[^\]\n]+\]`;
  const metadataPattern = new RegExp(
    String.raw`^${model}\s+·\s+(?:${account}\s+·\s+${budget}|${budget}\s+·\s+${account})(?:\s+·\s+${branch})?$`,
    "i",
  );

  return /^›(?:\s|$).+/.test(composerLine) && metadataPattern.test(statusLine);
}

function hasWrappedAgentLiveUi(text: string, processTree?: string): boolean {
  if (!hasWrappedAgentProcessEvidence(processTree)) return false;
  const normalized = text
    .split("\n")
    .map(stripTuiLineChrome)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  const hasModelStatus =
    /\b(?:gpt|o\d|codex|claude|glm|gemini|qwen|deepseek|llama|mistral|kimi|grok)[\w.+:-]*(?:\s+\w+){0,4}\s+·\s+.*\b(?:Pursuing goal|Working|Goal blocked|Goal failed|Goal cancelled)\b/i.test(
      normalized,
    );
  const hasGoalActivity = /\bGoal active Objective:|\bPursuing goal\b|\bWorking \(\d|\besc to interrupt\b/i.test(normalized);
  const hasComposer = /^›(?:\s|$).*/m.test(normalized);
  return hasGoalActivity && (hasComposer || hasModelStatus);
}

function hasWrappedCodexComposer(text: string, processTree?: string): boolean {
  if (detectAgentKindFromProcessTree(processTree) !== "codex") return false;
  const normalized = text
    .split("\n")
    .map(stripTuiLineChrome)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  const hasComposer = /^›(?:\s|$).+/m.test(normalized);
  const hasCodexStatus = /\b(?:gpt|o\d|codex)[\w.+:-]*codex[\w.+:-]*\b/i.test(normalized);
  const hasBusySignal = /\b(?:esc to interrupt|esc to cancel|ctrl\+c to (?:stop|interrupt|cancel))\b/i.test(normalized);
  return hasComposer && (hasCodexStatus || hasBusySignal);
}

/** Best-effort visible-state classifier for agent panes. */
export function detectAgentActivity(text: string): AgentActivityState {
  const normalized = text
    .split("\n")
    .map(stripTuiLineChrome)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  if (
    /\b(?:Pursuing goal|Working \(|esc to interrupt|background terminal running|Messages to be submitted after next tool call|Goal active Objective:)\b/i.test(
      normalized,
    )
  ) {
    return "active";
  }
  if (/\bGoal achieved(?:\s*\([^)]+\))?\b/i.test(normalized) && /^[›❯](?:\s|$).*/m.test(normalized)) {
    return "idle";
  }
  if (
    hasNamedAgentComposer(text) ||
    /^[›❯](?:\s|$).*/m.test(normalized) ||
    /^>\s+(?:awaiting prompt|idle|idle composer)\b/im.test(normalized)
  ) {
    return "idle";
  }
  return "unknown";
}

function submitKeysFor(agentKind: AgentKind): SubmitKey[] {
  if (agentKind === "unknown") return [];
  const keys: SubmitKey[] = ["Enter"];
  if (QUEUE_CAPABLE_AGENTS.has(agentKind)) keys.push("Tab");
  return keys;
}

function liveUiProofForKind(kind: AgentKind, text: string, processTree?: string): boolean {
  if (kind === "unknown") return false;
  const textKind = detectAgentKindFromText(text);
  if (textKind === kind && hasNamedAgentComposer(text)) return true;
  if (
    kind === "codewith" &&
    (hasCompletedCodewithComposer(text, processTree) ||
      hasIdleCodewithStatusComposer(text, processTree) ||
      hasWrappedAgentLiveUi(text, processTree))
  ) {
    return true;
  }
  if (kind === "codex" && hasWrappedCodexComposer(text, processTree)) return true;
  return false;
}

export function detectAgentTargetFromSignals(input: {
  paneCommand: string;
  visible?: string;
  processTree?: string;
  cwd?: string;
}): AgentTargetInfo {
  const paneCommand = input.paneCommand;
  const visible = input.visible ?? "";
  const cwd = input.cwd?.trim() || undefined;
  const targetKind = classifyPaneCommand(paneCommand);
  const paneBase = basename(paneCommand);

  if (targetKind === "shell") {
    return {
      targetKind,
      agentKind: "unknown",
      composerState: "unknown",
      canReceivePrompt: false,
      canQueuePrompt: false,
      submitKeys: [],
      paneCommand,
      cwd,
      reason: `target appears to be a shell (${paneCommand || "unknown"}); use dispatch exec for shell commands`,
    };
  }

  const commandKind = detectAgentKindFromCommand(paneCommand);
  const processKind = detectAgentKindFromProcessTree(input.processTree);
  const wrapper = isAgentWrapperCommand(paneCommand);
  let agentKind: AgentKind = "unknown";
  let proven = false;
  let reason = `target is not a recognized agent composer (${paneCommand || "unknown"}); refusing prompt delivery`;

  if (targetKind === "agent" && commandKind !== "unknown") {
    agentKind = commandKind;
    proven = true;
    reason = `recognized ${agentKind} from pane command ${paneBase}`;
  } else if (wrapper && processKind !== "unknown" && liveUiProofForKind(processKind, visible, input.processTree)) {
    agentKind = processKind;
    proven = true;
    reason = `recognized ${agentKind} wrapper from process tree and live composer UI`;
  }

  if (!proven) {
    return {
      targetKind: "unknown",
      agentKind: "unknown",
      composerState: "unknown",
      canReceivePrompt: false,
      canQueuePrompt: false,
      submitKeys: [],
      paneCommand,
      cwd,
      reason,
    };
  }

  const composerState = detectAgentActivity(visible) as ComposerState;
  const submitKeys = submitKeysFor(agentKind);
  const canReceivePrompt = composerState === "idle";
  const canQueuePrompt = composerState === "active" && QUEUE_CAPABLE_AGENTS.has(agentKind);
  const recommendedSubmitKey = canReceivePrompt ? "Enter" : canQueuePrompt ? "Tab" : undefined;
  const stateReason =
    composerState === "idle"
      ? "idle composer can receive Enter prompt delivery"
      : canQueuePrompt
        ? "active composer supports queued Tab prompt delivery"
        : composerState === "active"
          ? "active composer does not prove queued prompt support"
          : "composer state is unknown";

  return {
    targetKind: "agent",
    agentKind,
    composerState,
    canReceivePrompt,
    canQueuePrompt,
    submitKeys,
    recommendedSubmitKey,
    paneCommand,
    cwd,
    reason: `${reason}; ${stateReason}`,
  };
}

export interface WrappedAgentEvidence {
  /** Process tree for the tmux pane; required to trust wrapper-launched agent UI text. */
  processTree?: string;
}

/** Strict proof for Codewith/Codex panes launched through runtime wrappers like node/bun. */
export function looksLikeWrappedAgentComposer(text: string, evidence: WrappedAgentEvidence = {}): boolean {
  const kind = detectAgentKindFromProcessTree(evidence.processTree);
  return kind !== "unknown" && liveUiProofForKind(kind, text, evidence.processTree);
}

/** Best-effort content check for known agent TUIs and test fixtures. */
export function looksLikeAgentPane(text: string): boolean {
  return (
    looksLikeWrappedAgentComposer(text) ||
    /\b(?:esc to interrupt|working on the previous task|messages to be submitted after next tool call)\b/i.test(text) ||
    /^❯(?:\s|$).*/m.test(text) ||
    /^>\s+(?:awaiting prompt|idle|idle composer)\b/im.test(text) ||
    /[✶✻●]\s*Working/i.test(text)
  );
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
