/**
 * Load-time validation of a parsed Plan.
 *
 * Two things are checked that the parser cannot see on its own:
 *
 *  1. Ordering — every `when:` reference and every `${steps.X.Y}` must point
 *     at an *explicit* step id that is guaranteed to have finished before the
 *     referencing step starts. Referencing a sibling inside the same
 *     `parallel:` block is a load-time error, not a race at runtime.
 *  2. Fields — `<field>` must be a well-known field for the producer's kind,
 *     or `vars.<name>` matching that producer's `outputVar`.
 */
import { getExecutor } from "./registry.ts";
import type { Node, Plan, Step } from "./types.ts";
import { extractRefs, validateWhen, WhenError } from "./when.ts";

export class PipelineValidationError extends Error {
  constructor(message: string, readonly source?: string) {
    super(source ? `${source}: ${message}` : message);
    this.name = "PipelineValidationError";
  }
}

type Trail = Array<
  | { kind: "sequence"; index: number }
  | { kind: "parallel"; index: number }
  | { kind: "loop"; index: 0; loopId: string }
>;

const COMMON_FIELDS = ["ok", "skipped", "durationMs", "kind", "id"];
const KIND_FIELDS: Record<string, string[]> = {
  shell: [...COMMON_FIELDS, "exitCode", "output", "stderr"],
  llm: [...COMMON_FIELDS, "output", "usage", "turns"],
};

function fieldsFor(kind: string): string[] {
  const fromExecutor = getExecutor(kind)?.resultFields;
  return fromExecutor ? [...COMMON_FIELDS, ...fromExecutor] : (KIND_FIELDS[kind] ?? COMMON_FIELDS);
}

export function indexSteps(plan: Plan): Map<string, { step: Step; trail: Trail }> {
  const out = new Map<string, { step: Step; trail: Trail }>();
  const walk = (node: Node, trail: Trail) => {
    if (node.kind === "step") {
      out.set(node.step.id, { step: node.step, trail });
      return;
    }
    if (node.kind === "loop") {
      // Represent the loop itself as a synthetic step so bare `success(l)`
      // and `${steps.l.…}` refs resolve. `explicitId` mirrors the loop's
      // own flag so auto-id loops stay unaddressable (same rule as steps).
      const virtual: Step = {
        kind: "loop",
        id: node.loop.id,
        explicitId: node.loop.explicitId,
        path: node.loop.path,
        config: {},
      };
      out.set(node.loop.id, { step: virtual, trail });
      walk(node.loop.body, [...trail, { kind: "loop", index: 0, loopId: node.loop.id }]);
      return;
    }
    node.children.forEach((child, index) => walk(child, [...trail, { kind: node.kind, index }]));
  };
  walk(plan.root, []);
  return out;
}

/** True iff `a` is guaranteed to have finished before `b` starts. */
export function happensBefore(a: Trail, b: Trail): boolean {
  const n = Math.min(a.length, b.length);
  for (let d = 0; d < n; d++) {
    const ea = a[d]!;
    const eb = b[d]!;
    if (ea.index === eb.index) continue;
    // First divergence: their common ancestor decides.
    return ea.kind === "sequence" && ea.index < eb.index;
  }
  return false;
}

/**
 * True iff the target sits inside a loop body that the referrer is not
 * inside. Such refs are invalid via bare id — the caller must use the
 * fully-qualified `steps.<loopId>.<N>.<stepId>` form.
 */
function insideForeignLoop(target: Trail, referrer: Trail): { loopId: string } | undefined {
  const n = Math.min(target.length, referrer.length);
  for (let d = 0; d < n; d++) {
    if (target[d]!.kind === "loop" && target[d]!.kind !== referrer[d]?.kind) {
      return { loopId: (target[d] as any).loopId };
    }
  }
  for (let d = n; d < target.length; d++) {
    if (target[d]!.kind === "loop") return { loopId: (target[d] as any).loopId };
  }
  return undefined;
}

function collectConfigRefs(value: unknown, out: Array<{ id: string; field: string }>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\$\{\s*steps\.([^}\s.]+)\.([^}]+?)\s*\}/g)) {
      out.push({ id: m[1]!, field: m[2]! });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectConfigRefs(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectConfigRefs(v, out);
  }
}

/** `${loops.<id>.<rest>}` refs — static-check the loop id is an enclosing
 *  explicit-id loop of the referrer. */
function collectLoopsRefs(value: unknown, out: Array<{ loopId: string; tail: string }>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(/\$\{\s*loops\.([^}\s.]+)\.([^}]+?)\s*\}/g)) {
      out.push({ loopId: m[1]!, tail: m[2]! });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectLoopsRefs(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectLoopsRefs(v, out);
  }
}

