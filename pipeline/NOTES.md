# Implementation notes (Phase 0 pre-flight results)

Recorded while building; keep it up to date when the host pi changes.

## pi CLI flags used by the `llm` executor

Verified against `pi --help` (pi 0.84.x):

| Flag | Status |
|---|---|
| `--mode json` | ✅ NDJSON on stdout |
| `-p` / `--print` | ✅ non-interactive |
| `--no-session` | ✅ ephemeral, fresh context |
| `--model <id>` | ✅ accepts `provider/id[:thinking]` |
| `--tools <csv>` | ✅ allowlist of tool names |
| `--append-system-prompt <text|path>` | ✅ **text or file path** |

Because `--append-system-prompt` accepts literal text and we spawn with
`shell: false`, the plan's `writeTempPrompt` helper was dropped: the text is
passed straight through as one argv entry and only its sha256 is recorded in
`step.json`.

## Observed `pi --mode json` event stream

First line is the session header, then agent events (docs/json.md). Names the
executor depends on — pinned here and mirrored in `test/fixtures/fake-pi.mjs`,
which doubles as a contract test:

```
{"type":"session","version":3,"id":…,"cwd":…}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{…}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"text_delta","delta":"…"}}
{"type":"tool_execution_start","toolCallId":…,"toolName":"bash","args":{…}}
{"type":"tool_execution_end","toolCallId":…,"toolName":"bash","result":{…},"isError":false}
{"type":"message_end","message":{…}}
{"type":"turn_end","message":{…},"toolResults":[…]}
{"type":"agent_end","messages":[…]}
```

Consumed by `executors/llm.ts`:

- `tool_execution_end` → a `progress` event (`{ tool, isError }`).
- `message_end` with `message.role === "assistant"` → one "turn"; final
  assistant text comes from the `content[]` entries of type `text`;
  `message.usage` is `{ input, output, cacheRead, cacheWrite, totalTokens,
  cost: { total } }` (older shapes with a scalar `cost` are also tolerated);
  `message.model`, `message.stopReason` and `message.errorMessage` are picked
  up as well.

**Deviation from the spec, deliberate:** a sub-pi that hits a provider error
still exits 0 with an empty answer (observed: `stopReason: "error"`,
`errorMessage: "Connection error."`). Treating that as success would silently
feed empty strings into downstream `${steps.…}` references, so
`ok = exitCode === 0 && !aborted && !errorMessage`. The last `message_end`
wins, so a successful retry clears an earlier error.

## `getPiInvocation`

Same strategy as the `dual-finalcheck` extension:

1. If `process.argv[1]` exists on disk (and isn't a `/$bunfs/root/` virtual
   script) → `process.execPath <script> …`.
2. Else if `process.execPath` is not a generic `node`/`bun` binary → it is the
   pi binary itself.
3. Else fall back to `pi` on `PATH`.

Overridable with the `pipeline.piBin` setting (also how the tests point the
executor at `test/fixtures/fake-pi.mjs`).

## Extension API surface actually used

- `pi.registerCommand(name, { description, getArgumentCompletions, handler })`
- `pi.registerTool({ name, label, description, promptSnippet, parameters, execute })`
- `ctx.cwd`, `ctx.hasUI`, `ctx.ui.notify`, `ctx.ui.setWidget`, `ctx.ui.editor`
- `ctx.signal` — present during a turn; command handlers may get `undefined`,
  so `executeRun` always creates its own `AbortController` and merely chains
  the host signal when there is one.

Command modules depend on a structural `CmdCtx` type (`commands/ctx.ts`)
rather than importing pi's types, so they stay unit-testable with a plain
mock object.

## Platform notes

- Children are spawned `detached: true` and killed with `process.kill(-pid)`
  so `/bin/sh -c "a | b"` pipelines die as a group. POSIX only; Windows is
  not supported.
- `index.jsonl` uses `O_APPEND` plus a lock directory. `runsDir` should live
  on a local filesystem — advisory locking over NFS/SMB is not reliable.
