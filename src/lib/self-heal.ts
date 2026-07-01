export type DispatchSelfHealCategory =
  | "target"
  | "auth"
  | "machine"
  | "stale_package"
  | "routing"
  | "dispatch_bug"
  | "unknown";

export interface DispatchSelfHealInput {
  target?: string;
  machine?: string;
  route?: string;
  errorText?: string;
  statusText?: string;
  legacyHandoffAuthorized?: boolean;
}

export interface DispatchSelfHealDiagnosis {
  dryRun: true;
  mutates: false;
  category: DispatchSelfHealCategory;
  confidence: "high" | "medium" | "low";
  reason: string;
  recommendedAction: string;
  nextActions: string[];
  repairRoute: string;
  fallbackPolicy: {
    tmuxPasteFallbackAllowed: boolean;
    detail: string;
  };
  affectedMachineChecks: {
    check: string[];
    ignoreIfNonresponsive: string[];
  };
  redacted: {
    target?: string;
    machine?: string;
    route?: string;
    errorText?: string;
    statusText?: string;
  };
}

interface Rule {
  category: DispatchSelfHealCategory;
  confidence: "high" | "medium";
  reason: string;
  patterns: RegExp[];
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-(?:ant|proj)-[A-Za-z0-9_-]+\b/g, "[REDACTED:api-key]"],
  [/\bnpm_[A-Za-z0-9_=-]+\b/g, "[REDACTED:npm-token]"],
  [/\bgh[op]_[A-Za-z0-9_]+\b/g, "[REDACTED:github-token]"],
  [new RegExp("\\bctx7" + "sk-[A-Za-z0-9_-]+\\b", "g"), "[REDACTED:api-key]"],
  [new RegExp("\\bx" + "ai-[A-Za-z0-9_-]+\\b", "g"), "[REDACTED:api-key]"],
  [/\bAIza[A-Za-z0-9_-]+\b/g, "[REDACTED:google-api-key]"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED:aws-access-key]"],
  [new RegExp("\\b(secret-" + "token:\\s*)[^\\s]+", "gi"), "$1[REDACTED:token]"],
  [/\b(Authorization:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, "$1[REDACTED:credential]"],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s]+)/gi, "$1[REDACTED:credential]"],
];

const RULES: Rule[] = [
  {
    category: "target",
    confidence: "high",
    reason: "the failure points at target discovery, target safety, or pane state",
    patterns: [
      /\bno target\b/i,
      /\btarget .*not found\b/i,
      /\bunknown target\b/i,
      /\bpane .*not found\b/i,
      /\bnot dispatchable\b/i,
      /\bcanReceivePrompt[=: ]false\b/i,
      /\btarget appears to be a shell\b/i,
      /\brefus(?:e|ed|es).*shell\b/i,
      /\bcomposer.*active\b/i,
      /\bprompt never parked\b/i,
    ],
  },
  {
    category: "auth",
    confidence: "high",
    reason: "the failure points at authentication, authorization, or account/profile state",
    patterns: [
      /\bauth(?:entication)?\b/i,
      /\bunauthorized\b/i,
      /\bforbidden\b/i,
      /\b401\b/,
      /\b403\b/,
      /\blog(?:ged)? out\b/i,
      /\boauth\b/i,
      /\bcredential\b/i,
      /\btoken\b/i,
      /\baccount limit\b/i,
      /\bprofile switch\b/i,
      /\bauth profile\b/i,
      /\bpermission denied \(publickey\)\b/i,
    ],
  },
  {
    category: "machine",
    confidence: "high",
    reason: "the failure points at machine reachability or remote command execution",
    patterns: [
      /\bssh\b/i,
      /\btailscale\b/i,
      /\bno route to host\b/i,
      /\bhost .*unreachable\b/i,
      /\bconnection (?:timed out|refused)\b/i,
      /\bcould not resolve hostname\b/i,
      /\bmachine .*not found\b/i,
      /\bremote timeout\b/i,
    ],
  },
  {
    category: "stale_package",
    confidence: "high",
    reason: "the failure points at an out-of-date or broken dispatch install",
    patterns: [
      /\bunknown (?:option|command)\b/i,
      /\bcommand not found: dispatch\b/i,
      /\bdispatch: command not found\b/i,
      /\bCannot find module\b/i,
      /\bdist\/(?:cli|mcp|daemon)\b/i,
      /\bversion mismatch\b/i,
      /\bstale package\b/i,
      /\bbun install\b/i,
      /\b@hasna\/dispatch\b/i,
    ],
  },
  {
    category: "routing",
    confidence: "medium",
    reason: "the failure points at route selection or source-to-target mapping",
    patterns: [
      /\bsessions-query\b/i,
      /\broute\b/i,
      /\brouting\b/i,
      /\bno live sessions\b/i,
      /\btarget source\b/i,
      /\brunner\b/i,
      /\bbulk\b/i,
      /\bper-machine\b/i,
    ],
  },
  {
    category: "dispatch_bug",
    confidence: "medium",
    reason: "the failure looks like an unhandled dispatch implementation bug",
    patterns: [
      /\bTypeError\b/,
      /\bReferenceError\b/,
      /\bSyntaxError\b/,
      /\bUnhandled\b/i,
      /\binvariant\b/i,
      /\bstack trace\b/i,
      /\bat .*src\//,
      /\bsqlite\b/i,
      /\bpanic\b/i,
    ],
  },
];

