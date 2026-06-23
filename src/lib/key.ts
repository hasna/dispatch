import type { AllowedSpecialKey, DispatchRecord, KeyOptions } from "../types.js";
import type { Store } from "./store.js";
import { validateAgentComposerTarget } from "./agent-target.js";
import { genId, nowIso } from "./ids.js";
import { Tmux } from "./tmux.js";

export const ALLOWED_SPECIAL_KEYS: readonly AllowedSpecialKey[] = [
  "Enter",
  "Tab",
  "Escape",
  "Up",
  "Down",
  "Left",
  "Right",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
];

const KEY_ALIASES = new Map<string, AllowedSpecialKey>([
  ["enter", "Enter"],
  ["return", "Enter"],
  ["tab", "Tab"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["up", "Up"],
  ["uparrow", "Up"],
  ["arrowup", "Up"],
  ["down", "Down"],
  ["downarrow", "Down"],
  ["arrowdown", "Down"],
  ["left", "Left"],
  ["leftarrow", "Left"],
  ["arrowleft", "Left"],
  ["right", "Right"],
  ["rightarrow", "Right"],
  ["arrowright", "Right"],
  ["backspace", "Backspace"],
  ["bs", "Backspace"],
  ["delete", "Delete"],
  ["del", "Delete"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["page-up", "PageUp"],
  ["pagedown", "PageDown"],
  ["page-down", "PageDown"],
]);

export interface KeyDeps {
  tmux: Tmux;
  store?: Store;
}

export function normalizeSpecialKey(key: string): AllowedSpecialKey | undefined {
  return KEY_ALIASES.get(key.trim().toLowerCase());
}

export function keyAuditPrompt(key: AllowedSpecialKey): string {
  return `<key:${key}>`;
}

function safeKeyPreview(key: string): string {
  const trimmed = key.length > 80 ? `${key.slice(0, 80)}...` : key;
  return JSON.stringify(trimmed);
}

/** Validate, audit, and deliver a safe named key to a live agent composer. */
export async function performKeyDispatch(options: KeyOptions, deps: KeyDeps): Promise<DispatchRecord> {
  const { tmux, store } = deps;
  const machine = tmux.machine;
  const normalizedKey = normalizeSpecialKey(options.key);
  const prompt = normalizedKey ? keyAuditPrompt(normalizedKey) : `<key:blocked>`;

  let record: DispatchRecord = store
    ? store.createDispatch({
        kind: "key",
        target: options.target,
        machine,
        prompt,
        status: "sending",
      })
    : {
        id: genId(),
        kind: "key",
        target: options.target,
        machine,
        prompt,
        status: "sending",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };

  const finish = (patch: Partial<DispatchRecord>): DispatchRecord => {
    record = { ...record, ...patch, updatedAt: nowIso() };
    if (store) {
      record = store.updateDispatch(record.id, {
        status: record.status,
        detail: record.detail,
        deliveredAt: record.deliveredAt,
        targetState: record.targetState,
        detection: record.detection,
      });
    }
    return record;
  };

  if (!normalizedKey) {
    return finish({
      status: "skipped",
      detail: `special key is not allowlisted: ${safeKeyPreview(options.key)}. Allowed keys: ${ALLOWED_SPECIAL_KEYS.join(", ")}`,
    });
  }

  const target = validateAgentComposerTarget(tmux, options.target);
  if (!target.ok) {
    return finish({
      status: "failed",
      detail: target.detail,
      targetState: target.activity,
      detection: target.detection,
    });
  }
  record = { ...record, targetState: target.activity, detection: target.detection };

  if (normalizedKey === "Enter" && target.detection?.canReceivePrompt !== true) {
    return finish({
      status: "skipped",
      detail: `refusing Enter key because target cannot receive a prompt safely (${target.detection?.reason ?? "no detection available"})`,
      targetState: target.activity,
      detection: target.detection,
    });
  }
  if (normalizedKey === "Tab") {
    if (!target.detection?.submitKeys.includes("Tab")) {
      return finish({
        status: "skipped",
        detail: `refusing Tab key because target does not advertise Tab support (${target.detection?.reason ?? "no detection available"})`,
        targetState: target.activity,
        detection: target.detection,
      });
    }
    if (target.activity === "active" && target.detection.canQueuePrompt !== true) {
      return finish({
        status: "skipped",
        detail: `refusing Tab key because active target does not prove queued prompt support (${target.detection.reason})`,
        targetState: target.activity,
        detection: target.detection,
      });
    }
  }

  try {
    tmux.sendKey(options.target, normalizedKey);
  } catch (err) {
    return finish({ status: "failed", detail: `key delivery failed: ${(err as Error).message}` });
  }

  return finish({
    status: "delivered",
    detail: `sent key ${normalizedKey} to agent composer`,
    targetState: target.activity,
    detection: target.detection,
    deliveredAt: nowIso(),
  });
}
