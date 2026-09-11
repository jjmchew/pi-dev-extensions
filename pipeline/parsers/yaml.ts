/**
 * YAML pipeline parser.
 *
 * The YAML surface is thin sugar over the Plan IR:
 *
 *   sequence: / parallel:   → composer nodes (parallel also has an object
 *                             form carrying failFast / maxConcurrency)
 *   <kind>: …               → a step, where <kind> is any registered executor
 *                             ("shell", "llm", …); step knobs (id, cwd, env,
 *                             when, …) sit as *sibling* keys
 *
 * Everything else is rejected with a message that names the file and the YAML
 * path of the offending node.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { listExecutorKinds } from "../core/registry.ts";
import { validateWhen, WhenError } from "../core/when.ts";
import type { Env, LlmStepConfig, Node, Plan, ShellStepConfig, Step } from "../core/types.ts";

export class PipelineParseError extends Error {
  constructor(message: string, readonly source: string, readonly path: string, hint?: string) {
    super(`${source}: at ${path}: ${message}${hint ? `\n  hint: ${hint}` : ""}`);
    this.name = "PipelineParseError";
  }
}

const META_KEYS = new Set(["name", "description", "cwd", "env", "runsDir", "timeoutMs"]);
const STEP_KNOBS = new Set([
  "id",
  "cwd",
  "env",
  "timeoutMs",
  "continueOnError",
  "when",
  "outputVar",
]);
const COMPOSER_KEYS = new Set(["sequence", "parallel", "loop"]);
const LOOP_KEYS = new Set([
  "id",
  "maxIterations",
  "minIterations",
  "until",
  "while",
  "onMaxIterations",
  "body",
]);
const LOOP_ON_MAX = new Set(["fail", "continue"]);

type Ctx = { source: string; kinds: Set<string>; nextAutoId: number };

function fail(ctx: Ctx, path: string, message: string, hint?: string): never {
  throw new PipelineParseError(message, ctx.source, path, hint);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asEnv(ctx: Ctx, path: string, v: unknown): Env | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isPlainObject(v)) fail(ctx, path, "`env` must be a mapping of string keys to values");
  const out: Env = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null || typeof val === "object") {
      fail(ctx, `${path}.${k}`, "env values must be scalars");
    }
    out[k] = String(val);
  }
  return out;
}

function asPositiveInt(ctx: Ctx, path: string, v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    fail(ctx, path, `\`${field}\` must be a positive number`);
  }
  return v;
}

// ─── step configs ─────────────────────────────────────────────────────────

function parseShellConfig(ctx: Ctx, path: string, raw: unknown): ShellStepConfig {
  if (typeof raw === "string") {
    if (!raw.trim()) fail(ctx, path, "`shell` command may not be empty");
    return { shellForm: true, cmd: raw };
  }
  if (!isPlainObject(raw)) {
    fail(ctx, path, "`shell` must be a string (run via /bin/sh -c) or an object { cmd, args?, env? }");
  }
  const allowed = new Set(["cmd", "args", "env"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) fail(ctx, `${path}.${k}`, `unknown key "${k}" in shell step`, "allowed: cmd, args, env");
  }
  if (typeof raw.cmd !== "string" || !raw.cmd.trim()) fail(ctx, `${path}.cmd`, "`cmd` must be a non-empty string");
  let args: string[] | undefined;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string" && typeof a !== "number")) {
      fail(ctx, `${path}.args`, "`args` must be an array of strings");
    }
    args = (raw.args as unknown[]).map(String);
  }
  return { shellForm: false, cmd: raw.cmd, args, env: asEnv(ctx, `${path}.env`, raw.env) };
}

const REASONING_LEVELS = new Set(["low", "medium", "high", "xhigh"]);
const LLM_MODES = new Set(["oneshot", "rpc"]);
const FALLBACK_MODES = new Set(["error", "oneshot"]);

function parseLlmConfig(ctx: Ctx, path: string, raw: unknown): LlmStepConfig {
  if (typeof raw === "string") {
    // `llm: "some prompt"` is a convenience shorthand for `llm: { prompt }`.
    return { prompt: raw };
  }
  if (!isPlainObject(raw))
    fail(ctx, path, "`llm` must be an object with exactly one of `skill`, `command`, `prompt`, or `promptFile`");
  const allowed = new Set([
    "skill",
    "command",
    "prompt",
    "promptFile",
    "args",
    "model",
    "reasoning",
    "tools",
    "appendSystemPrompt",
    "mode",
    "nonInteractiveFallback",
  ]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) {
      fail(
        ctx,
        `${path}.${k}`,
        `unknown key "${k}" in llm step`,
        STEP_KNOBS.has(k)
          ? `"${k}" is a step knob — put it next to \`llm:\`, not inside it`
          : `allowed: ${[...allowed].join(", ")}`,
      );
    }
  }
  const hasSkill = typeof raw.skill === "string" && raw.skill.length > 0;
  const hasCommand = typeof raw.command === "string" && raw.command.length > 0;
  const hasPrompt = typeof raw.prompt === "string" && raw.prompt.length > 0;
  const hasPromptFile = typeof raw.promptFile === "string" && (raw.promptFile as string).length > 0;
  const modes = [hasSkill, hasCommand, hasPrompt, hasPromptFile].filter(Boolean).length;
  if (modes !== 1) {
    fail(ctx, path, "llm step requires exactly one of `skill`, `command`, `prompt`, or `promptFile`");
  }
  let tools: string[] | undefined;
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) fail(ctx, `${path}.tools`, "`tools` must be an array of tool names");
    tools = (raw.tools as unknown[]).map(String);
  }
  let reasoning: LlmStepConfig["reasoning"];
  if (raw.reasoning !== undefined) {
    if (typeof raw.reasoning !== "string" || !REASONING_LEVELS.has(raw.reasoning)) {
      fail(ctx, `${path}.reasoning`, `\`reasoning\` must be one of ${[...REASONING_LEVELS].join(", ")}`);
    }
    reasoning = raw.reasoning as LlmStepConfig["reasoning"];
  }
  let mode: LlmStepConfig["mode"];
  if (raw.mode !== undefined) {
    if (typeof raw.mode !== "string" || !LLM_MODES.has(raw.mode)) {
      fail(ctx, `${path}.mode`, `\`mode\` must be one of ${[...LLM_MODES].join(", ")}`);
    }
    mode = raw.mode as LlmStepConfig["mode"];
  }
  let fallback: LlmStepConfig["nonInteractiveFallback"];
  if (raw.nonInteractiveFallback !== undefined) {
    if (typeof raw.nonInteractiveFallback !== "string" || !FALLBACK_MODES.has(raw.nonInteractiveFallback)) {
      fail(
        ctx,
        `${path}.nonInteractiveFallback`,
        `\`nonInteractiveFallback\` must be one of ${[...FALLBACK_MODES].join(", ")}`,
      );
    }
    fallback = raw.nonInteractiveFallback as LlmStepConfig["nonInteractiveFallback"];
  }

  let promptText = hasPrompt ? (raw.prompt as string) : undefined;
  let promptFileSha256: string | undefined;
  let promptFileResolved: string | undefined;
  if (hasPromptFile) {
    const rel = raw.promptFile as string;
    const abs = isAbsolute(rel) ? rel : resolvePath(dirname(ctx.source), rel);
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch (err) {
      fail(ctx, `${path}.promptFile`, `could not read promptFile "${rel}": ${(err as Error).message}`);
    }
    promptText = body;
    promptFileSha256 = createHash("sha256").update(body).digest("hex");
    promptFileResolved = abs;
  }

  return {
    skill: hasSkill ? (raw.skill as string) : undefined,
    command: hasCommand ? (raw.command as string) : undefined,
    prompt: promptText,
    promptFile: promptFileResolved,
    promptFileSha256,
    args: raw.args === undefined ? undefined : String(raw.args),
    model: raw.model === undefined ? undefined : String(raw.model),
    reasoning,
    tools,
    appendSystemPrompt: raw.appendSystemPrompt === undefined ? undefined : String(raw.appendSystemPrompt),
    mode,
    nonInteractiveFallback: fallback,
  };
}

function parseStepConfig(ctx: Ctx, path: string, kind: string, raw: unknown): unknown {
  if (kind === "shell") return parseShellConfig(ctx, path, raw);
  if (kind === "llm") return parseLlmConfig(ctx, path, raw);
  return raw; // third-party kinds validate themselves in their executor
}

// ─── nodes ────────────────────────────────────────────────────────────────

function parseNode(ctx: Ctx, path: string, raw: unknown): Node {
  if (!isPlainObject(raw)) {
    fail(ctx, path, "each list item must be a mapping (a composer or a step)");
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) fail(ctx, path, "empty list item");

  const composerKeys = keys.filter((k) => COMPOSER_KEYS.has(k));
  const kindKeys = keys.filter((k) => ctx.kinds.has(k));

  if (composerKeys.length > 1) {
    fail(ctx, path, `cannot mix ${composerKeys.map((k) => `\`${k}\``).join(" and ")} in one list item`);
  }
  if (composerKeys.length === 1 && kindKeys.length > 0) {
    fail(ctx, path, `cannot mix composer \`${composerKeys[0]}\` with step kind \`${kindKeys[0]}\``);
  }
  if (kindKeys.length > 1) {
    fail(ctx, path, `cannot mix step kinds ${kindKeys.map((k) => `\`${k}\``).join(" and ")} in one list item`);
  }

  if (composerKeys.length === 1) {
    const key = composerKeys[0]!;
    const others = keys.filter((k) => k !== key);
    if (others.length > 0) {
      fail(
        ctx,
        path,
        `unexpected key(s) ${others.map((k) => `"${k}"`).join(", ")} next to \`${key}:\``,
        "composer blocks take no step knobs day one (wrapping-block `when:` is deferred)",
      );
    }
    return parseComposer(ctx, path, key as "sequence" | "parallel" | "loop", raw[key]);
  }

  if (kindKeys.length === 0) {
    fail(
      ctx,
      path,
      `no step kind or composer found (keys: ${keys.map((k) => `"${k}"`).join(", ")})`,
      `expected one of: sequence, parallel, ${[...ctx.kinds].join(", ")}`,
    );
  }

  const kind = kindKeys[0]!;
  for (const k of keys) {
    if (k === kind) continue;
    if (!STEP_KNOBS.has(k)) {
      fail(ctx, `${path}.${k}`, `unknown step key "${k}"`, `step knobs: ${[...STEP_KNOBS].join(", ")}`);
    }
  }

  const explicitId = raw.id !== undefined;
  if (explicitId && (typeof raw.id !== "string" || !raw.id.trim())) {
    fail(ctx, `${path}.id`, "`id` must be a non-empty string");
  }
  if (explicitId && /^s\d+$/.test(raw.id as string)) {
    fail(ctx, `${path}.id`, `explicit id "${raw.id}" collides with the auto-id namespace`, "auto ids look like s0, s1, …");
  }
  if (raw.when !== undefined && typeof raw.when !== "string") {
    fail(ctx, `${path}.when`, "`when` must be a string expression");
  }
  if (raw.outputVar !== undefined && (typeof raw.outputVar !== "string" || !raw.outputVar.trim())) {
    fail(ctx, `${path}.outputVar`, "`outputVar` must be a non-empty string");
  }
  if (raw.continueOnError !== undefined && typeof raw.continueOnError !== "boolean") {
    fail(ctx, `${path}.continueOnError`, "`continueOnError` must be a boolean");
  }
  if (raw.cwd !== undefined && typeof raw.cwd !== "string") {
    fail(ctx, `${path}.cwd`, "`cwd` must be a string");
  }

  const step: Step = {
    kind,
    id: explicitId ? (raw.id as string) : `s${ctx.nextAutoId++}`,
    explicitId,
    path: `${path}.${kind}`,
    cwd: raw.cwd as string | undefined,
    env: asEnv(ctx, `${path}.env`, raw.env),
    timeoutMs: asPositiveInt(ctx, `${path}.timeoutMs`, raw.timeoutMs, "timeoutMs"),
    continueOnError: raw.continueOnError as boolean | undefined,
    when: raw.when as string | undefined,
    outputVar: raw.outputVar as string | undefined,
    config: parseStepConfig(ctx, `${path}.${kind}`, kind, raw[kind]),
  };
  return { kind: "step", step };
}

function parseComposer(
  ctx: Ctx,
  path: string,
  key: "sequence" | "parallel" | "loop",
  raw: unknown,
): Node {
  if (key === "loop") return parseLoop(ctx, path, raw);
  if (key === "sequence") {
    if (!Array.isArray(raw)) fail(ctx, path, "`sequence` must be a list of steps or nested composers");
    return {
      kind: "sequence",
      children: raw.map((child, i) => parseNode(ctx, `${path}.sequence[${i}]`, child)),
    };
  }

  // parallel: list form, or object form with knobs
  if (Array.isArray(raw)) {
    return {
      kind: "parallel",
      children: raw.map((child, i) => parseNode(ctx, `${path}.parallel[${i}]`, child)),
    };
  }
  if (!isPlainObject(raw)) {
    fail(ctx, path, "`parallel` must be a list, or an object { failFast?, maxConcurrency?, children }");
  }
  const allowed = new Set(["failFast", "maxConcurrency", "children"]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) fail(ctx, `${path}.${k}`, `unknown key "${k}" in parallel block`, "allowed: failFast, maxConcurrency, children");
  }
  if (!Array.isArray(raw.children)) fail(ctx, `${path}.children`, "`children` must be a list");
  if (raw.failFast !== undefined && typeof raw.failFast !== "boolean") {
    fail(ctx, `${path}.failFast`, "`failFast` must be a boolean");
  }
  return {
    kind: "parallel",
    failFast: raw.failFast as boolean | undefined,
    maxConcurrency: asPositiveInt(ctx, `${path}.maxConcurrency`, raw.maxConcurrency, "maxConcurrency"),
    children: (raw.children as unknown[]).map((child, i) => parseNode(ctx, `${path}.parallel[${i}]`, child)),
  };
}

// ─── loop composer ────────────────────────────────────────────────────────

function parseLoop(ctx: Ctx, path: string, raw: unknown): Node {
  if (!isPlainObject(raw)) {
    fail(
      ctx,
      path,
      "`loop` must be an object { id?, maxIterations, until|while, body, minIterations?, onMaxIterations? }",
    );
  }
  for (const k of Object.keys(raw)) {
    if (!LOOP_KEYS.has(k)) {
      fail(ctx, `${path}.${k}`, `unknown key "${k}" in loop block`, `allowed: ${[...LOOP_KEYS].join(", ")}`);
    }
  }

  const explicitId = raw.id !== undefined;
  if (explicitId && (typeof raw.id !== "string" || !(raw.id as string).trim())) {
    fail(ctx, `${path}.id`, "`id` must be a non-empty string");
  }
  if (explicitId && /^s\d+$/.test(raw.id as string)) {
    fail(ctx, `${path}.id`, `explicit id "${raw.id}" collides with the auto-id namespace`, "auto ids look like s0, s1, …");
  }

  const maxIterations = asPositiveInt(ctx, `${path}.maxIterations`, raw.maxIterations, "maxIterations");
  if (maxIterations === undefined) {
    fail(ctx, `${path}.maxIterations`, "`maxIterations` is required (positive integer)");
  }
  if (!Number.isInteger(maxIterations)) {
    fail(ctx, `${path}.maxIterations`, "`maxIterations` must be an integer");
  }

  let minIterations: number | undefined;
  if (raw.minIterations !== undefined) {
    if (typeof raw.minIterations !== "number" || !Number.isInteger(raw.minIterations) || raw.minIterations < 0) {
      fail(ctx, `${path}.minIterations`, "`minIterations` must be a non-negative integer");
    }
    minIterations = raw.minIterations as number;
    if (minIterations > (maxIterations as number)) {
      fail(
        ctx,
        `${path}.minIterations`,
        `\`minIterations\` (${minIterations}) exceeds \`maxIterations\` (${maxIterations})`,
      );
    }
  }

  const hasUntil = raw.until !== undefined;
  const hasWhile = raw.while !== undefined;
  if (hasUntil && hasWhile) {
    fail(ctx, path, "loop requires exactly one of `until` or `while`", "they are mutually exclusive");
  }
  if (!hasUntil && !hasWhile) {
    fail(ctx, path, "loop requires exactly one of `until` or `while`");
  }
  const stopExpr = (hasUntil ? raw.until : raw.while) as unknown;
  if (typeof stopExpr !== "string" || !stopExpr.trim()) {
    fail(
      ctx,
      `${path}.${hasUntil ? "until" : "while"}`,
      `\`${hasUntil ? "until" : "while"}\` must be a non-empty string expression`,
    );
  }
  const stop = hasUntil
    ? { mode: "until" as const, expr: stopExpr as string }
    : { mode: "while" as const, expr: stopExpr as string };

  let onMaxIterations: "fail" | "continue" = "fail";
  if (raw.onMaxIterations !== undefined) {
    if (typeof raw.onMaxIterations !== "string" || !LOOP_ON_MAX.has(raw.onMaxIterations)) {
      fail(ctx, `${path}.onMaxIterations`, `\`onMaxIterations\` must be one of ${[...LOOP_ON_MAX].join(", ")}`);
    }
    onMaxIterations = raw.onMaxIterations as "fail" | "continue";
  }

  // The stop expression parses under the same grammar as `when:`. Failing at
  // parse time (rather than the first iteration) matches how bad `when:`
  // expressions are caught by the loader today.
  try {
    validateWhen(stop.expr);
  } catch (err) {
    if (err instanceof WhenError) {
      fail(ctx, `${path}.${hasUntil ? "until" : "while"}`, err.message);
    }
    throw err;
  }

  if (raw.body === undefined) fail(ctx, `${path}.body`, "loop requires a `body:` node");
  const body = parseNode(ctx, `${path}.body`, raw.body);

  const id = explicitId ? (raw.id as string) : `s${ctx.nextAutoId++}`;
  return {
    kind: "loop",
    loop: {
      id,
      explicitId,
      path: `${path}.loop`,
      maxIterations: maxIterations as number,
      minIterations,
      stop,
      onMaxIterations,
      body,
    },
  };
}

// ─── entry point ──────────────────────────────────────────────────────────

export function parsePipelineYaml(text: string, source: string, kinds?: string[]): Plan {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new PipelineParseError(`invalid YAML: ${(err as Error).message}`, source, "root");
  }
  if (!isPlainObject(doc)) {
    throw new PipelineParseError("pipeline file must be a YAML mapping", source, "root");
  }

  const ctx: Ctx = {
    source,
    kinds: new Set(kinds ?? listExecutorKinds()),
    nextAutoId: 0,
  };

  const keys = Object.keys(doc);
  const composerKeys = keys.filter((k) => COMPOSER_KEYS.has(k));
  if (composerKeys.length === 0) {
    fail(
      ctx,
      "root",
      "pipeline root must contain exactly one of `sequence:` or `parallel:`",
      keys.includes("steps") ? "`steps:` is not supported — use `sequence:`" : undefined,
    );
  }
  if (composerKeys.length > 1) fail(ctx, "root", "pipeline root must contain exactly one composer key");
  for (const k of keys) {
    if (COMPOSER_KEYS.has(k) || META_KEYS.has(k)) continue;
    fail(ctx, `root.${k}`, `unknown top-level key "${k}"`, `allowed: ${[...META_KEYS].join(", ")}, sequence, parallel`);
  }

  const composerKey = composerKeys[0] as "sequence" | "parallel";
  const root = parseComposer(ctx, "root", composerKey, doc[composerKey]);

  const name = typeof doc.name === "string" && doc.name.trim() ? doc.name : baseName(source);
  return {
    name,
    description: doc.description === undefined ? undefined : String(doc.description),
    cwd: doc.cwd === undefined ? undefined : String(doc.cwd),
    env: asEnv(ctx, "root.env", doc.env),
    runsDir: doc.runsDir === undefined ? undefined : String(doc.runsDir),
    timeoutMs: asPositiveInt(ctx, "root.timeoutMs", doc.timeoutMs, "timeoutMs"),
    root,
    source,
    sourceSha256: createHash("sha256").update(text).digest("hex"),
  };
}

function baseName(source: string): string {
  return source.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "pipeline";
}

export const yamlParser = {
  ext: "yaml",
  parse: (text: string, source: string) => parsePipelineYaml(text, source),
};

export const ymlParser = {
  ext: "yml",
  parse: (text: string, source: string) => parsePipelineYaml(text, source),
};
