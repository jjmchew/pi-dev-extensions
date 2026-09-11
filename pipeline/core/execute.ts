/**
 * The single run path shared by `/pipeline` and the `run_pipeline` tool.
 *
 * load → freeze → reporters → runner → summary. Nothing else should drive the
 * runner directly, so the command surface and the tool surface can never
 * drift apart.
 */
import { loadPipeline, loadPipelineFile } from "./loader.ts";
import { Redactor } from "./redact.ts";
import { freezePlan } from "./resolve.ts";
import { ensureDir, resolveRunsDir, ulid } from "./runsDir.ts";
import { runPlan } from "./runner.ts";
import { DEFAULTS, pipelineSettings } from "./settings.ts";
import type { Plan, Reporter, RunContext, RunStatus, RunTotals, StepEvent } from "./types.ts";
import { FileReporter } from "../reporters/file.ts";
import { JsonReporter } from "../reporters/json.ts";
import { TraceReporter } from "../reporters/trace.ts";

export type ExecuteOptions = {
  /** Pipeline name (discovery) or path to a pipeline file. */
  name: string;
  cwd: string;
  args?: string;
  runsDirFlag?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  invoker?: { kind: string; user?: string; sessionId?: string; assistantMessageId?: string };
  /** Extra reporters (TUI, tests). */
  reporters?: Reporter[];
  /** Emit NDJSON on stdout (headless mode). */
  json?: boolean;
  /** True when the caller can drive interactive (rpc-mode) llm steps. */
  hasUI?: boolean;
  /** Called with the frozen plan before the run starts. */
  onPlan?: (plan: Plan) => void;
  onEvent?: (evt: StepEvent) => void;
};

export type ExecuteResult = {
  runId: string;
  status: RunStatus;
  totals: RunTotals;
  runDir?: string;
  plan: Plan;
};

export async function executeRun(opts: ExecuteOptions): Promise<ExecuteResult> {
  const settings = pipelineSettings();
  const runId = ulid();

  const raw = opts.name.includes("/") || opts.name.includes("\\")
    ? loadPipelineFile(resolveMaybeRelative(opts.name, opts.cwd))
    : loadPipeline(opts.name, opts.cwd);

  const { plan, env } = freezePlan(raw, { cwd: opts.cwd, runId, args: opts.args });
  opts.onPlan?.(plan);

  const runsDir = resolveRunsDir({ flag: opts.runsDirFlag, planRunsDir: plan.runsDir, cwd: opts.cwd });

  // Abort plumbing: caller signal ⊕ run-level timeout.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const runTimeoutMs = opts.timeoutMs;
  const runTimer = runTimeoutMs
    ? setTimeout(() => controller.abort(new Error(`run timed out after ${runTimeoutMs}ms`)), runTimeoutMs)
    : undefined;
  runTimer?.unref?.();

  const ctx: RunContext = {
    runId,
    cwd: opts.cwd,
    pipelineCwd: plan.cwd,
    pipelineEnv: { ...(plan.env ?? {}), ...builtinsFrom(env) },
    signal: controller.signal,
    abortGraceMs: settings.abortGraceMs ?? DEFAULTS.abortGraceMs,
    outputTailBytes: settings.outputTailBytes ?? DEFAULTS.outputTailBytes,
    piBin: settings.piBin,
    results: {},
    args: opts.args,
    hasUI: opts.hasUI,
  };

  const reporters: Reporter[] = [...(opts.reporters ?? [])];
  let fileReporter: FileReporter | undefined;
  if (settings.reporters?.file !== false) {
    ensureDir(runsDir);
    fileReporter = new FileReporter({
      runsDir,
      runId,
      plan,
      cwd: opts.cwd,
      env,
      invoker: opts.invoker,
      redactor: new Redactor(settings.redactPatterns),
      envAllowlist: settings.envAllowlist,
    });
    fileReporter.attachPlanPaths(plan);
    reporters.push(fileReporter);
    if (settings.reporters?.trace !== false) reporters.push(new TraceReporter(fileReporter.runDir));
  }
  if (opts.json && settings.reporters?.json !== false) reporters.push(new JsonReporter());

  for (const r of reporters) await r.onRunStart?.(ctx, plan);

  let status: RunStatus = "failed";
  let totals: RunTotals = {
    durationMs: 0,
    steps: { total: 0, ok: 0, failed: 0, skipped: 0 },
  };

  try {
    for await (const evt of runPlan(plan, { ctx })) {
      const meta = { t: new Date().toISOString(), runId };
      opts.onEvent?.(evt);
      for (const r of reporters) {
        try {
          await r.onEvent(evt, meta);
        } catch {
          // A broken reporter must never take down a run.
        }
      }
      if (evt.type === "run_end") {
        status = evt.status;
        totals = evt.totals;
      }
    }
    for (const r of reporters) await r.onRunEnd?.(ctx, status, totals);
  } finally {
    if (runTimer) clearTimeout(runTimer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  return { runId, status, totals, runDir: fileReporter?.runDir, plan };
}

function builtinsFrom(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PIPELINE_CWD", "REPO_ROOT", "GIT_BRANCH", "GIT_COMMIT", "RUN_ID"]) {
    if (env[key] !== undefined) out[key] = env[key]!;
  }
  return out;
}

function resolveMaybeRelative(name: string, cwd: string): string {
  return name.startsWith("/") ? name : `${cwd}/${name}`;
}
