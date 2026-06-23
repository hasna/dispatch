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
}

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

  const visible = tmux.capturePane(target);
  const processTree = wrapper ? tmux.processTree(target, options.panePid) : "";
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
