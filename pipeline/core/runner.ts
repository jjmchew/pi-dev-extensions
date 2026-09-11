/**
 * The runner walks a `Plan` and streams `StepEvent`s. It knows nothing about
 * YAML, shells or sub-processes — step kinds come from the executor registry.
 *
 * Composition rules implemented here:
 *   sequence  — stop at the first failure unless the failing step sets
 *               `continueOnError`; everything downstream is marked skipped.
 *   parallel  — wait for all by default, bounded by `maxConcurrency` (8);
 *               `failFast` aborts outstanding siblings via a derived signal.
 *   when      — evaluated immediately before dispatch; false → skipped.
 *   timeoutMs — per-step derived AbortController.
 */
import { EventQueue } from "./queue.ts";
import { getExecutor } from "./registry.ts";
import { interpolate, interpolateConfig, mergeEnv, resolveStepCwd } from "./resolve.ts";
import { evaluateWhen } from "./when.ts";
import type {
  LlmUsage,
  LoopScope,
  LoopSpec,
  Node,
  Plan,
  RunContext,
  RunStatus,
  RunTotals,
  Step,
  StepContext,
  StepEndDetails,
  StepEvent,
  StepResult,
} from "./types.ts";

const DEFAULT_MAX_CONCURRENCY = 8;

class StepFailure extends Error {
  constructor(readonly stepId: string) {
    super(`step "${stepId}" failed`);
  }
}

// ─── status decision table ────────────────────────────────────────────────

export function computeRunStatus(input: {
  aborted: boolean;
  failures: number;
  shortCircuited: boolean;
}): RunStatus {
  if (input.aborted) return "aborted";
  if (input.failures === 0) return "ok";
  // A failure that stopped the run outright is a plain failure; a failure the
  // run survived (continueOnError / wait-all parallel) is a partial run.
  return input.shortCircuited ? "failed" : "partial";
}

// ─── plan walking helpers ─────────────────────────────────────────────────

export function collectSteps(node: Node): Step[] {
  if (node.kind === "step") return [node.step];
  if (node.kind === "loop") return collectSteps(node.loop.body);
  return node.children.flatMap(collectSteps);
}

// ─── runner ───────────────────────────────────────────────────────────────

export type RunPlanOptions = {
  ctx: RunContext;
  /** Called for every event before it is yielded (used for reporters). */
  onEvent?: (evt: StepEvent) => void;
};

