/**
 * Pipeline extension — core type definitions.
 *
 * This module is the single source of truth for the Plan IR, the event
 * stream, and the plugin interfaces (parsers, executors, reporters).
 * Nothing else in the extension redefines these shapes.
 */

// ─── Plan IR ──────────────────────────────────────────────────────────────

export type Env = Record<string, string>;

export type Plan = {
  name: string;
  description?: string;
  cwd?: string;
  env?: Env;
  runsDir?: string;
  /** Reserved; day-one honored only as a CLI/tool argument. */
  timeoutMs?: number;
  root: Node;
  /** Absolute path of the file this plan was parsed from (loader-populated). */
  source?: string;
  /** sha256 of the source text (loader-populated). */
  sourceSha256?: string;
};

export type Node =
  | { kind: "sequence"; children: Node[] }
  | { kind: "parallel"; children: Node[]; failFast?: boolean; maxConcurrency?: number }
  | { kind: "loop"; loop: LoopSpec }
  | { kind: "step"; step: Step };

export type LoopStop =
  | { mode: "until"; expr: string }
  | { mode: "while"; expr: string };

export type LoopSpec = {
  id: string;
  /** True iff the user gave an explicit `id:` (only explicit ids are addressable). */
  explicitId?: boolean;
  /** YAML source path, for error messages. */
  path: string;
  /** Hard cap on iteration count. */
  maxIterations: number;
  /** Minimum iterations before the stop condition is evaluated. Default 0. */
  minIterations?: number;
  stop: LoopStop;
  /** What to do when the cap is hit without the condition firing. */
  onMaxIterations: "fail" | "continue";
  body: Node;
};

export type Step = {
  kind: string;
  id: string;
  /** Whether `id` was written by the user (only explicit ids are addressable). */
  explicitId?: boolean;
  path: string;
  cwd?: string;
  env?: Env;
  timeoutMs?: number;
  continueOnError?: boolean;
  when?: string;
  outputVar?: string;
  config: ShellStepConfig | LlmStepConfig | unknown;
};

// ─── Step configs ─────────────────────────────────────────────────────────

export type ShellStepConfig =
  | { shellForm: true; cmd: string; env?: Env }
  | { shellForm: false; cmd: string; args?: string[]; env?: Env };

export type LlmStepConfig = {
  /** Exactly one of `skill` | `command` | `prompt` | `promptFile`. */
  skill?: string;
  /** Name of a pi-registered slash command (e.g. `dual-finalcheck` → `/dual-finalcheck`). */
  command?: string;
  prompt?: string;
  /**
   * Path to a `.md`/`.txt` prompt template read at plan time. The resolved
   * text lands in `prompt` and its sha256 in `promptFileSha256` so step.json
   * records the source without inlining the whole body.
   */
  promptFile?: string;
  promptFileSha256?: string;
  args?: string;
  model?: string;
  /** Sugar: appended to `model` as `:<level>` before spawning. */
  reasoning?: "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  /** Inline text appended to the sub-pi system prompt (hashed into step.json). */
  appendSystemPrompt?: string;
  /**
   * `oneshot` (default) runs `pi --mode json -p --no-session` and treats
   * child exit as completion. `rpc` spawns `pi --mode rpc`, streams a chat
   * via `InteractiveRegistry`, and blocks the step until a `/pipeline chat`
   * pane calls `finalize()`.
   */
  mode?: "oneshot" | "rpc";
  /** How `mode: rpc` behaves when no UI is attached. Default: `error`. */
  nonInteractiveFallback?: "error" | "oneshot";
};

// ─── Events ───────────────────────────────────────────────────────────────

export type StepEvent =
  | { type: "run_start"; runId: string; pipeline: string }
  | { type: "run_end"; status: RunStatus; totals: RunTotals }
  | { type: "step_start"; stepId: string; kind: string; cwd: string; config: unknown }
  | { type: "step_end"; stepId: string; ok: boolean; details?: StepEndDetails }
  | { type: "log"; stepId: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "progress"; stepId: string; data: unknown }
  | { type: "llm_event"; stepId: string; event: unknown };

