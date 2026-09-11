# Pipeline extension — interactive LLM steps

Add support for RPC-mode LLM steps so pipelines can pause for a human chat
before producing their `output`, then continue. All primitives already exist
in pi (see `docs/rpc.md`, `docs/tui.md`, `docs/extensions.md`); this is
extension work only.

## Motivation

Today `executors/llm.ts` spawns `pi --mode json -p --no-session` — a single
non-interactive turn. Skills like `code-review-local` that need parameters
(e.g. `BASE_SHA`, `WHAT_WAS_IMPLEMENTED`) respond by asking the user a
question, but the executor has no stdin path and no UI surface, so the step
"succeeds" with an empty answer and the pipeline moves on. See
`~/.pi/pipelines/runs/01M1N7S0F1174VRH2YVB8MG1Z1/steps/review/trace.jsonl`
for the reference failure.

## New per-step config

Extend `LlmStepConfig` in `core/types.ts`:

```ts
model?: string;                     // existing; supports provider/id:thinking
reasoning?: "low" | "medium" | "high" | "xhigh"; // sugar → appended to model
prompt?: string;                    // existing, inline
promptFile?: string;                // NEW: path to .md/.txt, read at plan time
mode?: "oneshot" | "rpc";           // NEW, default "oneshot"
saveSession?: boolean;              // NEW; if true, drop --no-session
nonInteractiveFallback?: "error" | "oneshot"; // NEW; behavior when hasUI=false
```

Validator rules:

- Exactly one of `prompt` / `promptFile` / `skill` / `command`.
- `promptFile` is read once at plan time; both the resolved text and its
  sha256 land in `plan.json` (mirror the `appendSystemPrompt` pattern).
- `mode: rpc` with no UI must either hard-fail or degrade to `oneshot`
  based on `nonInteractiveFallback` (default: `error`).

## Executor split

`executors/llm.ts` splits into two paths sharing state folding:

### `runOneshot` (today's behavior)
Unchanged: `pi --mode json -p --no-session …`, child exit is completion.

### `runInteractive` (new)
- Spawn `pi --mode rpc [--model …] [--name step-<id>] [--no-session|omitted]`.
- Initial prompt goes in as an RPC frame:
  `{"id":"init","type":"prompt","message":"<built prompt>"}`.
- Fold `type:"response"` frames plus the existing agent event stream.
- Register the child in a new `InteractiveRegistry` under key
  `${runId}:${stepId}`.
- Completion resolves on **`finalize()`**, not on child exit. Two finalize
  modes exposed in the chat pane:
  - **Explicit-final** (default): user's last message is sent, we wait for
    the next `message_end`, that becomes `output`, close stdin.
  - **Post-hoc-final**: last assistant message already in the transcript
    becomes `output`, no extra round trip.
- Abort semantics: closing the chat pane does **not** kill the child;
  only `/pipeline finalize` or a session-level abort does.

## Supporting infrastructure

### `executors/spawn.ts`
- Change `stdio` to `["pipe","pipe","pipe"]`.
- Expose `write(line)` and `closeStdin()` on the child handle.
- `LineSplitter` stays LF-only (docs/rpc.md warns against `readline`; we're
  already compliant).

### New `core/interactive-registry.ts`
Process-wide `Map<string, ChatHandle>`:

```ts
type ChatState = "idle" | "streaming" | "awaiting-input" | "finalizing";
type ChatHandle = {
  runId: string;
  stepId: string;
  state: ChatState;
  transcript: TranscriptEntry[];
  send(msg: string, images?: ImageContent[]): void;      // -> stdin prompt/steer
  finalize(mode: "explicit" | "post-hoc"): Promise<void>;
  abort(): void;
  on(event: "state" | "message", cb: (…) => void): () => void;
};
```

State transitions emit events the widget and status badge subscribe to.
While `state === "streaming"`, new user messages are sent with
`streamingBehavior: "steer"` (configurable per step).

### `core/runner.ts`
- A step in `awaiting-input` is "not done yet"; the scheduler treats it
  like a slow oneshot step. Sibling parallel branches keep running.
- New settings knob `interactiveConcurrency` (default e.g. 4) caps how
  many RPC children can be live at once to prevent fork-bombing.
- `steps.<id>.output` remains undefined until `finalize()` resolves;
  downstream steps that reference it block exactly like today.

### `index.ts` (extension entrypoint)
Register:

- `/pipeline chat [stepId]` — opens a `ctx.ui.custom({ overlay: true })`
  chat pane bound to the handle. Enter sends. Hotkey (e.g. `Ctrl+D`)
  toggles "Finalize after next reply"; another (e.g. `Ctrl+Enter`) does
  "Finalize now" (post-hoc). Esc detaches without killing the child.
- `/pipeline chats` — selectlist of active chats with state markers,
  jump into one.
- `/pipeline finalize <stepId> [--post-hoc]` — declarative finalize for
  scripting from another pane.
- `ctx.ui.setWidget("pipeline-chats", …)` — always-visible list above the
  editor, dim/muted for idle/streaming, `●` accent for awaiting-input,
  with elapsed time.
- `ctx.ui.setStatus("pipeline", …)` — footer badge, e.g.
  `pipeline: 2 chats · 1 awaiting`.
- `ctx.ui.notify()` on any `idle → awaiting-input` transition.

## Rollout slice (first PR)

Keep it small and prove the plumbing end-to-end:

1. `spawn.ts` stdin support.
2. `LlmStepConfig`: `mode`, `promptFile`, `reasoning`.
3. `runInteractive` in `llm.ts` + minimal `InteractiveRegistry`.
4. One `/pipeline chat` command with a bare-bones chat pane
   (no multi-chat widget, no status badge, no notify).
5. `nonInteractiveFallback: "error"` by default.

That alone would have unblocked the `code-review-local` run. Everything
else (concurrent-chat widget, status/notify, selectlist switcher, session
persistence, custom finalize hotkeys) layers on top without changing the
executor contract.

## Open decisions to lock before coding

- Default `streamingBehavior` for typed-during-streaming messages:
  `"steer"` vs `"followUp"`. Recommend `steer`; expose a toggle.
- Default for `saveSession`: on (so `--resume` works after crash) vs off
  (isolation). Recommend on for `mode:rpc`, off for `mode:oneshot`.
- Whether `mode: rpc` without a UI ever auto-degrades. Recommend
  `error` by default; CI opts in via `nonInteractiveFallback: "oneshot"`.
- Whether pipeline crash mid-chat leaves a resumable session or just
  goes to `partial` status. Recommend `partial` + document the limit.

## Non-goals

- Cross-process chat handoff (e.g. attaching from a second pi instance).
- Persisting the chat pane across pi restarts.
- Structured "form" prompts — the chat pane is free text only in v1.