export function runPlan(plan: Plan, opts: RunPlanOptions): AsyncGenerator<StepEvent> {
  const { ctx } = opts;
  const queue = new EventQueue<StepEvent>();
  const startedAt = Date.now();

  let failures = 0;
  let okCount = 0;
  let skippedCount = 0;
  let shortCircuited = false;
  const usage: LlmUsage = { input: 0, output: 0, cost: 0, turns: 0 };
  let sawUsage = false;

  const emit = (evt: StepEvent) => queue.push(evt);

  const recordEnd = (step: Step, evt: Extract<StepEvent, { type: "step_end" }>) => {
    const d = (evt.details ?? {}) as StepEndDetails;
    const result: StepResult = {
      id: step.id,
      ok: evt.ok,
      skipped: d.skipped === true,
      kind: step.kind,
      durationMs: d.durationMs,
      exitCode: d.exitCode,
      output: d.output,
      stderr: d.stderr,
      usage: d.usage,
      turns: d.turns,
      vars: {},
    };
    if (step.outputVar && d.output !== undefined) result.vars[step.outputVar] = d.output;
    ctx.results[step.id] = result;

    if (result.skipped) skippedCount++;
    else if (evt.ok) okCount++;
    else failures++;

    if (d.usage) {
      sawUsage = true;
      usage.input += d.usage.input ?? 0;
      usage.output += d.usage.output ?? 0;
      usage.cost += d.usage.cost ?? 0;
      usage.turns += d.usage.turns ?? 0;
    }
  };

  const markSkipped = (node: Node, reason: string) => {
    for (const step of collectSteps(node)) {
      if (ctx.results[step.id]) continue;
      const evt: StepEvent = {
        type: "step_end",
        stepId: step.id,
        ok: true,
        details: { skipped: true, reason },
      };
      recordEnd(step, evt as any);
      emit(evt);
    }
  };

  /**
   * `gatedOnly` is the degraded mode a sequence enters after a failure: the
   * run is short-circuiting, but steps carrying an explicit `when:` still get
   * a say (that is what `when: always()` cleanup steps are for). Steps
   * without a `when:` inherit the plain skip contagion.
   */
  async function runStep(step: Step, signal: AbortSignal, gatedOnly = false): Promise<void> {
    if (signal.aborted) {
      markSkipped({ kind: "step", step }, "aborted");
      return;
    }
    if (gatedOnly && !step.when) {
      markSkipped({ kind: "step", step }, "upstream-failure");
      return;
    }

    if (step.when) {
      let pass: boolean;
      // Pre-interpolate so `equals("${loop.iteration}", "2")` and other
      // `${…}` refs inside string literals resolve before the when: grammar
      // sees them. Env miss stays silent — the when: expression itself will
      // fail loudly if the substitution produces garbage.
      const expr = interpolate(step.when, {
        env: mergeEnv(process.env as any, ctx.pipelineEnv),
        results: ctx.results,
        args: ctx.args,
        loopScope: ctx.loopScope,
      });
      try {
        pass = evaluateWhen(expr, ctx.results, ctx.loopScope);
      } catch (err) {
        const evt: StepEvent = {
          type: "step_end",
          stepId: step.id,
          ok: false,
          details: { error: `bad when expression: ${(err as Error).message}` },
        };
        recordEnd(step, evt as any);
        emit(evt);
        throw new StepFailure(step.id);
      }
      if (!pass) {
        markSkipped({ kind: "step", step }, "when");
        return;
      }
    }

    const executor = getExecutor(step.kind);
    if (!executor) {
      const evt: StepEvent = {
        type: "step_end",
        stepId: step.id,
        ok: false,
        details: { error: `no executor registered for step kind "${step.kind}"` },
      };
      recordEnd(step, evt as any);
      emit(evt);
      throw new StepFailure(step.id);
    }

    // Per-step timeout gets its own controller chained to the parent signal.
    const stepController = new AbortController();
    const onParentAbort = () => stepController.abort(signal.reason);
    if (signal.aborted) stepController.abort(signal.reason);
    else signal.addEventListener("abort", onParentAbort, { once: true });
    let timedOut = false;
    const timer = step.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stepController.abort(new Error(`step "${step.id}" timed out after ${step.timeoutMs}ms`));
        }, step.timeoutMs)
      : undefined;
    timer?.unref?.();

    const stepCtx: StepContext = {
      ...ctx,
      signal: stepController.signal,
      stepPath: step.path,
      emit,
    };

    let sawEnd = false;
    try {
      const resolvedConfig = interpolateConfig(step.config, stepCtx, step.id);
      executor.validate?.(resolvedConfig);
      const resolved: Step = { ...step, config: resolvedConfig };
      for await (const evt of executor.run(resolved as any, stepCtx)) {
        if (evt.type === "step_end") {
          sawEnd = true;
          const details: StepEndDetails = { ...((evt.details ?? {}) as StepEndDetails) };
          if (timedOut) details.timedOut = true;
          if (step.outputVar) details.outputVarName = step.outputVar;
          const finalEvt = { ...evt, details } as Extract<StepEvent, { type: "step_end" }>;
          recordEnd(step, finalEvt);
          emit(finalEvt);
        } else {
          emit(evt);
        }
      }
      if (!sawEnd) {
        const evt: StepEvent = {
          type: "step_end",
          stepId: step.id,
          ok: false,
          details: { error: `executor "${step.kind}" produced no step_end event` },
        };
        recordEnd(step, evt as any);
        emit(evt);
      }
    } catch (err) {
      if (!sawEnd) {
        const evt: StepEvent = {
          type: "step_end",
          stepId: step.id,
          ok: false,
          details: { error: (err as Error)?.message ?? String(err), timedOut },
        };
        recordEnd(step, evt as any);
        emit(evt);
      }
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onParentAbort);
    }

    const result = ctx.results[step.id];
    if (result && !result.ok && !step.continueOnError && !gatedOnly) throw new StepFailure(step.id);
  }

  async function runSequence(
    node: Extract<Node, { kind: "sequence" }>,
    signal: AbortSignal,
    gatedOnly = false,
  ): Promise<void> {
    let failure: StepFailure | undefined;
    let degraded = gatedOnly;
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!;
      try {
        await runNode(child, signal, degraded);
      } catch (err) {
        if (!(err instanceof StepFailure)) throw err;
        shortCircuited = true;
        failure ??= err;
        degraded = true; // keep walking: `when:`-gated steps still get a turn
        continue;
      }
      if (signal.aborted) {
        for (const rest of node.children.slice(i + 1)) markSkipped(rest, "aborted");
        break;
      }
    }
    if (failure && !gatedOnly) throw failure;
  }

  async function runParallel(
    node: Extract<Node, { kind: "parallel" }>,
    signal: AbortSignal,
    gatedOnly = false,
  ): Promise<void> {
    const limit = Math.max(1, node.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });

    let failed: StepFailure | undefined;
    let index = 0;
    const inflight = new Set<Promise<void>>();

    const launch = (child: Node): void => {
      const p = runNode(child, controller.signal, gatedOnly)
        .catch((err) => {
          if (err instanceof StepFailure) {
            failed ??= err;
            if (node.failFast) {
              // failFast cuts the run short, which is a plain failure rather
              // than a partial (nothing else was allowed to finish).
              shortCircuited = true;
              controller.abort(new Error(`failFast: step "${err.stepId}" failed`));
            }
          } else {
            throw err;
          }
        })
        .finally(() => {
          inflight.delete(p);
        });
      inflight.add(p);
    };

    try {
      while (index < node.children.length || inflight.size > 0) {
        while (inflight.size < limit && index < node.children.length) {
          const child = node.children[index++]!;
          if (controller.signal.aborted && node.failFast) {
            markSkipped(child, "failFast");
            continue;
          }
          launch(child);
        }
        if (inflight.size > 0) await Promise.race([...inflight]);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    if (failed && !gatedOnly) throw failed;
  }

  async function runNode(node: Node, signal: AbortSignal, gatedOnly = false): Promise<void> {
    switch (node.kind) {
      case "step":
        return runStep(node.step, signal, gatedOnly);
      case "sequence":
        return runSequence(node, signal, gatedOnly);
      case "parallel":
        return runParallel(node, signal, gatedOnly);
      case "loop":
        return runLoop(node.loop, signal, gatedOnly);
    }
  }

  async function runLoop(spec: LoopSpec, signal: AbortSignal, gatedOnly: boolean): Promise<void> {
    const parent = ctx.loopScope;
    // Composed result key: `outer.1.inner` for the second iteration of
    // `outer` running its child loop `inner`. `spec.id` is always the short
    // id (parser output); the prefix-composition happens here so a nested
    // loop's own aggregate lives at a unique key per outer iteration.
    const resultKey = parent ? `${parent.prefix}.${parent.iteration}.${spec.id}` : spec.id;

    if (signal.aborted) {
      markLoopSkipped(spec, resultKey, "aborted");
      return;
    }
    if (gatedOnly) {
      // Loops don't carry a `when:` day one, so cleanup semantics apply: no
      // iteration runs, the loop composer is marked skipped.
      markLoopSkipped(spec, resultKey, "upstream-failure");
      return;
    }

    const startedAt = Date.now();
    const prefix = resultKey;

    let iterations = 0;
    let stopped: "condition" | "maxIterations" | "failure" | "aborted" = "maxIterations";
    let ok = true;
    let bubble: StepFailure | undefined;

    for (let i = 0; i < spec.maxIterations; i++) {
      if (signal.aborted) {
        stopped = "aborted";
        ok = false;
        break;
      }

      const scope: LoopScope = { id: spec.id, iteration: i, prefix, parent };
      ctx.loopScope = scope;
      emit({ type: "progress", stepId: resultKey, data: { loop: "iteration_start", i } });

      const iterBody = rewriteBodyIds(spec.body, scope);
      let iterFailed = false;
      try {
        await runNode(iterBody, signal, false);
      } catch (err) {
        if (!(err instanceof StepFailure)) {
          ctx.loopScope = parent;
          throw err;
        }
        iterFailed = true;
      }
      ctx.loopScope = parent;
      iterations++;

      emit({
        type: "progress",
        stepId: resultKey,
        data: { loop: "iteration_end", i, ok: !iterFailed },
      });

      if (iterFailed) {
        ok = false;
        stopped = signal.aborted ? "aborted" : "failure";
        // Body-step failure that is not `continueOnError` — loop stops. Whether
        // the enclosing sequence should also short-circuit is decided below.
        bubble = new StepFailure(resultKey);
        break;
      }

      if (signal.aborted) {
        stopped = "aborted";
        ok = false;
        break;
      }

      if (i + 1 < (spec.minIterations ?? 0)) continue;

      // Evaluate stop condition against the results this iteration produced.
      const stopExpr = interpolate(spec.stop.expr, {
        env: mergeEnv(process.env as any, ctx.pipelineEnv),
        results: ctx.results,
        args: ctx.args,
        loopScope: scope,
      });
      let stop: boolean;
      try {
        stop = evaluateWhen(stopExpr, ctx.results, scope);
      } catch (err) {
        ok = false;
        stopped = "failure";
        emit({
          type: "progress",
          stepId: resultKey,
          data: { loop: "stop_error", error: (err as Error).message },
        });
        bubble = new StepFailure(resultKey);
        break;
      }
      if (spec.stop.mode === "while" ? !stop : stop) {
        stopped = "condition";
        break;
      }

      if (iterFailed) {
        // handled above; here only to satisfy exhaustive intent
      }

      // stop_error path already broke; loop cap check happens after the loop.

      // Signal check for next iteration handled at top of loop.

      // Reset for the next iteration.
      if (i === spec.maxIterations - 1) break;
    }

    if (iterations === spec.maxIterations && stopped === "maxIterations") {
      if (spec.onMaxIterations === "fail") {
        ok = false;
        bubble = new StepFailure(resultKey);
      }
    }

    const result: StepResult = {
      id: resultKey,
      ok,
      skipped: false,
      aborted: stopped === "aborted" || undefined,
      kind: "loop",
      durationMs: Date.now() - startedAt,
      vars: { iterations, stopped, lastIteration: Math.max(0, iterations - 1) },
    };
    ctx.results[resultKey] = result;

    const endEvt: StepEvent = {
      type: "step_end",
      stepId: resultKey,
      ok,
      details: {
        durationMs: result.durationMs,
        iterations,
        stopped,
        aborted: stopped === "aborted" || undefined,
      },
    };
    // Fold into the totals — same accounting as any other step_end.
    if (result.skipped) skippedCount++;
    else if (ok) okCount++;
    else failures++;
    emit(endEvt);

    emit({
      type: "progress",
      stepId: resultKey,
      data: { loop: "stopped", reason: stopped, iterations },
    });

    if (bubble) {
      shortCircuited = true;
      throw bubble;
    }
  }

  function markLoopSkipped(spec: LoopSpec, resultKey: string, reason: string): void {
    const result: StepResult = {
      id: resultKey,
      ok: true,
      skipped: true,
      kind: "loop",
      vars: { iterations: 0, stopped: "skipped", lastIteration: -1 },
    };
    ctx.results[resultKey] = result;
    skippedCount++;
    emit({
      type: "step_end",
      stepId: resultKey,
      ok: true,
      details: { skipped: true, reason },
    });
  }

  (async () => {
    emit({ type: "run_start", runId: ctx.runId, pipeline: plan.name });
    try {
      await runNode(plan.root, ctx.signal);
    } catch (err) {
      if (!(err instanceof StepFailure)) {
        emit({
          type: "progress",
          stepId: "",
          data: { runnerError: (err as Error)?.message ?? String(err) },
        });
        failures++;
        shortCircuited = true;
      }
    }
    // Anything never dispatched (e.g. aborted mid-flight) counts as skipped.
    markSkipped(plan.root, "not-run");

    const total = okCount + failures + skippedCount;
    const totals: RunTotals = {
      durationMs: Date.now() - startedAt,
      steps: { total, ok: okCount, failed: failures, skipped: skippedCount },
      usage: sawUsage ? usage : undefined,
    };
    const status = computeRunStatus({
      aborted: ctx.signal.aborted,
      failures,
      shortCircuited,
    });
    emit({ type: "run_end", status, totals });
    queue.close();
  })().catch((err) => {
    emit({ type: "progress", stepId: "", data: { fatal: String(err) } });
    queue.close();
  });

  return queue.drain();
}

