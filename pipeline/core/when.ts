/**
 * `when:` expression evaluator.
 *
 * A deliberately tiny language: boolean operators (`&&`, `||`, `!`, parens),
 * a closed set of helper functions, string and `/regex/` literals, bare step
 * ids, and `steps.<id>.<field>` accessors. No arithmetic, no user-defined
 * functions — the whole thing must stay auditable.
 *
 *   success(lint, tests) && contains(steps.tests.stderr, "flaky")
 *
 * `evaluateWhen` runs an expression against the run's `Results`.
 * `extractRefs` returns every step reference in an expression so the loader
 * can statically check ordering before anything runs.
 */
import type { LoopScope, Results, StepResult } from "./types.ts";
import { lookupStep as resolveLookupStep } from "./resolve.ts";

// ─── tokenizer ────────────────────────────────────────────────────────────

type Tok =
  | { t: "ident"; v: string }
  | { t: "string"; v: string }
  | { t: "regex"; v: string; flags: string }
  | { t: "op"; v: "&&" | "||" | "!" | "(" | ")" | "," };

export class WhenError extends Error {}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "&" || c === "|") {
      if (src[i + 1] !== c) throw new WhenError(`when: expected "${c}${c}" at offset ${i}`);
      toks.push({ t: "op", v: (c + c) as "&&" | "||" });
      i += 2;
      continue;
    }
    if (c === "!" || c === "(" || c === ")" || c === ",") {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let out = "";
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i + 1];
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new WhenError(`when: unterminated string literal`);
      i++; // closing quote
      toks.push({ t: "string", v: out });
      continue;
    }
    if (c === "/") {
      let out = "";
      i++;
      while (i < src.length && src[i] !== "/") {
        if (src[i] === "\\" && i + 1 < src.length) {
          out += src[i] + src[i + 1];
          i += 2;
        } else {
          out += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new WhenError(`when: unterminated regex literal`);
      i++; // closing slash
      let flags = "";
      while (i < src.length && /[a-z]/.test(src[i]!)) flags += src[i++];
      toks.push({ t: "regex", v: out, flags });
      continue;
    }
    if (/[A-Za-z0-9_.\-$]/.test(c)) {
      let out = "";
      while (i < src.length && /[A-Za-z0-9_.\-$]/.test(src[i]!)) out += src[i++];
      toks.push({ t: "ident", v: out });
      continue;
    }
    throw new WhenError(`when: unexpected character "${c}" at offset ${i}`);
  }
  return toks;
}

// ─── AST ──────────────────────────────────────────────────────────────────

type Ast =
  | { n: "and"; l: Ast; r: Ast }
  | { n: "or"; l: Ast; r: Ast }
  | { n: "not"; e: Ast }
  | { n: "call"; name: string; args: Ast[] }
  | { n: "string"; v: string }
  | { n: "regex"; v: string; flags: string }
  | { n: "ident"; v: string };