export function redactSelfHealText(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  let redacted = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function diagnoseDispatchSelfHeal(input: DispatchSelfHealInput): DispatchSelfHealDiagnosis {
  const redacted = {
    target: redactSelfHealText(input.target),
    machine: redactSelfHealText(input.machine),
    route: redactSelfHealText(input.route),
    errorText: redactSelfHealText(input.errorText),
    statusText: redactSelfHealText(input.statusText),
  };
  const corpus = [input.target, input.machine, input.route, input.errorText, input.statusText].filter(Boolean).join("\n");
  const matched = RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(corpus)));
  const category = matched?.category ?? "unknown";
  const fallbackAllowed = input.legacyHandoffAuthorized === true;

  return {
    dryRun: true,
    mutates: false,
    category,
    confidence: matched?.confidence ?? "low",
    reason: matched?.reason ?? "no known dispatch failure signature matched the supplied context",
    recommendedAction: recommendedAction(category),
    nextActions: nextActions(category),
    repairRoute: repairRoute(category),
    fallbackPolicy: {
      tmuxPasteFallbackAllowed: fallbackAllowed,
      detail: fallbackAllowed
        ? "legacy/emergency tmux paste handoff was explicitly authorized by the user; keep it bounded and record evidence"
        : "tmux prompt paste fallback is forbidden; repair dispatch or create the owning-package follow-up task instead",
    },
    affectedMachineChecks: {
      check: ["spark01", "spark02", "apple03"],
      ignoreIfNonresponsive: ["apple01"],
    },
    redacted,
  };
}

export function formatSelfHealDiagnosis(diagnosis: DispatchSelfHealDiagnosis): string {
  const lines = [
    `self-heal diagnosis: ${diagnosis.category} (${diagnosis.confidence})`,
    `reason: ${diagnosis.reason}`,
    `recommended: ${diagnosis.recommendedAction}`,
    `dry-run: ${diagnosis.dryRun}; mutates: ${diagnosis.mutates}`,
    `tmux paste fallback: ${diagnosis.fallbackPolicy.tmuxPasteFallbackAllowed ? "authorized legacy/emergency only" : "forbidden"}`,
    `fallback detail: ${diagnosis.fallbackPolicy.detail}`,
    `affected machines: check ${diagnosis.affectedMachineChecks.check.join(", ")}; ignore ${diagnosis.affectedMachineChecks.ignoreIfNonresponsive.join(", ")} if nonresponsive`,
    `repair route: ${diagnosis.repairRoute}`,
    "next actions:",
    ...diagnosis.nextActions.map((action) => `  - ${action}`),
  ];
  if (diagnosis.redacted.target) lines.push(`target: ${diagnosis.redacted.target}`);
  if (diagnosis.redacted.machine) lines.push(`machine: ${diagnosis.redacted.machine}`);
  if (diagnosis.redacted.route) lines.push(`route: ${diagnosis.redacted.route}`);
  if (diagnosis.redacted.errorText) lines.push(`error: ${diagnosis.redacted.errorText}`);
  if (diagnosis.redacted.statusText) lines.push(`status: ${diagnosis.redacted.statusText}`);
  return lines.join("\n");
}

