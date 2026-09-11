# Pipeline syntax reference

A complete, prescriptive reference for authoring `.pi/pipelines/*.yaml` files.
Everything in here is derived from the actual parser (`parsers/yaml.ts`),
loader validator (`core/validate.ts`), runner (`core/runner.ts`), interpolation
(`core/resolve.ts`), `when:` grammar (`core/when.ts`), and the two built-in
executors (`executors/shell.ts`, `executors/llm.ts`). If this doc and the
code disagree, the code wins — file a bug.

> TL;DR shape
>
> ```yaml
> name: my-pipeline               # optional; defaults to the file name
> description: …                  # optional
> cwd: …                          # optional; step children inherit
> env: { KEY: value }             # optional; merged into every child
> runsDir: …                      # optional; overrides run log location
> timeoutMs: 1800000              # reserved (currently ignored — pass via CLI)
>
> sequence:                       # exactly ONE composer at the root
>   - <node>
>   - <node>
> ```

---

## 1. File anatomy

### 1.1 Top-level keys

Allowed top-level keys (any other key is a load error):

| Key | Type | Notes |
|---|---|---|
| `name` | string | Defaults to the file's basename without extension. |
| `description` | string | Free text. |
| `cwd` | string | Relative → resolved against the invocation cwd. |
| `env` | mapping of scalar values | Merged into every child process. Values may reference `${VAR}` / `${env.VAR}` (expanded eagerly at plan freeze). |
| `runsDir` | string | Overrides where run logs are written. Precedence: `--runs-dir` > this > `pipeline.runsDir` setting > `~/.pi/pipelines/runs`. |
| `timeoutMs` | positive number | **Parsed but not enforced by the runner** day one — only honored when passed as `run_pipeline({ timeoutMs })` or `/pipeline --timeout`. |
| `sequence` **or** `parallel` | list / object | Exactly one required. No `loop` at the root — wrap it in `sequence`. |

`steps:` is **not** a valid top-level key. Use `sequence:` — the parser
gives that exact hint if it sees `steps:`.

### 1.2 Composer nodes

Every list item is either **a composer** or **a step**. A single list item
may not mix a composer key with a step kind or with another composer.

#### `sequence:` (list)

```yaml
sequence:
  - <node>
  - <node>
```

