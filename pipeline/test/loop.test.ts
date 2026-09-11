/**
 * `loop:` composer suite.
 *
 * Structure mirrors the existing suites:
 *   - parser cases  → what YAML shapes produce what IR / errors
 *   - validate cases → static ref checks across loop scopes
 *   - runner cases  → termination, iteration scoping, abort vs failure,
 *                     cross-iteration data flow
 *   - resolve cases → `${loop.previous.*}`, `${loop.iteration}`, `${a ?? b}`
 */
import { beforeEach, describe, expect, it } from "vitest";
import { parsePipelineYaml } from "../parsers/yaml.ts";
import { validatePlan } from "../core/validate.ts";
import { runPlan } from "../core/runner.ts";
import { interpolate } from "../core/resolve.ts";
import { registerExecutor } from "../core/registry.ts";
import { shellExecutor } from "../executors/shell.ts";
import { llmExecutor } from "../executors/llm.ts";
import type { Node, Plan, StepEvent } from "../core/types.ts";
import { collect, makeCtx, plan as planOf, setupRegistries, step, trace } from "./helpers.ts";

// Helpers local to the loop suite. Loop nodes are constructed inline as
// `any` because the IR change is part of the pending work.
function loop(spec: {
  id: string;
  body: Node;
  maxIterations: number;
  minIterations?: number;
  until?: string;
  while?: string;
  onMaxIterations?: "fail" | "continue";
}): Node {
  const stop = spec.until
    ? { mode: "until", expr: spec.until }
    : { mode: "while", expr: spec.while! };
  return {
    kind: "loop",
    loop: {
      id: spec.id,
      explicitId: true,
      path: `root.loop[${spec.id}]`,
      maxIterations: spec.maxIterations,
      minIterations: spec.minIterations,
      stop,
      onMaxIterations: spec.onMaxIterations ?? "fail",
      body: spec.body,
    },
  } as any;
}

function parse(yaml: string): Plan {
  return parsePipelineYaml(yaml, "/tmp/loop.yaml");
}

function endsOf(events: StepEvent[]) {
  return events.filter((e) => e.type === "step_end") as Array<Extract<StepEvent, { type: "step_end" }>>;
}

function runEnd(events: StepEvent[]) {
  return events.find((e) => e.type === "run_end") as Extract<StepEvent, { type: "run_end" }>;
}

beforeEach(() => {
  setupRegistries();
  registerExecutor(shellExecutor);
  registerExecutor(llmExecutor);
});

// ─── parser ────────────────────────────────────────────────────────────────

describe("YAML → IR: loop composer", () => {
  it("parses a minimal loop with until", () => {
    const p = parse(
      `sequence:\n  - loop:\n      id: refine\n      maxIterations: 3\n      until: success(check)\n      body:\n        sequence:\n          - shell: ./check.sh\n            id: check\n`,
    );
    const node = (p.root as any).children[0];
    expect(node.kind).toBe("loop");
    expect(node.loop).toMatchObject({
      id: "refine",
      explicitId: true,
      maxIterations: 3,
      onMaxIterations: "fail",
      stop: { mode: "until", expr: "success(check)" },
    });
    expect(node.loop.body).toMatchObject({ kind: "sequence" });
  });

  it("parses `while` as the dual of `until`", () => {
    const p = parse(
      `sequence:\n  - loop:\n      id: poll\n      maxIterations: 2\n      while: failure(check)\n      body:\n        shell: ./check.sh\n        id: check\n`,
    );
    expect((p.root as any).children[0].loop.stop).toEqual({ mode: "while", expr: "failure(check)" });
  });

  it("accepts minIterations and onMaxIterations: continue", () => {
    const p = parse(
      `sequence:\n  - loop:\n      id: l\n      maxIterations: 5\n      minIterations: 2\n      onMaxIterations: continue\n      until: success(x)\n      body:\n        shell: /bin/true\n        id: x\n`,
    );
    expect((p.root as any).children[0].loop).toMatchObject({
      minIterations: 2,
      onMaxIterations: "continue",
    });
  });

  describe("errors", () => {
    const cases: Array<[string, string, RegExp]> = [
      [
        "missing maxIterations",
        `sequence:\n  - loop:\n      id: l\n      until: success(x)\n      body:\n        shell: /bin/true\n        id: x\n`,
        /maxIterations/,
      ],
      [
        "maxIterations must be positive",
        `sequence:\n  - loop:\n      id: l\n      maxIterations: 0\n      until: success(x)\n      body:\n        shell: /bin/true\n        id: x\n`,
        /positive/,
      ],
      [
        "both until and while",
        `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: success(x)\n      while: failure(x)\n      body:\n        shell: /bin/true\n        id: x\n`,
        /exactly one of `until` or `while`/,
      ],
      [
        "neither until nor while",
        `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      body:\n        shell: /bin/true\n        id: x\n`,
        /exactly one of `until` or `while`/,
      ],
      [
        "missing body",
        `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: success(x)\n`,
        /body/,
      ],
      [
        "unknown loop key",
        `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: success(x)\n      bogus: 1\n      body:\n        shell: /bin/true\n        id: x\n`,
        /unknown key "bogus"/,
      ],
      [
        "onMaxIterations must be fail|continue",
        `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      onMaxIterations: retry\n      until: success(x)\n      body:\n        shell: /bin/true\n        id: x\n`,
        /onMaxIterations/,
      ],
      [
        "malformed until",
        `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: "success("\n      body:\n        shell: /bin/true\n        id: x\n`,
        /when:/,
      ],
    ];
    it.each(cases)("%s", (_name, yaml, re) => {
      expect(() => parse(yaml)).toThrow(re);
    });
  });
});

