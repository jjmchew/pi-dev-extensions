/**
 * cwd / env / `${…}` resolution.
 *
 * Two interpolation namespaces exist and no others:
 *   `${VAR}` / `${env.VAR}`      → merged environment (miss → "" + progress)
 *   `${steps.<id>.<field>}`      → prior step results (incl. vars.<name>)
 *
 * Env references are expanded eagerly at plan freeze (reproducible);
 * step references are expanded lazily at dispatch (the values don't exist
 * before the producer finishes).
 */
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Env, LoopScope, Plan, Results, Step, StepContext, StepResult } from "./types.ts";

// ─── cwd ──────────────────────────────────────────────────────────────────

/** step.cwd > plan.cwd > ctx.cwd; relative paths resolve against ctx.cwd. */
export function resolveCwd(
  stepCwd: string | undefined,
  pipelineCwd: string | undefined,
  baseCwd: string,
): string {
  const pick = stepCwd ?? pipelineCwd;
  if (!pick) return baseCwd;
  return isAbsolute(pick) ? pick : resolvePath(baseCwd, pick);
}

export function resolveStepCwd(step: Step, ctx: { pipelineCwd?: string; cwd: string }): string {
  return resolveCwd(step.cwd, ctx.pipelineCwd, ctx.cwd);
}

// ─── env ──────────────────────────────────────────────────────────────────

/** Later wins: process.env ⊕ plan.env ⊕ step.env. Undefined values dropped. */
export function mergeEnv(...layers: Array<NodeJS.ProcessEnv | Env | undefined>): Env {
  const out: Env = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

// ─── built-in variables ───────────────────────────────────────────────────

export type BuiltinVars = {
  PIPELINE_CWD: string;
  REPO_ROOT: string;
  GIT_BRANCH: string;
  GIT_COMMIT: string;
  RUN_ID: string;
};

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Computed once per run and injected into every child's environment. */
export function computeBuiltinVars(cwd: string, runId: string): BuiltinVars {
  return {
    PIPELINE_CWD: cwd,
    REPO_ROOT: git(["rev-parse", "--show-toplevel"], cwd) || cwd,
    GIT_BRANCH: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    GIT_COMMIT: git(["rev-parse", "HEAD"], cwd),
    RUN_ID: runId,
  };
}

export function gitInfo(cwd: string): { commit: string; branch: string; dirty: boolean } {
  return {
    commit: git(["rev-parse", "HEAD"], cwd),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    dirty: git(["status", "--porcelain"], cwd).length > 0,
  };
}

// ─── interpolation ────────────────────────────────────────────────────────

const REF_RE = /\$\{([^}]+)\}/g;

export type InterpolateOpts = {
  env?: Env;
  results?: Results;
  args?: string;
  /** Innermost loop scope, used for `${loop.*}` / `${loops.<id>.*}` and to
   *  resolve bare `${steps.<bodyId>.…}` inside a loop body. */
  loopScope?: LoopScope;
  /** Leave `${steps.…}` refs untouched (used during eager env expansion). */
  envOnly?: boolean;
  onMiss?: (ref: string) => void;
};

export function interpolate(str: string, opts: InterpolateOpts): string {
  return str.replace(REF_RE, (whole, rawRef: string) => {
    const ref = rawRef.trim();
    // `${a ?? b ?? "literal"}` — evaluate each alternative in order, return
    // the first non-empty. A quoted alternative is a literal (bareword
    // literals are ambiguous with env keys so we require quotes for those).
    if (ref.includes("??")) {
      if (opts.envOnly) return whole;
      const alts = splitCoalesce(ref);
      for (const alt of alts) {
        const v = resolveOne(alt, opts);
        if (v !== undefined && v !== "") return v;
      }
      return "";
    }
    if (opts.envOnly && (ref.startsWith("steps.") || ref.startsWith("loop.") || ref.startsWith("loops."))) {
      return whole;
    }
    const v = resolveOne(ref, opts);
    if (v === undefined) {
      opts.onMiss?.(ref);
      return "";
    }
    return v;
  });
}

