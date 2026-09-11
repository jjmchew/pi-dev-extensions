# pipeline

Run discrete "scripts" made of shell commands and isolated LLM turns, composed
with `sequence:` and `parallel:`. Pipelines live in `.pi/pipelines/*.yaml` and
run **outside** the agent loop — `/pipeline checks` costs no tokens in your
current session; each `llm:` step gets its own headless sub-`pi` process with a
fresh context.

```yaml
# .pi/pipelines/checks.yaml
name: checks
sequence:
  - parallel:
      - shell: yarn lint
        id: lint
      - shell: yarn test:unit
        id: tests
        continueOnError: true
  - llm:
      skill: code-review
    id: review
    when: success(lint)
```

```
/pipeline checks
✓ pipeline checks: ok — 3/3 ok in 41.2s
  01JBQ3W7… · /pipeline:show 01JBQ3W7…
```

## Commands and tool

| Surface | What it does |
|---|---|
| `/pipeline <name> [args] [--runs-dir p] [--timeout ms] [--json]` | Run a pipeline |
| `/pipeline:list` | Discovered pipelines, source paths, shadowing |
| `/pipeline:new <name>` | Scaffold `.pi/pipelines/<name>.yaml` |
| `/pipeline:edit <name>` | Edit in pi's editor (or `$EDITOR`) |
| `/pipeline:runs [--limit n]` | Recent runs from `index.jsonl` |
| `/pipeline:show <runId> [--json]` | Run manifest + step tree |
| `/pipeline:trace <runId> <stepId> [--raw]` | Replay an llm step's trace |
| `run_pipeline({ name, args?, runsDir?, timeoutMs? })` | Same run path, callable by the model |

Every `/pipeline[:sub]` command also has a shorter alias `/pl[:sub]` (e.g.
`/pl checks`, `/pl:chat review`, `/pl:show <runId>`).

Headless: `pi -p --no-session "/pipeline checks"` streams NDJSON events on
stdout (CI, git hooks).

## YAML reference

The root must contain **exactly one** composer key — `sequence:` or
`parallel:` — plus optional metadata: `name`, `description`, `cwd`, `env`,
`runsDir`, `timeoutMs`. There is no implicit `steps:`.

### Composers

```yaml
sequence:            # stops at the first failure
  - <child>

parallel:            # waits for all by default
  - <child>

parallel:            # object form, when you need knobs
  failFast: true     # abort outstanding siblings on first failure
  maxConcurrency: 4  # default 8
  children:
    - <child>
```

### Steps

Any list item whose key is a registered executor kind (`shell:`, `llm:`, plus
anything a third-party extension registers) is a step. Step knobs sit as
**sibling keys**, never inside the kind:

```yaml
- shell: yarn test:unit     # string form → /bin/sh -c (pipes, redirection)
  id: tests                 # explicit id — required to reference this step
  cwd: packages/api         # relative to the invocation cwd
  env: { CI: "1" }
  timeoutMs: 300000
  continueOnError: true
  outputVar: testLog        # capture output at steps.tests.vars.testLog
  when: always()

- shell:                    # object form → direct exec, no shell
    cmd: yarn
    args: [lint]

- llm:                      # exactly one of skill:, command:, prompt:, or promptFile:
    skill: code-review      # → runs "/skill:code-review <args>" in a sub-pi
    # command: dual-finalcheck  # → runs "/dual-finalcheck <args>" (extension slash command)
    # prompt: "summarize the diff"     # inline prompt text
    # promptFile: ./prompts/review.md  # read at plan time; sha256 recorded
    args: "src/"
    model: anthropic/claude-opus-4-7
    reasoning: high         # sugar → appended to model as ":high"
    tools: [read, bash]
    appendSystemPrompt: "Be terse."
    mode: oneshot           # default; "rpc" makes the step interactive
    nonInteractiveFallback: error   # rpc-only; "oneshot" degrades when no UI
  id: review
```

### `when:` helpers

Evaluated immediately before dispatch. Closed set — no arithmetic, no
user-defined functions.

