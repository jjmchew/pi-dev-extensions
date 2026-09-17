import { registerExecutor, __resetRegistries, registerParser } from "../core/registry.ts";
import type { Plan, RunContext, Step, StepContext, StepEvent, StepExecutor } from "../core/types.ts";
import { yamlParser } from "../parsers/yaml.ts";

/** Records the order in which fake steps ran (for concurrency assertions). */
export const trace: string[] = [];

export type FakeSpec = {
  ok?: boolean;
  delayMs?: number;
  output?: string;
  usage?: { input: number; output: number; cost: number; turns: number };
  hang?: boolean;
  /** While hanging, emit a heartbeat `progress` event every N ms. */
  heartbeatMs?: number;
};

/** An executor whose behaviour is described by the step's config. */
export const fakeExecutor: StepExecutor<FakeSpec> = {
  kind: "fake",
  resultFields: ["output", "exitCode", "usage", "turns", "stderr"],
  async *run(step: Step & { config: FakeSpec }, ctx: StepContext): AsyncGenerator<StepEvent> {
    const cfg = step.config ?? {};
    yield { type: "step_start", stepId: step.id, kind: "fake", cwd: ctx.cwd, config: cfg };
    trace.push(`start:${step.id}`);
    const started = Date.now();
    let aborted = false;
    if (cfg.hang) {
      // Optionally emit a periodic heartbeat while hanging, so an outer
      // idle-timeout test can distinguish "stuck with no events" from
      // "stuck but still yielding progress".
      while (!ctx.signal.aborted) {
        const tick = cfg.heartbeatMs ?? 0;
        const waitMs = tick > 0 ? tick : 60_000;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          ctx.signal.addEventListener("abort", onAbort, { once: true });
        });
        if (ctx.signal.aborted) break;
        if (tick > 0) {
          yield { type: "progress", stepId: step.id, data: { heartbeat: true } };
        }
      }
      aborted = true;
    } else if (cfg.delayMs) {
      await new Promise((r) => setTimeout(r, cfg.delayMs));
      aborted = ctx.signal.aborted;
    }
    trace.push(`end:${step.id}`);
    yield {
      type: "step_end",
      stepId: step.id,
      ok: aborted ? false : cfg.ok !== false,
      details: {
        durationMs: Date.now() - started,
        output: cfg.output,
        usage: cfg.usage,
        aborted: aborted || undefined,
      },
    };
  },
};

export function setupRegistries(): void {
  __resetRegistries();
  trace.length = 0;
  registerExecutor(fakeExecutor);
  registerParser(yamlParser);
}

export function makeCtx(over: Partial<RunContext> = {}): RunContext {
  return {
    runId: "test-run",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    results: {},
    ...over,
  };
}

export function plan(root: Plan["root"], over: Partial<Plan> = {}): Plan {
  return { name: "test", root, ...over };
}

export function step(id: string, config: FakeSpec = {}, over: Partial<Step> = {}): Plan["root"] {
  return {
    kind: "step",
    step: { kind: "fake", id, explicitId: true, path: `root.${id}`, config, ...over },
  };
}

export async function collect(gen: AsyncIterable<StepEvent>): Promise<StepEvent[]> {
  const out: StepEvent[] = [];
  for await (const evt of gen) out.push(evt);
  return out;
}
