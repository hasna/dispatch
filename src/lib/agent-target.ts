import type { ExecTargetKind } from "../types.js";
import { classifyPaneCommand, isAgentWrapperCommand, looksLikeWrappedAgentComposer } from "./exec-policy.js";
import { Tmux } from "./tmux.js";

export interface AgentComposerTargetResult {
  ok: boolean;
  paneCommand: string;
  targetKind?: ExecTargetKind;
  detail?: string;
}

/** Validate that a tmux pane is a live agent composer, not a shell or stale transcript. */
export function validateAgentComposerTarget(tmux: Tmux, target: string): AgentComposerTargetResult {
  const machine = tmux.machine;
  if (!tmux.paneExists(target)) {
    return {
      ok: false,
      paneCommand: "",
      detail: `target pane not found: ${target} (machine: ${machine})`,
    };
  }

  const paneCommand = tmux.paneProperty(target, "pane_current_command");
  const targetKind = classifyPaneCommand(paneCommand);
  if (targetKind === "shell") {
    return {
      ok: false,
      paneCommand,
      targetKind,
      detail: `target appears to be a shell (${paneCommand || "unknown"}); use dispatch exec for shell commands`,
    };
  }

  // If the pane is scrolled into copy-mode, visible captures can show stale
  // scrollback. Exit first so wrapper safety checks inspect the live process.
  try {
    if (tmux.paneInMode(target) && !tmux.exitCopyMode(target)) {
      return {
        ok: false,
        paneCommand,
        targetKind,
        detail: "target is in tmux copy-mode or another pane mode; refusing prompt delivery until mode exits",
      };
    }
  } catch {
    return {
      ok: false,
      paneCommand,
      targetKind,
      detail: "could not verify target left tmux copy-mode; refusing prompt delivery",
    };
  }

  if (targetKind === "agent") {
    return { ok: true, paneCommand, targetKind };
  }

  if (!isAgentWrapperCommand(paneCommand)) {
    return {
      ok: false,
      paneCommand,
      targetKind,
      detail: `target is not a recognized agent composer (${paneCommand || "unknown"}); refusing prompt delivery`,
    };
  }

  const visibleBefore = tmux.capturePane(target);
  const processTree = tmux.processTree(target);
  if (!looksLikeWrappedAgentComposer(visibleBefore, { processTree })) {
    return {
      ok: false,
      paneCommand,
      targetKind,
      detail: `target is not a recognized agent composer (${paneCommand || "unknown"}); refusing prompt delivery`,
    };
  }

  return { ok: true, paneCommand, targetKind };
}