export function validatePlan(plan: Plan): void {
  const source = plan.source;
  const index = indexSteps(plan);

  // Duplicate ids (walk the tree, not the by-id index, which would collapse them)
  const seen = new Map<string, string>();
  const checkDupes = (node: Node) => {
    if (node.kind === "step") {
      const prev = seen.get(node.step.id);
      if (prev) {
        throw new PipelineValidationError(
          `duplicate step id "${node.step.id}" (at ${prev} and ${node.step.path})`,
          source,
        );
      }
      seen.set(node.step.id, node.step.path);
      return;
    }
    if (node.kind === "loop") {
      const prev = seen.get(node.loop.id);
      if (prev) {
        throw new PipelineValidationError(
          `duplicate step id "${node.loop.id}" (at ${prev} and ${node.loop.path})`,
          source,
        );
      }
      seen.set(node.loop.id, node.loop.path);
      checkDupes(node.loop.body);
      return;
    }
    node.children.forEach(checkDupes);
  };
  checkDupes(plan.root);

  for (const [, { step, trail }] of index) {
    const refs: Array<{ id: string; field?: string; origin: string }> = [];

    if (step.when) {
      try {
        validateWhen(step.when);
      } catch (err) {
        if (err instanceof WhenError) {
          throw new PipelineValidationError(`${step.path}: ${err.message}`, source);
        }
        throw err;
      }
      for (const r of extractRefs(step.when)) refs.push({ ...r, origin: `when: ${step.when}` });
    }

    const cfgRefs: Array<{ id: string; field: string }> = [];
    collectConfigRefs(step.config, cfgRefs);
    collectConfigRefs(step.env ?? {}, cfgRefs);
    if (step.cwd) collectConfigRefs(step.cwd, cfgRefs);
    for (const r of cfgRefs) refs.push({ ...r, origin: `\${steps.${r.id}.${r.field}}` });

    for (const ref of refs) {
      const target = index.get(ref.id);
      if (!target) {
        throw new PipelineValidationError(
          `${step.path}: ${ref.origin} references unknown step id "${ref.id}"`,
          source,
        );
      }
      if (!target.step.explicitId) {
        throw new PipelineValidationError(
          `${step.path}: ${ref.origin} references auto-generated id "${ref.id}" — ` +
            `add an explicit \`id:\` to the step at ${target.step.path} to make it addressable`,
          source,
        );
      }
      if (target.step.id === step.id) {
        throw new PipelineValidationError(`${step.path}: ${ref.origin} references itself`, source);
      }
      const foreignLoop = insideForeignLoop(target.trail, trail);
      if (foreignLoop) {
        throw new PipelineValidationError(
          `${step.path}: ${ref.origin} references "${ref.id}" which lives inside loop body "${foreignLoop.loopId}" — ` +
            `from outside a loop, address a specific iteration as \`steps.${foreignLoop.loopId}.<N>.${ref.id}${ref.field ? "." + ref.field : ""}\``,
          source,
        );
      }
      if (!happensBefore(target.trail, trail)) {
        throw new PipelineValidationError(
          `${step.path}: ${ref.origin} references "${ref.id}" (${target.step.path}), which is not ` +
            `guaranteed to finish first — references must point at a step earlier in execution order ` +
            `(siblings of the same \`parallel:\` block run concurrently)`,
          source,
        );
      }
      if (ref.field) validateField(step, target.step, ref, source);
    }

    // `${loops.<id>.…}` — must name an enclosing explicit-id loop.
    const loopsRefs: Array<{ loopId: string; tail: string }> = [];
    collectLoopsRefs(step.config, loopsRefs);
    for (const ref of loopsRefs) {
      const enclosing = trail
        .filter((e): e is Extract<Trail[number], { kind: "loop" }> => e.kind === "loop")
        .map((e) => e.loopId);
      if (!enclosing.includes(ref.loopId)) {
        // Not an ancestor. Give a targeted error whether the id is unknown,
        // an auto-id, or an addressable-but-not-enclosing loop.
        const target = index.get(ref.loopId);
        if (!target) {
          throw new PipelineValidationError(
            `${step.path}: \`\${loops.${ref.loopId}.${ref.tail}}\` references unknown loop id "${ref.loopId}"`,
            source,
          );
        }
        if (target.step.kind !== "loop") {
          throw new PipelineValidationError(
            `${step.path}: \`\${loops.${ref.loopId}.${ref.tail}}\` — "${ref.loopId}" is a ${target.step.kind}, not a loop`,
            source,
          );
        }
        if (!target.step.explicitId) {
          throw new PipelineValidationError(
            `${step.path}: \`\${loops.${ref.loopId}.…}\` references auto-generated id "${ref.loopId}" — add an explicit \`id:\` to the loop at ${target.step.path}`,
            source,
          );
        }
        throw new PipelineValidationError(
          `${step.path}: \`\${loops.${ref.loopId}.${ref.tail}}\` — loop "${ref.loopId}" does not enclose this step (\`loops.<id>.…\` walks outward from the current loop body)`,
          source,
        );
      }
    }
  }
}

function validateField(
  step: Step,
  producer: Step,
  ref: { id: string; field?: string; origin: string },
  source?: string,
): void {
  const field = ref.field!;
  const parts = field.split(".");
  const head = parts[0]!;
  // Loops: `<N>.<bodyStepId>.<field...>` addresses a specific iteration.
  // Everything else on a loop (`vars.stopped`, `ok`, `aborted`, …) is
  // accepted permissively — the runtime shape is fixed but small.
  if (producer.kind === "loop") {
    if (/^\d+$/.test(head)) return; // per-iteration path; trust it
    return;
  }
  if (head === "vars") {
    const varName = field.split(".")[1];
    if (!varName) {
      throw new PipelineValidationError(`${step.path}: ${ref.origin} — \`vars\` needs a name (vars.<name>)`, source);
    }
    if (producer.outputVar !== varName) {
      throw new PipelineValidationError(
        `${step.path}: ${ref.origin} — step "${producer.id}" does not define \`outputVar: ${varName}\`` +
          (producer.outputVar ? ` (it defines "${producer.outputVar}")` : ""),
        source,
      );
    }
    return;
  }
  const allowed = fieldsFor(producer.kind);
  if (!allowed.includes(head)) {
    throw new PipelineValidationError(
      `${step.path}: ${ref.origin} — "${head}" is not a field of a ${producer.kind} step ` +
        `(available: ${allowed.join(", ")}, vars.<name>)`,
      source,
    );
  }
}