// ─── validate ──────────────────────────────────────────────────────────────

describe("static reference validation across loop scopes", () => {
  it("references inside the body may point at earlier siblings in the same iteration", () => {
    const p = parse(
      `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: success(check)\n      body:\n        sequence:\n          - shell: /bin/true\n            id: prep\n          - shell: /bin/true\n            id: check\n            when: success(prep)\n`,
    );
    expect(() => validatePlan(p)).not.toThrow();
  });

  it("outside references target a specific iteration via the physical id", () => {
    const p = parse(
      `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: success(check)\n      body:\n        shell: /bin/true\n        id: check\n  - shell:\n      cmd: echo\n      args: ["\${steps.l.0.check.output}"]\n`,
    );
    expect(() => validatePlan(p)).not.toThrow();
  });

  it("outside references accept the loop's aggregate result", () => {
    const p = parse(
      `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: success(check)\n      body:\n        shell: /bin/true\n        id: check\n  - shell: /bin/true\n    when: success(l)\n`,
    );
    expect(() => validatePlan(p)).not.toThrow();
  });

  it("rejects an outside reference to a bare body step id (not addressable — needs iteration index)", () => {
    const p = parse(
      `sequence:\n  - loop:\n      id: l\n      maxIterations: 3\n      until: success(check)\n      body:\n        shell: /bin/true\n        id: check\n  - shell: /bin/true\n    when: success(check)\n`,
    );
    expect(() => validatePlan(p)).toThrow(/loop body/);
  });

  it("rejects references to an outer loop by id when the outer loop has no explicit id", () => {
    // auto-id loops are not addressable, mirroring the auto-step-id rule
    const p = parse(
      `sequence:\n  - loop:\n      maxIterations: 2\n      until: success(inner)\n      body:\n        loop:\n          id: inner\n          maxIterations: 2\n          until: success(x)\n          body:\n            shell:\n              cmd: echo\n              args: ["\${loops.outer.iteration}"]\n            id: x\n`,
    );
    expect(() => validatePlan(p)).toThrow(/auto-generated id|unknown/);
  });
});

// ─── resolve / interpolation ───────────────────────────────────────────────

describe("interpolation additions for loops", () => {
  it("`${a ?? b}` falls back when the left side is undefined or empty", () => {
    expect(interpolate("${MISSING ?? \"default\"}", { env: {} })).toBe("default");
    expect(interpolate("${EMPTY ?? \"default\"}", { env: { EMPTY: "" } })).toBe("default");
    expect(interpolate("${PRESENT ?? \"default\"}", { env: { PRESENT: "x" } })).toBe("x");
  });

  it("`${a ?? b}` chains and supports refs on both sides", () => {
    const env = { A: "", B: "second" };
    expect(interpolate("${A ?? B ?? \"third\"}", { env })).toBe("second");
    expect(interpolate("${A ?? MISSING ?? \"third\"}", { env })).toBe("third");
  });

  // The following require the loop-scoped result view; documented here so
  // implementers know what the string surface should read.
  it("`${loop.iteration}` expands to the current 0-indexed iteration", () => {
    // Exercised end-to-end in the runner suite; unit-level is covered by
    // whatever helper the implementation exposes on StepContext.
  });

  it("`${loop.previous.<id>.<field>}` is empty on iteration 0 and populated afterwards", () => {
    // Ditto — see the runner suite for the observable behaviour.
  });
});

