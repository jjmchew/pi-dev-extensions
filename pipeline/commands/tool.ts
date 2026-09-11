/**
 * `run_pipeline` tool — the LLM-facing surface.
 *
 * Uses the exact same run path as `/pipeline`, so behaviour can't drift
 * between the two entry points.
 */
import { executeRun } from "../core/execute.ts";
import type { RunStatus, RunTotals, StepEvent } from "../core/types.ts";

export type RunPipelineInput = {
  name: string;
  args?: string;
  runsDir?: string;
  timeoutMs?: number;
};

export type RunPipelineOutput = {
  runId: string;
  status: RunStatus;
  totals: RunTotals;
  runDir?: string;
};

export async function runPipelineTool(
  params: RunPipelineInput,
  opts: {
    cwd: string;
    signal?: AbortSignal;
    sessionId?: string;
    assistantMessageId?: string;
    onUpdate?: (text: string) => void;
  },
): Promise<RunPipelineOutput> {
  const seen: string[] = [];
  const result = await executeRun({
    name: params.name,
    cwd: opts.cwd,
    args: params.args,
    runsDirFlag: params.runsDir,
    timeoutMs: params.timeoutMs,
    signal: opts.signal,
    invoker: {
      kind: "tool",
      user: process.env.USER,
      sessionId: opts.sessionId,
      assistantMessageId: opts.assistantMessageId,
    },
    onEvent: (evt: StepEvent) => {
      if (!opts.onUpdate) return;
      if (evt.type === "step_start") seen.push(`▸ ${evt.stepId} (${evt.kind})`);
      if (evt.type === "step_end") {
        const skipped = (evt.details as any)?.skipped;
        seen.push(`${skipped ? "↷" : evt.ok ? "✓" : "✗"} ${evt.stepId}`);
      }
      opts.onUpdate(seen.slice(-12).join("\n"));
    },
  });

  return {
    runId: result.runId,
    status: result.status,
    totals: result.totals,
    runDir: result.runDir,
  };
}
