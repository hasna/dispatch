import type { AgentActivityState, AgentTargetInfo, ExecTargetKind } from "../types.js";
import { classifyPaneCommand, detectAgentTargetFromSignals, isAgentWrapperCommand } from "./exec-policy.js";
import { Tmux } from "./tmux.js";

export interface AgentComposerTargetResult {
  ok: boolean;
  paneCommand: string;
  targetKind?: ExecTargetKind;
  activity?: AgentActivityState;
  detection?: AgentTargetInfo;
  visible?: string;
  detail?: string;
}

export interface InspectTargetOptions {
  /** Exit tmux copy-mode before capture so delivery checks inspect live UI. */
  prepareForDelivery?: boolean;
  /** Target came from list-panes, so skip the extra existence probe. */
  assumeExists?: boolean;
  paneCommand?: string;
  cwd?: string;
  panePid?: string;
  /** Bound the captured text retained for classification. */
  maxCaptureChars?: number;
  /** Bound process-tree probing for target discovery. */
  maxProcessTreeLines?: number;
  /** Bound each process-tree command line for target discovery. */
  maxProcessTreeLineChars?: number;
}

export const TARGET_DISCOVERY_CAPTURE_MAX_CHARS = 24_000;
export const TARGET_DISCOVERY_PROCESS_MAX_LINES = 80;
export const TARGET_DISCOVERY_PROCESS_MAX_LINE_CHARS = 1000;

/** Inspect target kind, agent kind, composer state, and submit capabilities. */
export function inspectAgentTarget(tmux: Tmux, target: string, options: InspectTargetOptions = {}): AgentComposerTargetResult {
  const machine = tmux.machine;
  if (!options.assumeExists && !tmux.paneExists(target)) {
    return {
      ok: false,
      paneCommand: "",
      detail: `target pane not found: ${target} (machine: ${machine})`,
    };
  }

  const paneCommand = options.paneCommand ?? tmux.paneProperty(target, "pane_current_command");
  const cwd = options.cwd ?? tmux.paneProperty(target, "pane_current_path");
  const commandKind = classifyPaneCommand(paneCommand);
  const wrapper = isAgentWrapperCommand(paneCommand);
  if (commandKind === "shell" || (!wrapper && commandKind !== "agent")) {
    const detection = detectAgentTargetFromSignals({ paneCommand, cwd });
    return {
      ok: false,
      paneCommand,
      targetKind: detection.targetKind,
      activity: detection.composerState,
      detection,
      detail: detection.reason,
    };
  }

  if (options.prepareForDelivery) {
    // If the pane is scrolled into copy-mode, visible captures can show stale
    // scrollback. Exit first so wrapper safety checks inspect the live process.
    try {
      if (tmux.paneInMode(target) && !tmux.exitCopyMode(target)) {
        return {
          ok: false,
          paneCommand,
          targetKind: "unknown",
          detail: "target is in tmux copy-mode or another pane mode; refusing prompt delivery until mode exits",
        };
      }
    } catch {
      return {
        ok: false,
        paneCommand,
        targetKind: "unknown",
        detail: "could not verify target left tmux copy-mode; refusing prompt delivery",
      };
    }
  }

  const visible = tmux.capturePane(target, { maxChars: options.maxCaptureChars });
  const processTree = wrapper
    ? tmux.processTree(target, options.panePid, {
        maxLines: options.maxProcessTreeLines,
        maxLineChars: options.maxProcessTreeLineChars,
      })
    : "";
  const detection = detectAgentTargetFromSignals({ paneCommand, visible, processTree, cwd });
  if (detection.targetKind !== "agent" || detection.agentKind === "unknown") {
    return {
      ok: false,
      paneCommand,
      targetKind: detection.targetKind,
      activity: detection.composerState,
      detection,
      visible,
      detail: detection.reason,
    };
  }

  return {
    ok: true,
    paneCommand,
    targetKind: detection.targetKind,
    activity: detection.composerState,
    detection,
    visible,
  };
}

/** Validate that a tmux pane is a live agent composer, not a shell or stale transcript. */
export function validateAgentComposerTarget(tmux: Tmux, target: string): AgentComposerTargetResult {
  return inspectAgentTarget(tmux, target, { prepareForDelivery: true });
}

/** Bounded inspection used by `dispatch targets` and MCP target discovery. */
export function inspectListedAgentTarget(
  tmux: Tmux,
  target: string,
  options: Omit<InspectTargetOptions, "maxCaptureChars" | "maxProcessTreeLines" | "maxProcessTreeLineChars"> = {},
): AgentComposerTargetResult {
  return inspectAgentTarget(tmux, target, {
    ...options,
    maxCaptureChars: TARGET_DISCOVERY_CAPTURE_MAX_CHARS,
    maxProcessTreeLines: TARGET_DISCOVERY_PROCESS_MAX_LINES,
    maxProcessTreeLineChars: TARGET_DISCOVERY_PROCESS_MAX_LINE_CHARS,
  });
}