| Helper | Meaning |
|---|---|
| `success(id, …)` | all listed steps ended `ok` (**skipped counts as success**) |
| `failure(id, …)` | at least one listed step failed |
| `skipped(id, …)` | step was gated out (own `when:` or an ancestor being skipped) |
| `always()` | run regardless of prior outcomes (still respects abort) |
| `never()` | disable without deleting |
| `contains(v, s)` | substring test, e.g. `contains(steps.tests.stderr, "flaky")` |
| `equals(a, b)` | string equality |
| `matches(v, /re/)` | regex test |

Combine with `&&`, `\|\|`, `!` and parens. For "actually ran and passed",
write `!skipped(x) && success(x)`.

### `llm:` step options

| Key | Values | Notes |
|---|---|---|
| `skill` | skill name | Sent as `/skill:<name>` to the sub-pi. |
| `command` | slash-command name | Sent as `/<name>`; targets extension-registered commands. |
| `prompt` | free-form text | Inline prompt text. |
| `promptFile` | path (rel. to pipeline file) | Read at plan time; text goes into `prompt`, sha256 recorded in `step.json` and `plan.json`. |
| `args` | string | Appended to the skill/command invocation or joined onto `prompt` with a blank line. |
| `model` | `provider/id[:thinking]` | Passed as `--model` to the sub-pi. |
| `reasoning` | `low` \| `medium` \| `high` \| `xhigh` | Sugar: appended to `model` as `:<level>` unless `model` already carries an explicit `:level`. |
| `tools` | `[name, …]` | Passed as `--tools a,b,c`. |
| `appendSystemPrompt` | string | Appended to the sub-pi system prompt; text is hashed (`sha256:…`) in `step_start` so secrets don't leak into logs. |
| `mode` | `oneshot` (default) \| `rpc` | `oneshot` runs `pi --mode json -p --no-session`; `rpc` runs `pi --mode rpc` and blocks the step until a `/pipeline:chat` pane calls `finalize()`. |
| `nonInteractiveFallback` | `error` (default) \| `oneshot` | Only meaningful with `mode: rpc`. Chooses between hard-failing and degrading to a oneshot turn when no interactive UI is attached (e.g. CI). |

Exactly one of `skill` / `command` / `prompt` / `promptFile` is required.

### Interactive (`mode: rpc`) steps

`mode: rpc` spawns `pi --mode rpc` for the step, sends the built prompt as
the initial frame, and registers a chat handle keyed by
`${runId}:${stepId}`. The step does **not** finish on child exit — it blocks
until a chat pane finalizes it, so a skill that needs to ask the user for
parameters can actually get an answer.

```yaml
sequence:
  - id: review               # explicit id — required so /pipeline:chat can find it
    llm:
      skill: code-review-local
      args: "src/foo.ts"
      mode: rpc
      model: anthropic/claude-opus-4-7
      reasoning: high
      nonInteractiveFallback: oneshot   # optional; makes this step CI-safe
```

Driving the chat from another pane while the pipeline runs:

```
/pipeline:chat review
▸ (your reply)
◂ (assistant reply)
… (blank submit → end on the next assistant turn)
```

- Blank submit → `finalize("explicit")` if you just sent a message, otherwise
  `finalize("post-hoc")` (use the last assistant text already on record).
- `/end` → wait for the next assistant turn, then close (explicit).
- `/end-now` → close immediately using the last assistant text on record (post-hoc).
- `/abort` → SIGTERM the child.
- `Esc` → detach from the pane without killing the child; another
  `/pipeline:chat <stepId>` re-attaches.

Without an interactive UI (headless `pi -p`, CI hooks) a `mode: rpc` step
hard-fails at dispatch unless `nonInteractiveFallback: oneshot` is set.

### Addressing and interpolation

Two namespaces, day one:

- `${VAR}` / `${env.VAR}` — merged environment. Built-ins: `PIPELINE_CWD`,
  `REPO_ROOT`, `GIT_BRANCH`, `GIT_COMMIT`, `RUN_ID`. Expanded **eagerly at
  plan freeze** (what runs is what `plan.json` records). A miss yields `""`
  and a `progress` event.