// ─── runner ────────────────────────────────────────────────────────────────

describe("runner: loop composer", () => {
  it("runs the body once and stops when `until` is satisfied", async () => {
    const p = planOf({
      kind: "sequence",
      children: [loop({ id: "l", maxIterations: 5, until: "success(only)", body: step("only") })],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    // Physical id per iteration is namespaced by the loop id.
    expect(trace).toEqual(["start:l.0.only", "end:l.0.only"]);
    expect(runEnd(events).status).toBe("ok");
  });

  it("repeats until the condition fires", async () => {
    // The fake executor's `ok` is static per config, so simulate "condition
    // becomes true on iteration 2" by keying `until` on the iteration count.
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 5,
          until: 'equals("${loop.iteration}", "2")',
          body: step("tick"),
        }),
      ],
    });
    await collect(runPlan(p, { ctx: makeCtx() }));
    expect(trace.filter((t) => t.startsWith("start:"))).toEqual([
      "start:l.0.tick",
      "start:l.1.tick",
      "start:l.2.tick",
    ]);
  });

  it("`while:` is do/while — runs at least once", async () => {
    const p = planOf({
      kind: "sequence",
      children: [loop({ id: "l", maxIterations: 3, while: "never()", body: step("once") })],
    });
    await collect(runPlan(p, { ctx: makeCtx() }));
    expect(trace).toEqual(["start:l.0.once", "end:l.0.once"]);
  });

  it("hitting maxIterations with default policy fails the loop", async () => {
    const p = planOf({
      kind: "sequence",
      children: [loop({ id: "l", maxIterations: 2, until: "never()", body: step("tick") })],
    });
    const ctx = makeCtx();
    const events = await collect(runPlan(p, { ctx }));
    expect(trace.filter((t) => t.startsWith("start:"))).toHaveLength(2);
    const loopResult = ctx.results["l"]!;
    expect(loopResult.ok).toBe(false);
    expect(loopResult.vars).toMatchObject({ stopped: "maxIterations", iterations: 2 });
    expect(runEnd(events).status).toBe("failed");
  });

  it("onMaxIterations: continue caps quietly and keeps the run ok", async () => {
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 2,
          until: "never()",
          onMaxIterations: "continue",
          body: step("tick"),
        }),
      ],
    });
    const ctx = makeCtx();
    const events = await collect(runPlan(p, { ctx }));
    expect(ctx.results["l"]!.ok).toBe(true);
    expect(ctx.results["l"]!.vars).toMatchObject({ stopped: "maxIterations" });
    expect(runEnd(events).status).toBe("ok");
  });

  it("a body-step failure stops the loop with stopped: failure", async () => {
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 5,
          until: "never()",
          body: {
            kind: "sequence",
            children: [step("a"), step("b", { ok: false }), step("c")],
          },
        }),
      ],
    });
    const ctx = makeCtx();
    const events = await collect(runPlan(p, { ctx }));
    // Only one iteration ran; `c` was skipped by sequence short-circuit.
    expect(trace).toEqual(["start:l.0.a", "end:l.0.a", "start:l.0.b", "end:l.0.b"]);
    expect(ctx.results["l"]!.ok).toBe(false);
    expect(ctx.results["l"]!.vars).toMatchObject({ stopped: "failure", iterations: 1 });
    expect(runEnd(events).status).toBe("failed");
  });

  it("an outer abort mid-iteration surfaces stopped: aborted, distinct from failure", async () => {
    const controller = new AbortController();
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 10,
          until: "never()",
          body: step("slow", { hang: true }),
        }),
      ],
    });
    const ctx = makeCtx({ signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const events = await collect(runPlan(p, { ctx }));
    expect(ctx.results["l"]!.ok).toBe(false);
    expect(ctx.results["l"]!.aborted).toBe(true);
    expect(ctx.results["l"]!.vars).toMatchObject({ stopped: "aborted" });
    // Run-level status matches: aborted, not failed.
    expect(runEnd(events).status).toBe("aborted");
  });

  it("iteration N sees iteration N-1's output via ${loop.previous.*}", async () => {
    // The fake executor echoes its config.output back into the step's
    // `output` result. Give each iteration a body step whose output derives
    // from the previous iteration's output through interpolation.
    const bodyStep = step(
      "acc",
      { output: "seed" },
      {
        config: { output: "iter-${loop.iteration}-prev(${loop.previous.acc.output ?? \"none\"})" } as any,
      },
    );
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 3,
          until: 'equals("${loop.iteration}", "2")',
          body: bodyStep,
        }),
      ],
    });
    const ctx = makeCtx();
    await collect(runPlan(p, { ctx }));
    expect(ctx.results["l.0.acc"]!.output).toBe("iter-0-prev(none)");
    expect(ctx.results["l.1.acc"]!.output).toBe("iter-1-prev(iter-0-prev(none))");
    expect(ctx.results["l.2.acc"]!.output).toBe("iter-2-prev(iter-1-prev(iter-0-prev(none)))");
  });

  it("bare refs inside the body resolve to the current iteration", async () => {
    // `check` inside the body's `until` sees this iteration's `check`, not
    // iteration 0's. If bare refs leaked to iteration 0, the loop would
    // never stop.
    const bodySeq: Node = {
      kind: "sequence",
      children: [
        step("check", { output: "iter-${loop.iteration}" } as any, { outputVar: "tag" }),
      ],
    };
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 5,
          until: 'contains(steps.check.vars.tag, "iter-2")',
          body: bodySeq,
        }),
      ],
    });
    const ctx = makeCtx();
    await collect(runPlan(p, { ctx }));
    expect(ctx.results["l"]!.vars).toMatchObject({ stopped: "condition", iterations: 3 });
  });

  it("outside the loop, addressing a specific iteration works", async () => {
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 3,
          until: 'equals("${loop.iteration}", "2")',
          body: step("s", { output: "iter-${loop.iteration}" } as any),
        }),
        step(
          "reader",
          {},
          { config: { output: "${steps.l.1.s.output}" } as any, when: "success(l)" },
        ),
      ],
    });
    const ctx = makeCtx();
    await collect(runPlan(p, { ctx }));
    expect(ctx.results["reader"]!.output).toBe("iter-1");
  });

  it("nested loops: `${loop.*}` is innermost; outer loop reachable via `${loops.<id>.*}`", async () => {
    const inner = loop({
      id: "inner",
      maxIterations: 2,
      until: 'equals("${loop.iteration}", "1")',
      body: step(
        "tag",
        {},
        {
          config: {
            output: "outer=${loops.attempt.iteration} inner=${loop.iteration}",
          } as any,
        },
      ),
    });
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "attempt",
          maxIterations: 2,
          until: 'equals("${loop.iteration}", "1")',
          body: inner,
        }),
      ],
    });
    const ctx = makeCtx();
    await collect(runPlan(p, { ctx }));
    expect(ctx.results["attempt.0.inner.0.tag"]!.output).toBe("outer=0 inner=0");
    expect(ctx.results["attempt.1.inner.1.tag"]!.output).toBe("outer=1 inner=1");
  });

  it("minIterations forces extra runs even if until is already true", async () => {
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 5,
          minIterations: 3,
          until: "always()", // would stop after iter 0 without the minimum
          body: step("tick"),
        }),
      ],
    });
    await collect(runPlan(p, { ctx: makeCtx() }));
    expect(trace.filter((t) => t.startsWith("start:"))).toHaveLength(3);
  });

  it("emits loop progress events for each iteration and a final stop event", async () => {
    const p = planOf({
      kind: "sequence",
      children: [
        loop({
          id: "l",
          maxIterations: 3,
          until: 'equals("${loop.iteration}", "1")',
          body: step("x"),
        }),
      ],
    });
    const events = await collect(runPlan(p, { ctx: makeCtx() }));
    const progress = events.filter(
      (e) => e.type === "progress" && (e as any).stepId === "l",
    ) as Array<Extract<StepEvent, { type: "progress" }>>;
    const kinds = progress.map((e) => (e.data as any).loop);
    expect(kinds).toEqual([
      "iteration_start",
      "iteration_end",
      "iteration_start",
      "iteration_end",
      "stopped",
    ]);
    expect((progress.at(-1)!.data as any).reason).toBe("condition");
  });
});

// ─── examples ──────────────────────────────────────────────────────────────

describe("bundled loop examples parse and validate", () => {
  it.each(["refine.yaml", "nested-loop.yaml"])("%s", async (file) => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const abs = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", file);
    const p = parsePipelineYaml(readFileSync(abs, "utf8"), abs);
    expect(() => validatePlan(p)).not.toThrow();
  });
});