/** Convenience for executors: the environment a step's child process gets. */
export function stepEnv(step: Step, ctx: RunContext): Record<string, string> {
  return mergeEnv(process.env as Record<string, string>, ctx.pipelineEnv, step.env);
}

/**
 * Clone `body` for one iteration, rewriting every step id (and nested loop
 * id) to include the loop scope's physical prefix. Everything else —
 * executor code, timeouts, `when:` — sees a normal step whose id happens to
 * contain dots.
 *
 * `explicitId` is intentionally preserved on rewritten steps: if the source
 * step was auto-id, its iteration copy stays auto-id (unaddressable from
 * outside). If it was explicit, iteration N's copy is addressable as
 * `${loopId}.${N}.${origId}`.
 */
function rewriteBodyIds(node: Node, scope: LoopScope): Node {
  const iterPrefix = `${scope.prefix}.${scope.iteration}`;
  const walk = (n: Node): Node => {
    if (n.kind === "step") {
      return {
        kind: "step",
        step: { ...n.step, id: `${iterPrefix}.${n.step.id}` },
      };
    }
    if (n.kind === "loop") {
      // A nested loop keeps its short id here; runLoop composes the full
      // result key from the parent scope's prefix (see below), so we must
      // not double it up.
      return n;
    }
    const children = n.children.map(walk);
    return n.kind === "sequence" ? { kind: "sequence", children } : { ...n, children };
  };
  return walk(node);
}

export { resolveStepCwd, StepFailure };