function parse(src: string): Ast {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (v: string) => {
    const tk = toks[pos];
    if (!tk || tk.t !== "op" || tk.v !== v) throw new WhenError(`when: expected "${v}" in ${JSON.stringify(src)}`);
    pos++;
  };

  function parseOr(): Ast {
    let l = parseAnd();
    while (peek()?.t === "op" && (peek() as any).v === "||") {
      pos++;
      l = { n: "or", l, r: parseAnd() };
    }
    return l;
  }
  function parseAnd(): Ast {
    let l = parseUnary();
    while (peek()?.t === "op" && (peek() as any).v === "&&") {
      pos++;
      l = { n: "and", l, r: parseUnary() };
    }
    return l;
  }
  function parseUnary(): Ast {
    const tk = peek();
    if (tk?.t === "op" && tk.v === "!") {
      pos++;
      return { n: "not", e: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary(): Ast {
    const tk = peek();
    if (!tk) throw new WhenError(`when: unexpected end of expression in ${JSON.stringify(src)}`);
    if (tk.t === "op" && tk.v === "(") {
      pos++;
      const e = parseOr();
      eat(")");
      return e;
    }
    if (tk.t === "string") {
      pos++;
      return { n: "string", v: tk.v };
    }
    if (tk.t === "regex") {
      pos++;
      return { n: "regex", v: tk.v, flags: tk.flags };
    }
    if (tk.t === "ident") {
      pos++;
      const next = peek();
      if (next?.t === "op" && next.v === "(") {
        pos++;
        const args: Ast[] = [];
        if (!(peek()?.t === "op" && (peek() as any).v === ")")) {
          for (;;) {
            args.push(parseOr());
            const sep = peek();
            if (sep?.t === "op" && sep.v === ",") {
              pos++;
              continue;
            }
            break;
          }
        }
        eat(")");
        return { n: "call", name: tk.v, args };
      }
      return { n: "ident", v: tk.v };
    }
    throw new WhenError(`when: unexpected token in ${JSON.stringify(src)}`);
  }

  const ast = parseOr();
  if (pos !== toks.length) throw new WhenError(`when: trailing input in ${JSON.stringify(src)}`);
  return ast;
}

const HELPERS = new Set(["success", "failure", "skipped", "always", "never", "contains", "equals", "matches"]);

// ─── evaluation ───────────────────────────────────────────────────────────

function stepIdOf(a: Ast): string {
  if (a.n === "ident") return a.v;
  if (a.n === "string") return a.v;
  throw new WhenError(`when: expected a step id argument`);
}

function lookup(results: Results, ref: string, loopScope?: LoopScope): unknown {
  // "steps.<id>.<field...>" — defer to the shared loop-aware resolver.
  if (!ref.startsWith("steps.")) return undefined;
  return resolveLookupStep(ref, results, loopScope);
}

/** Resolve a bare id (from a boolean position) to a StepResult if any. */
function lookupBareId(results: Results, id: string, loopScope?: LoopScope): StepResult | undefined {
  let scope = loopScope;
  while (scope) {
    const key = `${scope.prefix}.${scope.iteration}.${id}`;
    if (results[key]) return results[key];
    scope = scope.parent;
  }
  return results[id];
}

function valueOf(a: Ast, results: Results, loopScope?: LoopScope): unknown {
  switch (a.n) {
    case "string":
      return a.v;
    case "regex":
      return new RegExp(a.v, a.flags);
    case "ident":
      return a.v.startsWith("steps.") ? lookup(results, a.v, loopScope) : a.v;
    default:
      return evalAst(a, results, loopScope);
  }
}

function evalAst(a: Ast, results: Results, loopScope?: LoopScope): boolean {
  switch (a.n) {
    case "and":
      return evalAst(a.l, results, loopScope) && evalAst(a.r, results, loopScope);
    case "or":
      return evalAst(a.l, results, loopScope) || evalAst(a.r, results, loopScope);
    case "not":
      return !evalAst(a.e, results, loopScope);
    case "ident": {
      // A bare id in boolean position means "that step succeeded".
      const v = a.v.startsWith("steps.")
        ? lookup(results, a.v, loopScope)
        : lookupBareId(results, a.v, loopScope)?.ok;
      return Boolean(v);
    }
    case "string":
      return a.v.length > 0;
    case "regex":
      return true;
    case "call":
      return evalCall(a, results, loopScope);
  }
}

function evalCall(a: Extract<Ast, { n: "call" }>, results: Results, loopScope?: LoopScope): boolean {
  const name = a.name;
  if (!HELPERS.has(name)) {
    throw new WhenError(`when: unknown helper "${name}()" (allowed: ${[...HELPERS].sort().join(", ")})`);
  }
  switch (name) {
    case "always":
      return true;
    case "never":
      return false;
    case "success": {
      if (a.args.length === 0) throw new WhenError(`when: success() requires at least one step id`);
      return a.args.every((arg) => lookupBareId(results, stepIdOf(arg), loopScope)?.ok === true);
    }
    case "failure": {
      if (a.args.length === 0) throw new WhenError(`when: failure() requires at least one step id`);
      return a.args.some((arg) => lookupBareId(results, stepIdOf(arg), loopScope)?.ok === false);
    }
    case "skipped": {
      if (a.args.length === 0) throw new WhenError(`when: skipped() requires at least one step id`);
      return a.args.every((arg) => lookupBareId(results, stepIdOf(arg), loopScope)?.skipped === true);
    }
    case "contains": {
      if (a.args.length !== 2) throw new WhenError(`when: contains(value, needle) takes 2 arguments`);
      const hay = valueOf(a.args[0]!, results, loopScope);
      const needle = valueOf(a.args[1]!, results, loopScope);
      return String(hay ?? "").includes(String(needle ?? ""));
    }
    case "equals": {
      if (a.args.length !== 2) throw new WhenError(`when: equals(a, b) takes 2 arguments`);
      const l = valueOf(a.args[0]!, results, loopScope);
      const r = valueOf(a.args[1]!, results, loopScope);
      return String(l ?? "") === String(r ?? "");
    }
    case "matches": {
      if (a.args.length !== 2) throw new WhenError(`when: matches(value, /re/) takes 2 arguments`);
      const v = String(valueOf(a.args[0]!, results, loopScope) ?? "");
      const p = valueOf(a.args[1]!, results, loopScope);
      const re = p instanceof RegExp ? p : new RegExp(String(p));
      return re.test(v);
    }
  }
  return false;
}

export function evaluateWhen(expr: string, results: Results, loopScope?: LoopScope): boolean {
  return evalAst(parse(expr), results, loopScope);
}

// ─── static analysis ──────────────────────────────────────────────────────

export type WhenRef = { id: string; field?: string };

/** Every step referenced by an expression, for the loader's ordering check. */
export function extractRefs(expr: string): WhenRef[] {
  const refs: WhenRef[] = [];
  const walk = (a: Ast, inStepIdPosition: boolean) => {
    switch (a.n) {
      case "and":
      case "or":
        walk(a.l, false);
        walk(a.r, false);
        return;
      case "not":
        walk(a.e, false);
        return;
      case "ident":
        if (a.v.startsWith("steps.")) {
          const parts = a.v.split(".");
          if (parts.length >= 3) refs.push({ id: parts[1]!, field: parts.slice(2).join(".") });
        } else if (inStepIdPosition) {
          refs.push({ id: a.v });
        }
        return;
      case "call": {
        const idArgs = a.name === "success" || a.name === "failure" || a.name === "skipped";
        for (const arg of a.args) walk(arg, idArgs);
        return;
      }
      default:
        return;
    }
  };
  walk(parse(expr), false);
  return refs;
}

/** Parse-only check; throws WhenError on bad syntax or unknown helpers. */
export function validateWhen(expr: string): void {
  const ast = parse(expr);
  const walk = (a: Ast) => {
    switch (a.n) {
      case "and":
      case "or":
        walk(a.l);
        walk(a.r);
        return;
      case "not":
        walk(a.e);
        return;
      case "call":
        if (!HELPERS.has(a.name)) {
          throw new WhenError(`when: unknown helper "${a.name}()" (allowed: ${[...HELPERS].sort().join(", ")})`);
        }
        for (const arg of a.args) walk(arg);
        return;
      default:
        return;
    }
  };
  walk(ast);
}
