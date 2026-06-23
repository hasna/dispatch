# Reliable delivery — how it works

The whole point of `dispatch` is that a prompt **actually lands and submits**, every time,
for any length. Three mechanisms make that true.

## 1. Long-prompt delivery without corruption (bracketed paste)

Typing a multi-line prompt with `tmux send-keys -l` sends each `\n` as an Enter keypress,
so the agent submits a partial prompt at the first newline. Instead, for long/multi-line
text `dispatch`:

1. loads the full text into a tmux buffer via `load-buffer -b <name> -` (stdin — any size
   or content is safe), then
2. pastes it with `paste-buffer -p` (**bracketed paste**).

When the receiving TUI has enabled bracketed-paste mode (Claude Code, Codex, modern
shells), tmux wraps the content in `ESC[200~ … ESC[201~`, so embedded newlines are treated
as **text, not submits**. The entire prompt arrives as one paste, intact.

Short single-line prompts use literal `send-keys -l --` (no newline = no early submit).
`--mode` forces `paste` or `literal`; `auto` (default) picks per prompt.

## 2. The flaky-Enter fix (auto-delay + retry)

After delivering the text, pressing Enter immediately often no-ops or submits before the
TUI has registered the whole prompt — the classic "text sits in the composer" bug.

`dispatch` waits an **auto-computed delay** first:

```
delay = clamp(min + words·msPerWord + chars·msPerChar, min, max)
```

so a longer prompt waits longer (defaults: min 150ms, max 4000ms, 9ms/word, 0.6ms/char;
all env- and flag-overridable). Then it presses **Enter**, and — if confirmation is on —
**re-presses Enter** until the delivery probe says it submitted, up to `--retries` (default
2). Submission becomes deterministic regardless of prompt length.

Queued active-agent delivery uses **Tab** only when target detection proves queue
support. Tab delivery is single-shot: dispatch does not retry Tab because repeated
Tabs can create duplicate queued follow-up inputs.

## 3. Smart delivery confirmation

`dispatch` doesn't assume success — it **verifies** by diffing the pane:

- captures the pane before dispatch and after submit,
- looks for a **working/interrupt indicator appearing** that wasn't there before
  (`esc to interrupt`, `thinking`, `working`, spinner frames, … — covers Claude Code,
  Codex, and generic TUIs), and/or
- the **prompt leaving the composer** (the distinctive tail of the prompt is no longer
  visible).

Either signal ⇒ **delivered**, with a human-readable `reason`. Prompt still sitting in the
composer ⇒ **not delivered**. `confirmDelivery` polls a few times so a slightly-delayed
indicator is still caught. Disable with `--no-confirm` for fire-and-forget.

Queued-message confirmation is fail-closed for known account/auth transition states.
If a Codewith pane shows auth-profile auto-switch/account-limit text while the prompt
is queued, dispatch records `delivered=false`, `actionNeeded=true`, and a reason that
the prompt is queued behind an auth profile/account switch. This avoids reporting
success when follow-up input is parked during a profile switch and may never drain.

## Tuning

| Variable / flag | Effect |
|---|---|
| `--delay <ms>` / `DISPATCH_MIN_DELAY_MS` / `DISPATCH_MAX_DELAY_MS` | Pre-Enter delay |
| `DISPATCH_MS_PER_WORD` / `DISPATCH_MS_PER_CHAR` | Auto-delay growth |
| `--retries <n>` | Enter retries before giving up; queued Tab delivery is single-shot |
| `--no-confirm` | Skip the confirmation probe |
| `--mode auto\|paste\|literal` | Force the delivery method |
