# Loop composer — spec

Status: **implemented**. This spec describes a third composer, `loop:`, that
sits alongside `sequence:` and `parallel:` and repeats a body until a
condition is met (or a bound is hit).

## Goals

1. Repeat any composition of existing nodes (`sequence`, `parallel`, `shell`,
   `llm`, future kinds) — the body is just a `Node`, so we don't invent a new
   step surface.
2. Terminate on a **stop condition** expressed against the results of steps
   *inside* the loop body (LLM output, shell exit, captured `outputVar`, …).
3. Stay auditable: no arbitrary code, no arithmetic. The stop condition reuses
   the existing `when:` mini-language so the loader can statically check refs.
4. Deterministic bookkeeping. Every iteration is a distinct entry in
   `ctx.results` and in `step.json` on disk. You can point at iteration 3's
   output as easily as any other step.
5. Nothing else in the runner has to move. The loop is implemented as a new
   `Node` kind that the runner dispatches to a `runLoop` function, symmetric
   to `runSequence` / `runParallel`.

## Non-goals (day one)

- `for x in items:` fan-out. That's a *map*, not a *loop*; it belongs to a
  separate `foreach:` composer and can share the iteration-scoping mechanism
  we build here.
- Parallel iterations (all iterations run sequentially — the whole point is
  that iteration N+1 reads iteration N's output).
- User-defined helpers in the stop expression. Same closed helper set as
  `when:`.

## YAML surface

```yaml
- loop:
    id: refine                    # optional; addressable like any composer
    maxIterations: 5              # required, positive int, hard cap
    minIterations: 1              # optional, default 0
    until: |                      # required; same grammar as `when:`
      success(check) &&
      contains(steps.check.output, "OK")
    # OR (mutually exclusive with `until`):
    # while: failure(check)
    onMaxIterations: fail         # fail | continue ; default: fail
    body:
      sequence:
        - llm:
            skill: draft
            args: "${loop.previous.review.output}"
          id: draft
          outputVar: draftText
        - shell: ./scripts/check.sh
          id: check
```

### Keys

| key              | required | notes                                                                 |
| ---------------- | -------- | --------------------------------------------------------------------- |
| `maxIterations`  | yes      | positive int; hard cap so a broken condition can't run forever        |
| `minIterations`  | no       | default `0`; stop condition is not evaluated before this count        |
| `until` / `while`| exactly one | boolean expression evaluated *after* each iteration's body finishes |
| `onMaxIterations`| no       | `fail` (default) or `continue` (run succeeds; loop marked `capped`)   |
| `body`           | yes      | a single `Node` (composer or step); same shape as anywhere else       |
| `id`             | no       | id for the loop composer itself (see "Result shape" below)            |

Only one of `until:` / `while:` is allowed. Semantics:

- `until: <expr>` — stop when `<expr>` becomes true.
- `while: <expr>` — stop when `<expr>` becomes false. Same expression grammar;
  this is just sugar for `until: !(<expr>)` but reads better for polling.

The condition is **always** evaluated on the tail of an iteration, so:
- `while:` still runs the body at least once (do/while semantics). Use
  `when:` on the outer node if you need "maybe never run".
- If the body **failed** and the failing step is not `continueOnError`, the
  loop short-circuits without evaluating the condition — same rule as
  `sequence`. Iteration N is the last one, the loop is marked failed.

## Iteration scoping (the interesting part)

Each iteration re-runs the *same* body node, so step ids inside the body
would collide across iterations if we just wrote them into `ctx.results` as
`draft`, `check`, `draft`, `check`. Two things fall out of that:

1. **Physical id.** Inside `ctx.results` and `step.json`, every step in
   iteration `i` (0-indexed) is stored under `<loopId>.<i>.<stepId>` — e.g.
   `refine.0.draft`, `refine.0.check`, `refine.1.draft`, … A loop with no
   `id:` gets an auto id (`s7`) like any other node, and the prefix uses
   that.

2. **Logical id.** *Within* the body, bare references (`steps.draft.output`,
   `success(check)`) resolve to the **current iteration's** result. So the
   `until:` expression above sees `check` as this iteration's check, not
   iteration 0's.

To reach across iterations from inside the body, two accessors:

- `${loop.previous.<stepId>.<field>}` — the previous iteration's result, or
  empty on iteration 0. This is how iteration N feeds off iteration N-1.
- `${loop.iteration}` — the current 0-indexed iteration number.
- `${loop.first}` — true on iteration 0. (No `loop.last`: only known
  post-hoc; use a cleanup step after the loop with `when: success(<loopId>)`
  instead.)
- `${loops.<outerLoopId>.iteration}` /
  `${loops.<outerLoopId>.previous.<stepId>.<field>}` — reach an enclosing
  loop by its explicit id. See resolved decision #4.

From *outside* the loop, you address a specific iteration with the physical
id (`steps.refine.0.check.output`), and the loop composer itself exposes an
aggregated result (see below).

## Result shape for the loop composer

The loop itself is a node, not a step, but we still surface a `StepResult`
for it under the loop's id so downstream `when:` / interpolation can talk
about "did the loop succeed" without listing every iteration:

```ts
results["refine"] = {
  id: "refine",
  kind: "loop",
  ok: true,                     // false if terminated by failure/cap-fail/abort
  skipped: false,
  aborted: false,               // true iff stopped === "aborted"
  durationMs: 12345,
  vars: {
    iterations: 3,              // how many times the body ran (fully or partially)
    stopped: "condition",       // "condition" | "maxIterations" | "failure" | "aborted"
    lastIteration: 2,           // 0-indexed
  },
};
```

Individual iterations remain addressable as `refine.0.*`, `refine.1.*`, …

## Events

To keep reporters simple, iteration boundaries are surfaced as `progress`
events on the loop's synthetic step id:

```ts
{ type: "progress", stepId: "refine", data: { loop: "iteration_start", i: 0 } }
{ type: "progress", stepId: "refine", data: { loop: "iteration_end",   i: 0, stopEval: false } }
{ type: "progress", stepId: "refine", data: { loop: "stopped", reason: "condition", iterations: 3 } }
```

Then a single synthetic `step_end` for the loop composer, exactly like a
normal step, so the summary/reporters need no special-casing beyond
recognising the new `kind: "loop"`.

## IR changes (`core/types.ts`)

```ts
export type Node =
  | { kind: "sequence"; children: Node[] }
  | { kind: "parallel"; children: Node[]; failFast?: boolean; maxConcurrency?: number }
  | { kind: "loop"; loop: LoopSpec }
  | { kind: "step"; step: Step };

export type LoopSpec = {
  id: string;                // auto (s0…) or explicit; namespaced parent
  explicitId?: boolean;
  maxIterations: number;
  minIterations?: number;
  stop:
    | { mode: "until"; expr: string }
    | { mode: "while"; expr: string };
  onMaxIterations: "fail" | "continue";
  body: Node;
  path: string;              // YAML path, for error messages
};
```

## Runner changes (`core/runner.ts`)

Add `runLoop(node, signal, gatedOnly)` next to `runSequence` / `runParallel`.
Sketch:

```ts
async function runLoop(node, signal, gatedOnly) {
  const spec = node.loop;
  let i = 0;
  let stopReason: "condition" | "maxIterations" | "failure";
  let ok = true;

  for (; i < spec.maxIterations; i++) {
    emit(progress(spec.id, { loop: "iteration_start", i }));

    // Rewrite the body's step ids to `${spec.id}.${i}.${origId}` for this
    // iteration only. Also install an iteration-local view of ctx.results
    // so bare `steps.check.output` inside the body resolves to this
    // iteration's `check`.
    const iterBody = withIterationScope(spec.body, spec.id, i);
    const iterCtx  = withIterationView(ctx, spec.id, i);

    try {
      await runNode(iterBody, signal, gatedOnly);   // reuses everything
    } catch (err) {
      if (err instanceof StepFailure) {
        ok = false;
        // Distinguish user cancel / timeout from a body step failing on its
        // own merits. The signal being aborted at the point we see the
        // failure is the tell — abort propagates as StepFailure today.
        stopReason = signal.aborted ? "aborted" : "failure";
        break;
      }
      throw err;
    }
    if (signal.aborted) { ok = false; stopReason = "aborted"; break; }

    emit(progress(spec.id, { loop: "iteration_end", i }));

    if (i + 1 < (spec.minIterations ?? 0)) continue;

    const shouldStop = evaluateStop(spec.stop, iterCtx.results);
    if (shouldStop) { stopReason = "condition"; break; }
  }

  if (i >= spec.maxIterations) {
    stopReason = "maxIterations";
    if (spec.onMaxIterations === "fail") ok = false;
  }

  const iterations = i + (stopReason === "maxIterations" ? 0 : 1);
  recordLoopEnd(spec, { ok, iterations, stopReason, /* durationMs */ });
}
```

`withIterationScope` is a pure function that walks the body once, cloning
each `Step` with a rewritten `id` (`${loopId}.${i}.${origId}`) and a
rewritten `path` (`${node.path}.iter[${i}].…`). It is the smallest possible
change: everything downstream — timeouts, `when:`, `outputVar`, executors —
sees a normal step with a slightly longer id.

`withIterationView` wraps `ctx.results` with a `Proxy` (or a small helper
object) that resolves bare ids inside the body to their namespaced
counterparts. Two lookup keys per read; no walking. Alternative if we don't
want a Proxy: expose a `resultsFor(id)` helper on `StepContext` and have
`evaluateWhen` / `interpolate` call it — cleaner, small refactor.

## Parser changes (`parsers/yaml.ts`)

- Add `"loop"` to `COMPOSER_KEYS`.
- Add a `parseLoop(ctx, path, raw)` that validates the keys above and calls
  `parseNode` for `body`. Reject `body` that is not a single node
  (mapping) — no implicit list; wrap in `sequence:` if you want multiples.
- Rejection messages should mirror the existing "cannot mix" style so
  parser errors stay consistent.

## Loader / validation changes

- `extractRefs` is unchanged (the expression grammar is unchanged).
- `core/validate.ts` (loader-time ordering check) needs to know that refs
  inside a loop body may target siblings *and* the special `loop.*`
  namespace. Add `loop.iteration`, `loop.previous.*`, `loop.first` to the
  allowed-namespace set; treat `loop.previous.<id>` as "defined by any
  step named `<id>` in the same loop body".
- The loader should also reject a loop body whose only step is the one
  referenced in `until:` when that step is `continueOnError: false` and can
  clearly never stop the loop (nice-to-have; can be a later lint).

## Interpolation (`core/resolve.ts`)

Add two new interpolation namespaces available *only* inside a loop body:
- `${loop.iteration}`
- `${loop.previous.<stepId>.<field>}` — resolves to `""` on iteration 0,
  which mirrors the "unknown ref" behaviour of `${steps.missing.output}`.

## Persistence (`reporters/file.ts`)

Iterations already fall out for free: each rewritten step id gets its own
`step.json` at `${runDir}/steps/${loopId}.${i}.${stepId}.json`. Add one
`loop.json` per loop composer summarising iterations + stop reason, so a
human reading the run dir doesn't have to eyeball the count.

## Worked example

```yaml
name: refine-review
sequence:
  - llm: { skill: draft }
    id: seed
    outputVar: text

  - loop:
      id: refine
      maxIterations: 4
      until: contains(steps.check.output, "APPROVED")
      body:
        sequence:
          - llm:
              skill: revise
              args: "${loop.previous.revise.output || steps.seed.vars.text}"
            id: revise
            outputVar: draft
          - llm:
              skill: judge
              args: "${steps.revise.vars.draft}"
            id: check

  - shell:
      cmd: printf '%s\n'
      args: ["${steps.refine.2.revise.vars.draft}"]
    when: success(refine)
```

Reads as: seed → loop(revise → judge) until judge says APPROVED (max 4
tries) → print iteration 2's revision.

## Resolved decisions

1. **No accumulator day one.** Cross-iteration state goes through
   `${loop.previous.*}`. Revisit only if users start writing shell steps
   whose sole purpose is to increment a counter.

2. **Interpolation fallback:** add `${a ?? b}` to the interpolator so
   `${loop.previous.revise.output ?? steps.seed.vars.text}` reads cleanly
   on iteration 0. `??` fires on `undefined` and empty string; `b` may be a
   ref or a quoted literal (`${x ?? "default"}`). Scoped as a small,
   self-contained interpolator change that lands with the loop.

3. **Cancelled vs failed is now distinct.** `stopReason` becomes:
   - `"condition"` — `until` / `while` fired
   - `"maxIterations"` — cap hit (`ok` per `onMaxIterations`)
   - `"failure"` — a body step failed (non-`continueOnError`)
   - `"aborted"` — outer signal fired mid-iteration (Ctrl-C, run timeout,
     `failFast` from an enclosing parallel)

   The loop's synthetic `StepResult` reflects this: `ok: false`,
   `aborted: true`, `vars.stopped: "aborted"`. This also propagates up:
   `computeRunStatus` already distinguishes `aborted` from `failed`, so a
   Ctrl-C during iteration 3 produces run status `aborted`, not `failed`.
   Reporters and `step.json` get the same `aborted: true` flag we already
   set on step-level timeouts, so nothing else needs to learn a new field.

4. **Nested loops — minimal syntax, no complex scoping.**
   - `${loop.*}` always refers to the **innermost** enclosing loop. This is
     the common case and needs no lookup.
   - To reach an outer loop, address it by its `id` using a parallel
     namespace: `${loops.<loopId>.iteration}`,
     `${loops.<loopId>.previous.<stepId>.<field>}`. Requires the outer
     loop to have an explicit `id:` (auto-ids are not addressable — same
     rule as steps today).
   - Physical step ids still nest naturally (`outer.0.inner.2.check`), so
     you can also reach a specific outer iteration's step directly with
     `${steps.outer.0.check.output}` from anywhere.
   - No `${loop.parent.*}` / `${loop.outer.*}` sugar day one — one
     syntax (`loops.<id>`), one rule.

5. **Keep both `while:` and `until:`.** ~10 lines, reads well, matches
   shell intuition.

## Implementation checklist

- [x] `types.ts`: `Node` union + `LoopSpec` + `LoopScope`; `StepResult.aborted`.
- [x] `parsers/yaml.ts`: `parseLoop`, error messages, stop-expr syntax check.
- [x] `core/runner.ts`: `runLoop`, `rewriteBodyIds`, dispatch in `runNode`,
      pre-interpolation of `when:` and stop expressions.
- [x] `core/resolve.ts`: `${loop.*}` / `${loops.<id>.*}` / `${a ?? b}`;
      loop-aware `lookupStep` with greedy dotted-key match.
- [x] `core/when.ts`: loop-scope-aware bare-id and `steps.*` resolution;
      grammar unchanged.
- [x] `core/validate.ts`: loops indexed as virtual steps; foreign-loop
      addressability check; `${loops.<id>.…}` static-check.
- [x] `reporters/{tui,file}.ts` + `commands/run.ts`: node walkers extended.
- [x] `examples/refine.yaml`, `examples/nested-loop.yaml`.
- [x] Tests (`test/loop.test.ts`, 35 cases): fixed-count, until, while,
      cap fail/continue, body-failure, abort vs failure, iteration scoping,
      `${loop.previous.*}` on iteration 0, nested loops, minIterations,
      progress events.
- [ ] `reporters/file.ts`: dedicated `loop.json` summary (day-two — today
      iterations already fall out as regular `step.json`s under the
      composed id).
- [ ] `schema/pipeline.schema.json`: add loop node.