function recommendedAction(category: DispatchSelfHealCategory): string {
  switch (category) {
    case "target":
      return "refresh bounded target discovery, verify composer state, and rerun the original route as a dry run before delivery";
    case "auth":
      return "repair the target agent auth/profile state before dispatching again; do not report queued input as delivered";
    case "machine":
      return "check reachability and route resolution on the affected machine set before retrying dispatch";
    case "stale_package":
      return "pull, fix, test, publish, and update @hasna/dispatch on affected machines, then restart the daemon";
    case "routing":
      return "repair the route source or create the missing owning-package abstraction task instead of adding local glue";
    case "dispatch_bug":
      return "fix @hasna/dispatch with a regression test, publish/update, restart the daemon, and smoke the original route";
    case "unknown":
      return "capture bounded redacted evidence, classify manually, and file the smallest owning-package follow-up task";
  }
}

function repairRoute(category: DispatchSelfHealCategory): string {
  switch (category) {
    case "machine":
      return "open-machines owns durable machine reachability abstractions; open-dispatch owns delivery failures after a route is resolved";
    case "routing":
      return "open-dispatch owns dispatch route execution; open-todos/open-configs/open-machines own missing source, config, or machine abstractions";
    case "stale_package":
    case "dispatch_bug":
    case "target":
    case "auth":
    case "unknown":
      return "open-dispatch owns this diagnosis unless evidence proves the missing abstraction belongs in another open-* package";
  }
}

function nextActions(category: DispatchSelfHealCategory): string[] {
  const common = [
    "keep evidence bounded and redacted; never include API keys, tokens, credentials, or full prompt bodies",
    "do not use tmux prompt paste fallback unless the user explicitly authorized legacy/emergency handoff",
    "after repair, restart the dispatch daemon and smoke the original route first in dry-run/no-secret mode",
  ];
  switch (category) {
    case "target":
      return [
        "capture target metadata and a bounded redacted pane tail",
        "repair target selection or wait for a safe composer state",
        ...common,
      ];
    case "auth":
      return [
        "fix the agent auth/profile/account state at the target",
        "re-check queued input did not remain parked behind an auth transition",
        ...common,
      ];
    case "machine":
      return [
        "check spark01, spark02, and apple03 route health; ignore apple01 if it is nonresponsive",
        "repair SSH/Tailscale/@hasna/machines routing before retrying",
        ...common,
      ];
    case "stale_package":
      return [
        "pull the package source, make the smallest fix with tests, publish a patch, and update local/spark01/spark02/apple03 installs",
        "record any package-manager or machine-update gap as an owning-package todo",
        ...common,
      ];
    case "routing":
      return [
        "validate the route source and target mapping without sending a prompt",
        "create an owning-package follow-up todo for any missing source/config/machine abstraction instead of local scripts",
        ...common,
      ];
    case "dispatch_bug":
      return [
        "create or update the open-dispatch bug task with redacted evidence",
        "add a regression test before publishing and updating affected machines",
        ...common,
      ];
    case "unknown":
      return [
        "collect one more bounded redacted status or capture sample",
        "classify into target/auth/machine/stale_package/routing/dispatch_bug before mutating anything",
        ...common,
      ];
  }
}
