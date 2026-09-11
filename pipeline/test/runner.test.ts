import { beforeEach, describe, expect, it } from "vitest";
import { computeRunStatus, runPlan } from "../core/runner.ts";
import type { RunStatus, StepEvent } from "../core/types.ts";
import { collect, makeCtx, plan, setupRegistries, step, trace } from "./helpers.ts";

beforeEach(setupRegistries);

function endsOf(events: StepEvent[]) {
  return events.filter((e) => e.type === "step_end") as Array<Extract<StepEvent, { type: "step_end" }>>;
}

function runEnd(events: StepEvent[]) {
  return events.find((e) => e.type === "run_end") as Extract<StepEvent, { type: "run_end" }>;
}

describe("sequence", () => {
  it("runs children in order and reports ok", async () => {
    const p = plan({ kind: "sequence", children: [step("a"), step("b")] });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    expect(trace).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(runEnd(events).status).toBe("ok");
    expect(runEnd(events).totals.steps).toEqual({ total: 2, ok: 2, failed: 0, skipped: 0 });
  });

  it("short-circuits on failure and marks downstream steps skipped", async () => {
    const p = plan({ kind: "sequence", children: [step("a", { ok: false }), step("b"), step("c")] });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    expect(trace).toEqual(["start:a", "end:a"]);
    const ends = endsOf(events);
    expect(ends.map((e) => [e.stepId, e.ok, (e.details as any)?.skipped ?? false])).toEqual([
      ["a", false, false],
      ["b", true, true],
      ["c", true, true],
    ]);
    expect(runEnd(events).status).toBe("failed");
    expect(runEnd(events).totals.steps).toEqual({ total: 3, ok: 0, failed: 1, skipped: 2 });
  });

  it("continueOnError lets the sequence proceed and yields a partial run", async () => {
    const p = plan({
      kind: "sequence",
      children: [step("a", { ok: false }, { continueOnError: true }), step("b")],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    expect(trace).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(runEnd(events).status).toBe("partial");
  });
});

describe("parallel", () => {
  it("waits for all children by default", async () => {
    const p = plan({
      kind: "parallel",
      children: [step("a", { delayMs: 30 }), step("b", { ok: false }), step("c", { delayMs: 10 })],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    expect(endsOf(events).map((e) => e.stepId).sort()).toEqual(["a", "b", "c"]);
    expect(runEnd(events).status).toBe("partial");
  });

  it("failFast aborts outstanding siblings", async () => {
    const p = plan({
      kind: "parallel",
      failFast: true,
      children: [step("fail", { ok: false }), step("slow", { hang: true })],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    const slow = endsOf(events).find((e) => e.stepId === "slow")!;
    expect(slow.ok).toBe(false);
    expect(runEnd(events).status).toBe("failed");
  });

  it("respects maxConcurrency", async () => {
    const p = plan({
      kind: "parallel",
      maxConcurrency: 2,
      children: [
        step("a", { delayMs: 20 }),
        step("b", { delayMs: 20 }),
        step("c", { delayMs: 5 }),
        step("d", { delayMs: 5 }),
      ],
    });
    await collect(runPlan(p, { ctx: makeCtx() }));
    // At no point may more than 2 steps be in flight.
    let inflight = 0;
    let peak = 0;
    for (const t of trace) {
      if (t.startsWith("start:")) peak = Math.max(peak, ++inflight);
      else inflight--;
    }
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("when gating", () => {
  it("skips a step whose condition is false, and skip counts as success", async () => {
    const p = plan({
      kind: "sequence",
      children: [
        step("a", { ok: false }, { continueOnError: true }),
        step("b", {}, { when: "success(a)" }),
        step("c", {}, { when: "failure(a)" }),
        step("d", {}, { when: "success(b)" }), // b was skipped → success
        step("e", {}, { when: "!skipped(b) && success(b)" }),
      ],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    const skipped = Object.fromEntries(endsOf(events).map((e) => [e.stepId, (e.details as any)?.skipped === true]));
    expect(skipped).toEqual({ a: false, b: true, c: false, d: false, e: true });
  });

  it("fails the step when the expression is malformed", async () => {
    const p = plan({ kind: "sequence", children: [step("a", {}, { when: "success(" })] });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    expect(endsOf(events)[0]!.ok).toBe(false);
    expect(String((endsOf(events)[0]!.details as any).error)).toContain("bad when expression");
  });
});

describe("cleanup after a failure", () => {
  it("still dispatches `when:`-gated steps downstream of a short circuit", async () => {
    const p = plan({
      kind: "sequence",
      children: [
        step("build", { ok: false }),
        step("plain"), // no when: → skipped by contagion
        step("cleanup", {}, { when: "always()" }),
        step("onFailure", {}, { when: "failure(build)" }),
        step("onSuccess", {}, { when: "success(build)" }),
      ],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    const skipped = Object.fromEntries(endsOf(events).map((e) => [e.stepId, (e.details as any)?.skipped === true]));
    expect(skipped).toEqual({
      build: false,
      plain: true,
      cleanup: false,
      onFailure: false,
      onSuccess: true,
    });
    expect(runEnd(events).status).toBe("failed");
  });

  it("does not resurrect the run when a cleanup step also fails", async () => {
    const p = plan({
      kind: "sequence",
      children: [step("build", { ok: false }), step("cleanup", { ok: false }, { when: "always()" })],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    expect(runEnd(events).totals.steps).toEqual({ total: 2, ok: 0, failed: 2, skipped: 0 });
    expect(runEnd(events).status).toBe("failed");
  });
});

describe("timeouts and abort", () => {
  it("aborts a step that exceeds timeoutMs", async () => {
    const p = plan({ kind: "sequence", children: [step("slow", { hang: true }, { timeoutMs: 20 })] });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    const end = endsOf(events)[0]!;
    expect(end.ok).toBe(false);
    expect((end.details as any).timedOut).toBe(true);
  });

  it("run-level abort produces status aborted", async () => {
    const controller = new AbortController();
    const p = plan({ kind: "sequence", children: [step("slow", { hang: true }), step("next")] });
    const events: StepEvent[] = [];
    const gen = runPlan(p, { ctx: makeCtx({ signal: controller.signal }) });
    setTimeout(() => controller.abort(), 20);
    for await (const evt of gen) events.push(evt);
    expect(runEnd(events).status).toBe("aborted");
  });
});

describe("outputVar and usage aggregation", () => {
  it("captures the primary output into vars and totals llm usage", async () => {
    const ctx = makeCtx();
    const p = plan({
      kind: "sequence",
      children: [
        step("a", { output: "hello", usage: { input: 10, output: 5, cost: 0.1, turns: 1 } }, { outputVar: "greeting" }),
        step("b", { usage: { input: 1, output: 2, cost: 0.05, turns: 2 } }),
      ],
    });
    const events = await collect(runPlan(p, { ctx }));
    expect(ctx.results.a!.vars).toEqual({ greeting: "hello" });
    expect(runEnd(events).totals.usage).toEqual({ input: 11, output: 7, cost: 0.15000000000000002, turns: 3 });
  });
});

describe("status decision table", () => {
  const cases: Array<[Parameters<typeof computeRunStatus>[0], RunStatus]> = [
    [{ aborted: false, failures: 0, shortCircuited: false }, "ok"],
    [{ aborted: false, failures: 1, shortCircuited: true }, "failed"],
    [{ aborted: false, failures: 1, shortCircuited: false }, "partial"],
    [{ aborted: true, failures: 0, shortCircuited: false }, "aborted"],
    [{ aborted: true, failures: 3, shortCircuited: true }, "aborted"],
  ];
  it.each(cases)("%j → %s", (input, expected) => {
    expect(computeRunStatus(input)).toBe(expected);
  });
});

describe("missing executor", () => {
  it("fails the step with a helpful message", async () => {
    const p = plan({
      kind: "sequence",
      children: [{ kind: "step", step: { kind: "nope", id: "x", path: "root.x", config: {} } }],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    expect(String((endsOf(events)[0]!.details as any).error)).toContain('no executor registered for step kind "nope"');
  });
});