Runs children top-to-bottom. Stops at the first failure unless the failing
step has `continueOnError: true`. After a stop, downstream steps are marked
`skipped` — but a step carrying an explicit `when:` still gets a chance to
run (that's how `when: always()` cleanup works). Skips induced by an
upstream failure are **not** the same as skips induced by `when:` — the
`skipped(id)` helper only returns true for the latter.

#### `parallel:` (list or object)

```yaml
# list form
parallel:
  - <node>
  - <node>

# object form (needed for knobs)
parallel:
  failFast: false           # default false; true aborts outstanding siblings
  maxConcurrency: 8         # default 8; must be > 0
  children:
    - <node>
```

- Runs children concurrently. By default the block waits for every child,
  even after one fails (that produces run status `partial`).
- `failFast: true` cancels outstanding siblings on the first failure (SIGTERM
  → SIGKILL after `abortGraceMs`, default 2000 ms).
- Cross-sibling references (`${steps.otherSibling.output}`) are a **load-time
  error** — siblings in the same `parallel:` are not guaranteed to have
  finished. Use `sequence:` if you need ordering.

#### `loop:` (object)

```yaml
loop:
  id: refine                # optional but see "addressability" below
  maxIterations: 5          # required, positive integer
  minIterations: 1          # optional, non-negative integer, ≤ maxIterations
  until: contains(steps.check.output, "OK")   # exactly one of until/while
  # while: failure(check)
  onMaxIterations: fail     # fail | continue ; default: fail
  body:                     # required; a single node (compose with sequence: for >1)
    sequence:
      - shell: ./scripts/probe.sh
        id: check
```

Semantics (from `docs/loop-spec.md` and `runner.ts::runLoop`):

- `until:` — stop when the expression is **true**.
- `while:` — stop when the expression is **false**. Do/while semantics: the
  body always runs at least once, condition is checked *after* iteration.
- `minIterations` (default 0) suppresses the stop check for the first
  `minIterations` iterations. Note: `minIterations: N` means the stop is
  first evaluated after iteration index `N-1` finishes.
- `onMaxIterations: fail` (default) — hitting the cap without the condition
  firing is a failure and bubbles up. `continue` — cap-hit is treated as
  successful loop end; downstream sees `success(<loopId>)`.
- A body step whose failure is not swallowed by `continueOnError` stops the
  loop immediately (`stopped: "failure"`, loop `ok: false`).
- The loop composer itself is a synthetic step: `success(<loopId>)`,
  `steps.<loopId>.vars.iterations`, `steps.<loopId>.vars.stopped` all work.
- The whole `loop` node currently accepts no `id` sibling except the one
  inside `loop:` — wrapping-block `when:` on a loop is a load error today.

`stopped` values: `"condition"` | `"maxIterations"` | `"failure"` | `"aborted"` | `"skipped"`.

**Gotcha:** the runner intentionally **does not** apply
`continueOnError: true` to the loop itself. A step-failure inside the body
short-circuits the outer sequence unless you wrap the loop's step failure
paths inside the loop.

### 1.3 Step nodes

A step is a list item where exactly one key is a **registered executor
kind**. The two built-in kinds are `shell:` and `llm:`. Third-party
extensions register more via `registerExecutor`.

All step knobs sit **as sibling keys**, never inside `shell:` / `llm:`:

```yaml
- shell: yarn test
  id: tests                  # explicit id — required to be referenced
  cwd: packages/api          # relative to the invocation cwd
  env: { CI: "1" }
  timeoutMs: 300000          # SIGTERM after N ms; SIGKILL after abortGraceMs
  continueOnError: true      # sequence keeps walking, run may still be "ok"
  when: always()             # gating expression, see §3
  outputVar: testLog         # capture the step's output at steps.tests.vars.testLog
```

| Knob | Type | Notes |
|---|---|---|
| `id` | non-empty string | Auto-assigned as `s0`, `s1`, … when omitted. Explicit ids matching `^s\d+$` are rejected (collision with auto-namespace). Only **explicit** ids are addressable from `when:` / `${steps.…}`. |
| `cwd` | string | Precedence: step `cwd` > plan `cwd` > invocation cwd. Relative → resolved against the invocation cwd. |
| `env` | mapping | Merged as `process.env ⊕ plan.env ⊕ step.env` (later wins). Non-scalar values rejected. |
| `timeoutMs` | positive number | Applied via a per-step `AbortController`; the details also carry `timedOut: true`. |
| `continueOnError` | boolean | On failure, `sequence:` keeps going; the step still counts as a failure in the totals (run status may be `partial`). |
| `when` | string expression | See §3. Parsed at load time. |
| `outputVar` | non-empty string | Captures `details.output` into `steps.<id>.vars.<name>`. For shell that's the **tail** of stdout (see §4). For llm it's the final assistant text. |

Duplicate step ids anywhere in the plan are a load error, even across
different branches of a `parallel:` block.

---

## 2. Built-in executors

### 2.1 `shell:`

Two forms:

```yaml
# String form → /bin/sh -c "<cmd>" (pipes, globs, redirection work)
- shell: "grep foo *.md | wc -l"

# Object form → direct execvp, no shell involved
- shell:
    cmd: yarn
    args: ["lint", "--fix"]
    env: { NODE_ENV: "test" }    # merged after step.env
```

Keys allowed inside object-form `shell:`: `cmd`, `args`, `env`. Anything
else is a load error. `cmd` must be a non-empty string. `args` must be an
array of strings (numbers are coerced to strings; other types rejected).

Result fields (available as `${steps.<id>.<field>}`):

| Field | Meaning |
|---|---|
| `ok` | `exitCode === 0 && !aborted && !spawnError` |
| `skipped` | true if `when:` gated out or upstream failure caused a skip |
| `durationMs` | wall time |
| `exitCode` | child exit code (or `null` on signal) |
| `output` | **tail** of stdout (≤ `outputTailBytes`, default 4096) |
| `stderr` | **tail** of stderr (≤ `outputTailBytes`) |

Full logs live at `<runDir>/steps/<id>/{stdout,stderr}.log`. If your step
needs to pipe more than a few KB downstream, write to a file (see §7
"Idioms → file handoff").

**String vs object form gotchas:**

- String form runs `/bin/sh -c`, so `${steps.x.output}` is substituted first
  and then interpreted by the shell. Values containing `'`, `"`, `$`, spaces
  or newlines can break your command. Prefer object form for anything
  untrusted.
- Object form runs `execvp` directly — no shell metacharacters are
  interpreted. `args: ["-c", "..."]` if you truly need a shell but want a
  known interpreter.

### 2.2 `llm:`

Runs one isolated agent turn in a fresh **sub-`pi`** process (no session,
fresh context, its own token budget). Nothing about the parent's tool state
carries over.

```yaml
- llm:
    # Exactly one of skill / command / prompt / promptFile is REQUIRED.
    skill: pr-review                  # → runs "/skill:pr-review <args>"
    # command: dual-finalcheck        # → runs "/dual-finalcheck <args>"
    # prompt: "summarize the diff"    # inline text
    # promptFile: ./prompts/foo.md    # read at plan time; sha256 in step.json
    args: "src/"                      # appended to skill/command; joined onto prompt with a blank line
    model: anthropic/claude-opus-4-8  # `provider/id[:thinking]`
    reasoning: high                   # low | medium | high | xhigh; appended as ":<level>"
    tools: [read, bash]               # allowlist; passed via --tools a,b,c
    appendSystemPrompt: "Be terse."   # text hashed (sha256:…) in step_start
    mode: oneshot                     # oneshot (default) | rpc
    nonInteractiveFallback: error     # error (default) | oneshot ; only meaningful with mode: rpc
```

Convenience shorthand: `llm: "some prompt"` is sugar for
`llm: { prompt: "some prompt" }`.

Keys allowed inside `llm:` (any other is a load error, with a hint if it
looks like a step knob written in the wrong place):
`skill`, `command`, `prompt`, `promptFile`, `args`, `model`, `reasoning`,
`tools`, `appendSystemPrompt`, `mode`, `nonInteractiveFallback`.

Result fields:

| Field | Meaning |
|---|---|
| `ok` | `exitCode === 0 && !aborted && !errorMessage && turns > 0` (see gotchas) |
| `output` | final assistant text (joined text parts of the last `message_end`) |
| `usage` | `{ input, output, cost, turns }` (numbers) |
| `usage.cost` | dotted scalar; `${…}` splices a number, not `[object Object]` |
| `turns` | number of assistant turns |
| `model` | model actually used (may differ from what was requested) |

**Gotchas** (from `executors/llm.ts`):

- A sub-pi that hit a provider error still exits 0 with `stopReason: "error"`
  and an `errorMessage`. The executor treats that as **failure**, so
  downstream `${steps.x.output}` doesn't silently see `""`.
- A sub-pi that produced zero assistant turns (e.g. because your `command:`
  was a slash command that was silently consumed) is also **failure**, with
  an explanatory `error` field.
- `output` is the final assistant text only. The tool-call stream lives at
  `<runDir>/steps/<id>/trace.jsonl` and is **not** reachable via
  `${steps.…}`.
- LLM steps run in a sub-pi process. Pipelines can nest but only 2 deep:
  `PIPELINE_DEPTH` env is bumped in every child, and a third-level llm step
  fails immediately.
- `reasoning:` is sugar — appended to `model` as `:<level>` unless the model
  spec already contains a `:`. So `model: anthropic/opus-4-8:medium` +
  `reasoning: high` → `anthropic/opus-4-8:medium` (yours wins).

#### `mode: rpc`

Spawns `pi --mode rpc` and blocks the step until a chat pane finalizes it.
Requires an interactive UI attached (TUI/RPC). In non-interactive
invocations (`pi -p`, CI, git hooks) it hard-fails at dispatch unless
`nonInteractiveFallback: oneshot` is set, in which case it degrades.

Drive from another pane with `/pipeline:chat <stepId>` (see README).

---

## 3. `when:` — the gating mini-language

Evaluated **immediately before dispatch**, per step. Parsed at load time so
typos are caught before anything runs.

### 3.1 Grammar

- **Booleans:** `&&`, `||`, `!`, parentheses.
- **Literals:** double- or single-quoted strings; `/regex/flags` for `matches`.
- **Bare identifier** in boolean position = "this step succeeded"
  (`ok === true`). Example: `success(lint) && tests`.
- **`steps.<id>.<field>`** to read a producer's result field.
- **Helpers** (closed set — nothing else is allowed):

| Helper | Arity | Meaning |
|---|---|---|
| `success(id, …)` | ≥ 1 | every listed step is `ok` (**skipped counts as success** in the sense that `success(x)` is `false` for a skipped `x` — the check is `ok === true`; a skipped step has `ok: true` in results, so it **does** pass `success()`. Use `!skipped(x) && success(x)` for "actually ran and passed"). |
| `failure(id, …)` | ≥ 1 | at least one listed step has `ok === false`. |
| `skipped(id, …)` | ≥ 1 | every listed step was gated out (`skipped: true`). |
| `always()` | 0 | true; runs even after upstream failures (still respects abort). |
| `never()` | 0 | false; disable a step without deleting it. |
| `contains(v, s)` | 2 | substring test; both args stringified via `String(v ?? "")`. |
| `equals(a, b)` | 2 | string equality after `String(v ?? "")`. |
| `matches(v, /re/)` | 2 | regex test; the second arg is either a `/…/flags` literal or a string coerced to `new RegExp`. |

No arithmetic, no user-defined functions, no field arithmetic (`contains`
tests substring; use `matches` with a regex if you need shape checks).

### 3.2 Interaction with `${…}`

`when:` strings are **pre-interpolated** by the runner before parsing. So
`equals("${loop.iteration}", "2")` works: `${loop.iteration}` is substituted
first, then `equals` sees two string literals. Missing refs expand to `""`
silently — the `when:` grammar itself will surface any resulting weirdness.

### 3.3 YAML quoting gotcha

In an unquoted YAML scalar, `: ` (colon + space) is a mapping separator —
even inside what looks like a string literal, because `"…"` in a bare
scalar is just literal characters, not a string delimiter. So this fails to
parse:

```yaml
until: contains(steps.verify.output, "VERDICT: FIXED")
```

YAML sees `"VERDICT` as a key and blows up with `Nested mappings are not
allowed in compact mappings`. Wrap the whole value in single quotes
(single, so the inner `"` stays literal):

```yaml
until: 'contains(steps.verify.output, "VERDICT: FIXED")'
```

Rule of thumb: if a `when:` / `until:` / `while:` expression contains a `:`
anywhere (in a `contains` / `equals` / `matches` literal, or a regex),
wrap the whole value in single quotes. Plain `success(x) && !skipped(y)` is
fine unquoted.

### 3.4 Composer-level `when:`

Not supported day one. Only steps (including loops-as-synthetic-steps) may
carry `when:`. Attach the gate to a wrapping single-step sequence if you
need to gate a group.

---

## 4. `${…}` interpolation

Three namespaces, and only three:

1. **`${VAR}` / `${env.VAR}`** — merged environment. Expanded **eagerly at
   plan freeze** (so `plan.json` records what runs). Built-ins:
   `PIPELINE_CWD`, `REPO_ROOT`, `GIT_BRANCH`, `GIT_COMMIT`, `RUN_ID`. A miss
   yields `""` — no `progress` event during freeze; misses at dispatch are
   emitted as `{ interpolationMiss: "…" }` on the current step's id.
2. **`${steps.<id>.<field>}`** — prior step results. Expanded **lazily at
   dispatch**.
3. **`${args}`** — the opaque argument string from
   `/pipeline <name> <args>` or `run_pipeline({ args })`. Same lazy
   dispatch.
4. **Loop namespaces** (only meaningful inside a loop body — see §5):
   `${loop.iteration}`, `${loop.first}`, `${loop.previous.<step>.<field>…}`,
   `${loops.<loopId>.iteration}`, `${loops.<loopId>.first}`,
   `${loops.<loopId>.previous.<step>.<field>…}`.

### 4.1 Where interpolation runs

- **Freeze pass** (plan load): expands `${VAR}` / `${env.VAR}` in *every*
  string field of the plan (config, `cwd`, `env`, `runsDir`) and in
  `Plan.env` values themselves. `${steps.…}`, `${loop.…}`, `${loops.…}`,
  `${args}` are left as literal `${…}` for dispatch to handle.
- **Dispatch pass** (per step): re-walks the step's `config` / `env` / `cwd`
  and expands the remaining namespaces.
- **`when:` pre-interpolation**: same as dispatch, run just before `when:`
  is parsed.

### 4.2 `${a ?? b ?? "literal"}`

Nullish coalescing: returns the first alternative that resolves to a
non-empty string. Fires on both `undefined` (unknown ref) and `""` (known
but empty). Quoted alternatives (`"…"` or `'…'`) are literals; bareword
alternatives are refs. Split respects quoted strings, so `??` inside a
quoted default is safe.

Examples:

```yaml
# Fall back from a previous iteration's result to a seed on iteration 0.
args: "${loop.previous.revise.vars.draft ?? steps.seed.vars.text}"

# Env with a hard-coded default.
prompt: "hello ${USER ?? "friend"}"
```

**There is no ternary `? :`.** Just chain `??` if you need alternatives.

### 4.3 Result fields per producer kind

Well-known fields the loader will accept in `${steps.<id>.<field>}`:

| Producer | Fields |
|---|---|
| all | `ok`, `skipped`, `durationMs`, `kind`, `id`, `vars.<name>` (matches producer's `outputVar`) |
| `shell` | `exitCode`, `output`, `stderr` |
| `llm` | `output`, `usage`, `turns`, `model` |
| `loop` | `vars.iterations`, `vars.stopped`, `vars.lastIteration`, and `<N>.<bodyStepId>.<field>` to reach a specific iteration's inner step |

Referencing a non-well-known field is a load error (with the allowed set
printed). `vars.<name>` is only accepted when the producer's `outputVar` is
exactly `<name>`.

**Object values are `JSON.stringify`d.** `${steps.foo.usage}` splices in
`{"input":100,…}`. Use the dotted scalar `${steps.foo.usage.cost}` instead.

### 4.4 Load-time reference checks

Every `${steps.…}` and every `when:` step id must:

1. Point at an **explicit** id (auto ids `s0`, `s1`, … are unaddressable).
2. Belong to a step that is **guaranteed to finish before** the referring
   step starts. Sibling refs inside the same `parallel:` block are a load
   error. Cross-branch refs are only okay when there is a `sequence:`
   ancestor that orders them.
3. Not reach into a foreign loop body without going through the physical
   path. From outside `loop: { id: refine, body: sequence: [{ shell: …, id: check }, …] }`,
   reference `${steps.refine.2.check.output}` — a bare `${steps.check.output}`
   is a load error, and the message tells you the physical form to use.

### 4.5 Missing refs at dispatch

Missing dispatch-time refs expand to `""` and emit a `progress` event
`{ interpolationMiss: "steps.foo.output" }`. Grep `events.jsonl` (or the
trace) when a step silently misbehaves.

---

## 5. Loops in depth

### 5.1 Iteration ids

Every step inside a loop body has its physical id rewritten to include the
loop's prefix and iteration number:

```
loop id "refine"  +  body step "check"  →  refine.0.check, refine.1.check, …
```

Auto-id steps inside a body stay auto-id-only from the outside: they get
composed as `refine.0.s3`, but `s3` is unaddressable so nothing external can
reach them. Only steps whose id was written explicitly are addressable via
`${steps.refine.2.check.…}`.

Loops nest naturally: an inner loop `inner` inside outer iteration 1 stores
its aggregate at `outer.1.inner`, and its body steps at
`outer.1.inner.0.<bodyId>` etc.

### 5.2 Inside a body

Within the body, bare `${steps.<id>.<field>}` and bare `success(id)` resolve
to the **current iteration's** step (loop-aware lookup walks the scope
stack, then falls back to top-level). So:

```yaml
loop:
  id: refine
  maxIterations: 4
  until: contains(steps.check.output, "APPROVED")   # THIS iteration's check
  body:
    sequence:
      - llm: { skill: revise }
        id: revise
      - llm: { skill: judge, args: "${steps.revise.vars.draft}" }
        id: check
```

### 5.3 Reaching across iterations from inside

- `${loop.iteration}` — current 0-indexed iteration.
- `${loop.first}` — `"true"` on iteration 0, `""` otherwise. (No
  `loop.last` — only known post-hoc.)
- `${loop.previous.<stepId>.<field>…}` — previous iteration's result, or
  `""` on iteration 0.
- `${loops.<outerLoopId>.iteration}` / `${loops.<outerLoopId>.previous.<stepId>.<field>…}`
  reach an enclosing loop by explicit id. Requires the outer loop to have
  `id:` set — auto ids are unaddressable.

### 5.4 Reaching a specific iteration from outside

Use the physical id: `${steps.<loopId>.<N>.<bodyStepId>.<field>}`. Only
valid for explicit-id body steps.

### 5.5 Loop composer result

Available as `${steps.<loopId>.vars.<name>}`:

| Var | Meaning |
|---|---|
| `iterations` | how many times the body ran (fully or partially) |
| `stopped` | `"condition"` \| `"maxIterations"` \| `"failure"` \| `"aborted"` \| `"skipped"` |
| `lastIteration` | 0-indexed; `-1` if the loop was skipped |

Plus `success(<loopId>)`, `failure(<loopId>)`, etc. work as usual.

### 5.6 Gotchas

- No composer-level `when:`. A loop that shouldn't run under certain
  conditions belongs inside a wrapping `sequence:` where the first step's
  `when:` sets the gate and subsequent steps depend on its success.
- Body-step failures short-circuit the loop unless the failing step is
  `continueOnError: true`. That in turn bubbles as a loop failure, which
  bubbles out of the enclosing sequence. If you want a failed iteration to
  count as a *retry*, mark the checker step `continueOnError: true` and
  gate progression through `until:`.
- The stop expression is evaluated **after** the body finishes for that
  iteration. `minIterations: 3` means "don't check the condition until at
  least iteration 2 has completed".
- The stop expression is validated at load time (same grammar as `when:`).
  Bad syntax = load error, not a runtime surprise.
- `${loops.<id>.…}` where `<id>` is not an enclosing explicit-id loop is a
  load error, with a targeted message for each of the "unknown id / not a
  loop / auto-id / not enclosing" sub-cases.

### 5.7 Cross-iteration file handoff pattern

Because there is no `loop.next`, and `loop.previous` is only from the body
looking backward, the cleanest way to feed one iteration's artifact into the
next when the file path itself needs to be stable is a `when: always()`
shell step at the end of the body:

```yaml
- shell: |
    cp "./work-${loop.iteration}.md" "./work-prev.md"
  when: always()
```

---

## 6. Run lifecycle, aborts, timeouts

- A step completes when its child process exits. `ok = exitCode === 0 && !aborted`
  for shell; llm additionally requires no provider error and ≥ 1 assistant
  turn.
- Per-step `timeoutMs` fires SIGTERM via an `AbortController`; SIGKILL
  follows after `abortGraceMs` (default 2000 ms).
- `parallel: { failFast: true }` cancels outstanding siblings on the first
  failure.
- User abort (Esc, CLI `--timeout`, outer signal) propagates the same way.
- Aborted vs failed is distinct at the `StepResult` level:
  `{ ok: false, aborted: true }` for aborts; `{ ok: false }` for plain
  failures. Loops carry `aborted: true` when `stopped === "aborted"`.

Run status is `ok | failed | partial | aborted`:

| Situation | Status |
|---|---|
| No failures | `ok` |
| Failure that cut the run short (`failFast`, non-`continueOnError` in a sequence, loop cap-fail) | `failed` |
| Failure(s) the run survived (parallel wait-all, `continueOnError`) | `partial` |
| Outer abort fired | `aborted` |

---

## 7. Idioms

### 7.1 Feed a shell result into an llm prompt

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

### 7.2 Pipe an llm answer into a shell arg

Use object form so the value isn't re-parsed by a shell:

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

### 7.3 File handoff when the tail is too small

```yaml
sequence:
  - shell: "cargo build --message-format=json > $PIPELINE_CWD/.build.json 2>&1"
    id: build
  - shell: >-
      jq '[.[] | select(.reason=="compiler-message")] | length'
        $PIPELINE_CWD/.build.json
    id: errcount
```

### 7.4 Parameterize with `${args}`

```yaml
- shell: "eslint ${args}"
```

Invoke as `/pipeline my-pipeline "src/foo.ts src/bar.ts"`.

### 7.5 Cleanup step that always runs

```yaml
- shell: rm -rf .tmp
  when: always()
```

### 7.6 "Retry until approved" loop

```yaml
- loop:
    id: refine
    maxIterations: 4
    until: contains(steps.check.output, "APPROVED")
    body:
      sequence:
        - llm:
            skill: revise
            args: "${loop.previous.revise.vars.draft ?? steps.seed.vars.text}"
          id: revise
          outputVar: draft
        - llm:
            skill: judge
            args: "${steps.revise.vars.draft}"
          id: check
```

### 7.7 Nested loops (poll inside retry)

See `examples/nested-loop.yaml`. Key move: use `${loops.<outerId>.iteration}`
to disambiguate.

---

## 8. Common load-time errors — how to read them

Every parse/validation error is prefixed with `<source>: at <yamlPath>: …`
and often includes a `hint:`. The frequent ones:

| Error snippet | What it means | Fix |
|---|---|---|
| `pipeline root must contain exactly one of \`sequence:\` or \`parallel:\`` (hint: `\`steps:\` is not supported`) | You wrote `steps:` at the root | Rename to `sequence:`. |
| `unknown top-level key "X"` | Typo in a top-level key | Allowed: `name`, `description`, `cwd`, `env`, `runsDir`, `timeoutMs`, `sequence`, `parallel`. |
| `cannot mix composer \`sequence\` with step kind \`shell\`` | Put `shell:` next to `sequence:` in the same item | Break into two list items. |
| `unknown step key "X"` (hint mentions step knobs) | You put a step knob inside `llm:` / `shell:` | Move it to a sibling key. |
| `unknown key "X" in llm step` | Typo inside `llm:` | Allowed keys listed in §2.2. |
| `llm step requires exactly one of \`skill\`, \`command\`, \`prompt\`, or \`promptFile\`` | Zero or ≥ 2 modes set | Pick exactly one. |
| `duplicate step id "X" (at … and …)` | Same explicit id twice | Rename one. |
| `\`${steps.X.…}\` references unknown step id "X"` | Producer doesn't exist | Fix the id or add the producer. |
| `references auto-generated id "s3"` | You referenced an auto id | Give the producer an explicit `id:`. |
| `is not guaranteed to finish first` | Sibling ref inside `parallel:` | Wrap in a `sequence:` so ordering exists. |
| `references … which lives inside loop body "L"` | Bare ref crosses a loop boundary | Use `${steps.L.<N>.<stepId>…}` from outside. |
| `"X" is not a field of a shell/llm step` | Unknown result field | Use one of the fields listed in §4.3, or `vars.<name>`. |
| `step "X" does not define \`outputVar: Y\`` | Referenced `vars.Y` but producer sets a different (or no) `outputVar` | Add/rename `outputVar` on the producer. |
| `\`${loops.L.…}\` — loop "L" does not enclose this step` | Not in an outer scope | Only ancestral explicit-id loops are reachable via `loops.<id>`. |
| `explicit id "sN" collides with the auto-id namespace` | You wrote `id: s7` | Rename; auto ids look exactly like `s\d+`. |
| `loop requires exactly one of \`until\` or \`while\`` | Both or neither | Pick one. |
| `\`minIterations\` … exceeds \`maxIterations\`` | Off-by-N | Clamp. |
| `when: unknown helper "foo()"` | Typo | See §3.1 for the closed set. |
| `bad when expression: …` (runtime) | Interpolation produced ungrammatical text | Check the pre-interpolated value; often a missing `outputVar`. |

---

## 9. Runtime output & debugging

- Run logs live at `<runsDir>/<runId>/` (see README for tree).
- `events.jsonl` is the source of truth for the wire event stream — grep it
  for `interpolationMiss`, `iteration_start`, `stop_error`, `failFast`, etc.
- `steps/<id>/step.json` has the summarised result; large logs are next to
  it as `stdout.log` / `stderr.log`.
- For `llm:` steps, `trace.jsonl` is the verbatim sub-`pi` event stream
  (not redacted; useful for post-mortems).
- `/pipeline:runs`, `/pipeline:show <runId>`, `/pipeline:trace <runId> <stepId>`
  are the intended read paths.

Secrets: the file reporter redacts known secret shapes in `log` events
(`stdout.log`, `stderr.log`, and the `log`-typed entries in
`events.jsonl`). `trace.jsonl` and `${steps.…}` values are **not**
redacted, deliberately — otherwise the data plane breaks. Don't stash
secrets in `outputVar` if you're going to publish traces.

---

## 10. Executor sub-invocations for `llm:`

For reference (from `executors/llm.ts::buildArgs` /  `buildRpcArgs`):

- **oneshot mode:**
  `pi --mode json -p --no-session [--model X[:level]] [--tools a,b] [--append-system-prompt <text>] "<prompt>"`
- **rpc mode:**
  `pi --mode rpc --no-session --name pipeline-<stepId> [--model …] [--tools …] [--append-system-prompt …]`
- Prompt construction:
  - `skill: NAME` → `/skill:NAME [args]`
  - `command: NAME` → `/NAME [args]`
  - `prompt: TEXT` (+ optional `args`) → `TEXT\n\nARGS`
  - `promptFile: PATH` → file contents at plan time (sha256 stored)

Env in the sub-pi contains: `process.env ⊕ plan.env ⊕ step.env ⊕ { PIPELINE_DEPTH: parent+1 }`.

---

## 11. Cross-references

- `docs/loop-spec.md` — full loop composer design doc (this file mirrors it
  but this doc is the surface reference).
- `README.md` — overview, commands, run log tree, settings, extension SDK.
- `NOTES.md` — implementation-side notes about the `pi --mode json` event
  stream, `getPiInvocation` fallbacks, and platform caveats.
- `examples/*.yaml` — copy-pasteable pipelines: `coin-flip.yaml`,
  `refine.yaml`, `nested-loop.yaml`, `checks.yaml`, `review-and-clean.yaml`.
- `schema/pipeline.schema.json` — editor autocomplete schema (JSON Schema
  draft-07); covers `loop:`, `promptFile`, `reasoning`, `mode`, and
  `nonInteractiveFallback`. Runtime validation in `parsers/yaml.ts` and
  `core/validate.ts` is still authoritative — the schema is a strict subset
  suitable for editor tooling.