/** Split `a ?? b ?? "c"` on `??` respecting quoted strings. */
function splitCoalesce(ref: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let quote: string | undefined;
  while (i < ref.length) {
    const c = ref[i]!;
    if (quote) {
      buf += c;
      if (c === "\\" && i + 1 < ref.length) {
        buf += ref[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      i++;
      continue;
    }
    if (c === "?" && ref[i + 1] === "?") {
      out.push(buf.trim());
      buf = "";
      i += 2;
      continue;
    }
    buf += c;
    i++;
  }
  out.push(buf.trim());
  return out;
}

/** Resolve a single ref (no `??`) to a string, or undefined if unknown. */
function resolveOne(ref: string, opts: InterpolateOpts): string | undefined {
  // Quoted literal: `"default"` / `'default'`.
  if ((ref.startsWith('"') && ref.endsWith('"')) || (ref.startsWith("'") && ref.endsWith("'"))) {
    return ref.slice(1, -1);
  }
  if (ref === "args") return opts.args ?? "";
  if (ref === "loop.iteration") {
    return opts.loopScope ? String(opts.loopScope.iteration) : undefined;
  }
  if (ref === "loop.first") {
    return opts.loopScope ? (opts.loopScope.iteration === 0 ? "true" : "") : undefined;
  }
  if (ref.startsWith("loop.previous.")) {
    if (!opts.loopScope) return undefined;
    if (opts.loopScope.iteration === 0) return "";
    const rest = ref.slice("loop.previous.".length);
    return lookupBodyField(opts.loopScope, opts.loopScope.iteration - 1, rest, opts.results ?? {});
  }
  if (ref.startsWith("loops.")) {
    return resolveLoopsRef(ref, opts);
  }
  if (ref.startsWith("steps.")) {
    const v = lookupStep(ref, opts.results ?? {}, opts.loopScope);
    if (v === undefined) return undefined;
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  const key = ref.startsWith("env.") ? ref.slice(4) : ref;
  return opts.env?.[key];
}

function resolveLoopsRef(ref: string, opts: InterpolateOpts): string | undefined {
  // `loops.<id>.iteration` | `loops.<id>.first` | `loops.<id>.previous.<step>.<field>...`
  const parts = ref.split(".");
  if (parts.length < 3) return undefined;
  const targetId = parts[1]!;
  const scope = findScope(opts.loopScope, targetId);
  if (!scope) return undefined;
  const tail = parts.slice(2);
  if (tail[0] === "iteration" && tail.length === 1) return String(scope.iteration);
  if (tail[0] === "first" && tail.length === 1) return scope.iteration === 0 ? "true" : "";
  if (tail[0] === "previous" && tail.length >= 3) {
    if (scope.iteration === 0) return "";
    const rest = tail.slice(1).join(".");
    return lookupBodyField(scope, scope.iteration - 1, rest, opts.results ?? {});
  }
  return undefined;
}

function findScope(scope: LoopScope | undefined, id: string): LoopScope | undefined {
  let cur = scope;
  while (cur) {
    if (cur.id === id) return cur;
    cur = cur.parent;
  }
  return undefined;
}

function lookupBodyField(
  scope: LoopScope,
  iteration: number,
  rest: string,
  results: Results,
): string | undefined {
  // `rest` is `<stepId>.<field...>`; construct the fully qualified id
  // (`<scope.prefix>.<iteration>.<stepId>`) and look up as usual.
  const parts = rest.split(".");
  const stepId = parts[0]!;
  const field = parts.slice(1);
  const key = prefixFor(scope, iteration) + "." + stepId;
  const res = results[key];
  if (!res) return undefined;
  let cur: any = res;
  for (const p of field) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  if (cur === undefined) return undefined;
  return typeof cur === "string" ? cur : JSON.stringify(cur);
}

function prefixFor(scope: LoopScope, iteration: number): string {
  return `${scope.prefix}.${iteration}`;
}

/**
 * `${steps.<id>.<field...>}`. Loop-aware: inside a loop body, if the bare
 * `<id>` names a step in the current iteration, prefer that. Otherwise fall
 * back to greedy-longest-match on dotted keys (so `steps.l.2.check.output`
 * finds `results["l.2.check"].output`).
 */
export function lookupStep(ref: string, results: Results, loopScope?: LoopScope): unknown {
  const parts = ref.split(".");
  if (parts.length < 3) return undefined;
  const body = parts.slice(1); // [stepId, ...fields]  or  [loopId, N, stepId, ...fields]

  // Loop-aware resolution: try current-iteration first, then walk outward.
  if (loopScope) {
    let scope: LoopScope | undefined = loopScope;
    while (scope) {
      const key = `${prefixFor(scope, scope.iteration)}.${body[0]}`;
      const res = results[key];
      if (res) return walkFields(res, body.slice(1));
      scope = scope.parent;
    }
  }

  // Greedy-longest-match: dotted step ids (e.g. `l.2.check`) live as flat
  // keys in `results`. Try progressively longer prefixes.
  for (let take = body.length; take >= 1; take--) {
    const key = body.slice(0, take).join(".");
    const res = results[key];
    if (res) return walkFields(res, body.slice(take));
  }
  return undefined;
}

function walkFields(res: StepResult, fields: string[]): unknown {
  let cur: any = res;
  for (const p of fields) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Deep-walk any JSON-ish value, interpolating every string. */
export function interpolateValue<T>(value: T, opts: InterpolateOpts): T {
  if (typeof value === "string") return interpolate(value, opts) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => interpolateValue(v, opts)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateValue(v, opts);
    return out as unknown as T;
  }
  return value;
}

/** Dispatch-time expansion of a step config (env + step refs). */
export function interpolateConfig<T>(config: T, ctx: StepContext, stepId: string): T {
  const env = mergeEnv(process.env as Env, ctx.pipelineEnv);
  return interpolateValue(config, {
    env,
    results: ctx.results,
    args: ctx.args,
    loopScope: ctx.loopScope,
    onMiss: (ref) => ctx.emit?.({ type: "progress", stepId, data: { interpolationMiss: ref } }),
  });
}

/**
 * Eager pass at plan freeze: resolves `Plan.cwd` / `Plan.env` and expands all
 * `${env.…}` / `${VAR}` references everywhere, leaving `${steps.…}` alone.
 */
export function freezePlan(
  plan: Plan,
  opts: { cwd: string; runId: string; args?: string; extraEnv?: Env },
): { plan: Plan; env: Env; builtins: BuiltinVars } {
  const builtins = computeBuiltinVars(
    plan.cwd ? resolveCwd(undefined, plan.cwd, opts.cwd) : opts.cwd,
    opts.runId,
  );
  const baseEnv = mergeEnv(process.env as Env, builtins, opts.extraEnv);
  // Plan.env values may themselves reference process env / built-ins.
  const planEnv = plan.env
    ? interpolateValue(plan.env, { env: baseEnv, args: opts.args, envOnly: true })
    : undefined;
  const env = mergeEnv(baseEnv, planEnv);

  const expand = <T>(v: T): T => interpolateValue(v, { env, args: opts.args, envOnly: true });

  const frozenRoot = expandNode(plan.root, expand);
  const frozen: Plan = {
    ...plan,
    cwd: plan.cwd ? resolveCwd(undefined, expand(plan.cwd), opts.cwd) : undefined,
    env: planEnv,
    runsDir: plan.runsDir ? expand(plan.runsDir) : undefined,
    root: frozenRoot,
  };
  return { plan: frozen, env, builtins };
}

function expandNode(node: Plan["root"], expand: <T>(v: T) => T): Plan["root"] {
  if (node.kind === "step") {
    const s = node.step;
    return {
      kind: "step",
      step: {
        ...s,
        cwd: s.cwd ? expand(s.cwd) : undefined,
        env: s.env ? expand(s.env) : undefined,
        config: expand(s.config),
      },
    };
  }
  if (node.kind === "loop") {
    // The stop expression and body-step configs may reference `${loop.*}`
    // and iteration-scoped `steps.*` — both are resolved at dispatch time,
    // so freeze only walks into the body to expand env-level refs.
    return { kind: "loop", loop: { ...node.loop, body: expandNode(node.loop.body, expand) } };
  }
  const children = node.children.map((c) => expandNode(c, expand));
  return node.kind === "sequence" ? { kind: "sequence", children } : { ...node, children };
}