export type StepEndDetails = {
  skipped?: boolean;
  aborted?: boolean;
  timedOut?: boolean;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  stderr?: string;
  usage?: LlmUsage;
  turns?: number;
  model?: string;
  error?: string;
  appendSystemPromptSha256?: string;
  [k: string]: unknown;
};

export type RunStatus = "ok" | "failed" | "aborted" | "partial";

export type RunTotals = {
  durationMs: number;
  steps: { total: number; ok: number; failed: number; skipped: number };
  usage?: LlmUsage;
};

export type LlmUsage = { input: number; output: number; cost: number; turns: number };

// ─── Results (consumed by `when:` and `${…}`) ─────────────────────────────

export type StepResult = {
  id: string;
  ok: boolean;
  skipped: boolean;
  /** True when the step (or loop) ended because of an outer abort/timeout,
   *  distinct from a bare `ok: false` failure. */
  aborted?: boolean;
  kind?: string;
  durationMs?: number;
  exitCode?: number;
  output?: string;
  stderr?: string;
  usage?: LlmUsage;
  turns?: number;
  vars: Record<string, unknown>;
};

export type Results = Record<string, StepResult>;

// ─── Contexts & interfaces ────────────────────────────────────────────────

/**
 * A stack of enclosing `loop:` composers. The innermost is the head of the
 * chain (`.parent` walks outward). Populated only inside a loop body; unset
 * elsewhere. Used by lookup and interpolation to resolve iteration-scoped
 * refs (bare `check` in body → `${loopId}.${i}.check`) and to expand
 * `${loop.*}` / `${loops.<id>.*}`.
 */
export type LoopScope = {
  id: string;
  iteration: number;
  /** Physical id prefix through nested loops, e.g. "outer.1.inner". */
  prefix: string;
  parent?: LoopScope;
};

export type RunContext = {
  runId: string;
  /** Invocation cwd (pi's ctx.cwd). */
  cwd: string;
  /** Resolved Plan.cwd. */
  pipelineCwd?: string;
  /** Resolved Plan.env (already merged with built-ins). */
  pipelineEnv?: Env;
  signal: AbortSignal;
  abortGraceMs?: number;
  results: Results;
  /** Tail cap for captured stdout/stderr/output, in bytes. */
  outputTailBytes?: number;
  /** Override for the `pi` binary used by the llm executor. */
  piBin?: string;
  /** Opaque `${args}` string passed at invocation. */
  args?: string;
  /** True when the pipeline is being driven from a UI (TUI or RPC). */
  hasUI?: boolean;
  /** Innermost enclosing loop scope; undefined outside any loop body. */
  loopScope?: LoopScope;
};

export type StepContext = RunContext & {
  stepPath: string;
  /** Emit an out-of-band event (used for interpolation misses etc). */
  emit?: (evt: StepEvent) => void;
};

export interface PipelineParser {
  /** File extension without the dot, e.g. "yaml". */
  ext: string;
  parse(text: string, source: string): Plan;
}

export interface StepExecutor<Cfg = unknown> {
  kind: string;
  validate?(cfg: Cfg): void;
  run(step: Step & { config: Cfg }, ctx: StepContext): AsyncIterable<StepEvent>;
  /** Well-known result fields this kind produces (for load-time ref checks). */
  resultFields?: string[];
}

export interface Reporter {
  onEvent(evt: StepEvent, meta: { t: string; runId: string }): void | Promise<void>;
  onRunStart?(ctx: RunContext, plan: Plan): void | Promise<void>;
  onRunEnd?(ctx: RunContext, status: RunStatus, totals: RunTotals): void | Promise<void>;
}

// ─── Settings ─────────────────────────────────────────────────────────────

export type PipelineSettings = {
  runsDir?: string;
  piBin?: string;
  outputTailBytes?: number;
  abortGraceMs?: number;
  envAllowlist?: string[];
  redactPatterns?: Array<{ kind: string; pattern: string; flags?: string }>;
  reporters?: { file?: boolean; trace?: boolean; tui?: boolean; json?: boolean };
  retention?: { keepLast?: number; keepDays?: number; keepFailures?: boolean };
};