- `${steps.<id>.<field>}` — prior step results, expanded **at dispatch**.
- `${args}` — the opaque argument string from `/pipeline <name> <args>`.

| Field | `shell` | `llm` |
|---|---|---|
| `ok`, `skipped`, `durationMs` | ✓ | ✓ |
| `exitCode` | ✓ | — |
| `output` | stdout tail (≤4 KB) | final assistant text |
| `stderr` | stderr tail (≤4 KB) | — |
| `usage`, `turns` | — | ✓ |
| `vars.<name>` | when `outputVar` is set | when `outputVar` is set |

**Load-time checks** (they fail before anything runs): references must point
at an *explicit* id that is guaranteed to finish first — a sibling of the same
`parallel:` block is an error — and `<field>` must be well known for the
producer's kind, or `vars.<name>` matching its `outputVar`.

#### Idioms

Consume raw stdout in a downstream shell:

```yaml
sequence:
  - shell: "git diff --name-only origin/main"
    id: changed
  - shell:
      cmd: sh
      args: ["-c", "echo '${steps.changed.output}' | wc -l"]
    id: count
```

Feed a shell result into an `llm:` prompt, gated on failure:

```yaml
sequence:
  - shell: "cargo build --message-format=json 2>&1"
    id: build
    continueOnError: true
  - llm:
      prompt: |
        Build exited ${steps.build.exitCode}. Errors:
        ${steps.build.stderr}
    id: fix
    when: failure(build)
```

Pipe an LLM answer into a shell arg — use `shell:` object form so the value
isn't re-parsed by a shell:

```yaml
sequence:
  - llm:
      prompt: "One-line commit message for the staged diff."
    id: msg
    outputVar: commitMsg
  - shell:
      cmd: git
      args: ["commit", "-m", "${steps.msg.vars.commitMsg}"]
    id: commit
```

Hand structured data through a file when it won't fit in a tail:

```yaml
sequence:
  - shell: "cargo build --message-format=json > $PIPELINE_CWD/.build.json 2>&1"
    id: build
  - shell: >-
      jq '[.[] | select(.reason=="compiler-message")] | length'
        $PIPELINE_CWD/.build.json
    id: errcount
```

`${args}` (positional args from `/pipeline <name> <args>`) is a fine way to
parameterise without a wrapper: `- shell: "eslint ${args}"`.

#### Caveats

- **`output` / `stderr` are tails**, not the full stream (`outputTailBytes`,
  default 4096; see `executors/spawn.ts::Tail`). Full logs always live at
  `steps/<id>/{stdout,stderr}.log` — read them directly for anything larger.
- **Interpolation is raw text substitution**, not shell-safe quoting. For
  values that can contain metacharacters (`'`, `$`, spaces, newlines), prefer
  `shell:` object form (`cmd + args`, direct `execvp` — no shell involved) or
  route through a file.
- **Object values are `JSON.stringify`d.** `${steps.foo.usage}` splices in
  `{"input":100,…}`; use the dotted scalar `${steps.foo.usage.cost}` instead.
- **Missing refs are soft.** Unknown paths expand to `""` and emit a
  `progress` event `{ interpolationMiss: "steps.…" }`. Grep
  `events.jsonl` (or the trace) when a step silently misbehaves.
- **`llm:` step output is the final assistant text only.** For the raw
  tool-call stream, read `steps/<id>/trace.jsonl` — that's not reachable
  through `${steps.…}`.
- **No forward references.** Producer must be finished before consumer
  dispatches; the load-time check catches sibling refs inside the same
  `parallel:` block.

## Completion, failure and abort

- A step completes when its child process exits: `ok = exitCode === 0 &&
  !aborted`. For `llm` steps a provider error also fails the step even though
  the child exited 0 (see NOTES.md).
- `sequence:` stops at the first failure unless that step sets
  `continueOnError: true`; everything downstream is marked **skipped**.
- `parallel:` waits for all; `failFast: true` aborts outstanding siblings.
- Abort (Esc, `failFast`, step `timeoutMs`, run `--timeout`) propagates as
  SIGTERM → SIGKILL after `abortGraceMs` (default 2000 ms) to the whole
  process group.
- Run status: `ok` (nothing failed) · `failed` (a failure cut the run short) ·
  `partial` (failures, but the run was allowed to finish) · `aborted`.

## Run logs

Default location `~/.pi/pipelines/runs/` (global, so traces survive
worktree pruning). Override order: `--runs-dir` > YAML `runsDir:` >
`pipeline.runsDir` setting > default.

```
<runsDir>/
├── index.jsonl                 one line per run (O_APPEND + advisory lock)
└── <runId>/                    ULID, time-sortable
    ├── run.json                manifest, written atomically at run_end
    ├── run.partial.json        exists only while the run is in flight
    ├── plan.json               frozen, env-expanded Plan IR
    ├── events.jsonl            every StepEvent, in order, `t`-stamped
    ├── steps/<stepId>/
    │   ├── step.json           summary: timings, usage, redaction counts
    │   ├── stdout.log          streamed, redacted
    │   ├── stderr.log
    │   └── trace.jsonl         llm only: verbatim sub-pi events (NOT redacted)
    └── artifacts/
        ├── sha256/<hh>/<hash>  content-addressed blobs
        └── refs/<step>.<name>.json  { sha256, mime, bytes, note }
```

Event names on the wire and on disk are identical — reporters never rename.

**Secrets.** `run.json` records only an env allowlist (`PATH`, `HOME`, `USER`,
`LANG`, `TERM`, `SHELL`, plus the built-ins). A regex redactor rewrites known
secret shapes to `«redacted:kind»` in `log` events (so in `stdout.log`,
`stderr.log` and the log chunks inside `events.jsonl`) and records the counts
in `step.json`. `trace.jsonl` and step results are **not** redacted — that
preserves eval fidelity and keeps `${steps.…}` data flow intact.

**Retention.** GC runs asynchronously at extension load under
`<runsDir>/.gc.lock`: `keepLast: 200`, `keepDays: 30`, failures kept forever,
in-progress runs (no `run.json`) skipped. Artifacts live inside their run
directory, so deleting a run reclaims them.

## Settings

`~/.pi/agent/settings.json`:

```json
{
  "pipeline": {
    "runsDir": "~/.pi/pipelines/runs",
    "piBin": "/usr/local/bin/pi",
    "outputTailBytes": 4096,
    "abortGraceMs": 2000,
    "envAllowlist": ["PATH", "HOME", "CI"],
    "redactPatterns": [{ "kind": "internal-token", "pattern": "tok_[a-z0-9]{20}" }],
    "reporters": { "file": true, "trace": true, "json": true },
    "retention": { "keepLast": 200, "keepDays": 30, "keepFailures": true }
  }
}
```

## Extending

The four seams are plain registries (`core/registry.ts`) — another extension
can `import` them and add its own kinds:

```ts
import { registerExecutor } from "~/.pi/agent/extensions/pipeline/core/registry.ts";

registerExecutor({
  kind: "http",
  resultFields: ["output", "status"],
  async *run(step, ctx) {
    yield { type: "step_start", stepId: step.id, kind: "http", cwd: ctx.cwd, config: step.config };
    // …
    yield { type: "step_end", stepId: step.id, ok: true, details: { durationMs: 12, output: body } };
  },
});
```

The YAML parser asks the executor registry which keys are step kinds, so a new
kind is usable in pipeline files immediately. `registerParser` (TOML/JSON/TS
front-ends) and `registerReporterFactory` (GitHub checks, remote sinks) work
the same way.

## Development

```bash
cd ~/.pi/agent/extensions/pipeline
npm install
npm test          # vitest: 110+ unit, executor and end-to-end tests
npm run check     # tsc --noEmit
```

`test/fixtures/fake-pi.mjs` emits a canned `pi --mode json` stream; it is both
a test double and the contract test that catches upstream event-shape drift.

## Not built (deliberately)

`needs:` DAG, wrapping-block `when:`, `/pipeline:diff`,
`/pipeline:export-eval`, `redactTraces`, gzip on close, remote sinks,
per-block timeouts, matrix/fan-out, TOML/JSON/TS parsers. See
`pipelineSpec.md` for the rationale.
