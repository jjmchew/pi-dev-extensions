import { describe, expect, it } from "vitest";
import { evaluateWhen, extractRefs, validateWhen, WhenError } from "../core/when.ts";
import type { Results, StepResult } from "../core/types.ts";

function res(over: Partial<StepResult> & { id: string }): StepResult {
  return { ok: true, skipped: false, vars: {}, ...over };
}

const results: Results = {
  lint: res({ id: "lint", ok: true }),
  tests: res({ id: "tests", ok: false, stderr: "3 flaky tests failed", exitCode: 1 }),
  types: res({ id: "types", ok: true, skipped: true }),
  review: res({ id: "review", ok: true, output: "LGTM", vars: { reviewText: "LGTM" } }),
};

describe("helpers", () => {
  it("success/failure/skipped/always/never", () => {
    expect(evaluateWhen("success(lint)", results)).toBe(true);
    expect(evaluateWhen("success(lint, types)", results)).toBe(true); // skipped counts as success
    expect(evaluateWhen("success(lint, tests)", results)).toBe(false);
    expect(evaluateWhen("failure(tests)", results)).toBe(true);
    expect(evaluateWhen("failure(lint)", results)).toBe(false);
    expect(evaluateWhen("failure(lint, tests)", results)).toBe(true);
    expect(evaluateWhen("skipped(types)", results)).toBe(true);
    expect(evaluateWhen("skipped(lint)", results)).toBe(false);
    expect(evaluateWhen("always()", results)).toBe(true);
    expect(evaluateWhen("never()", results)).toBe(false);
  });

  it("contains/equals/matches read through the addressing scheme", () => {
    expect(evaluateWhen('contains(steps.tests.stderr, "flaky")', results)).toBe(true);
    expect(evaluateWhen('contains(steps.tests.stderr, "segfault")', results)).toBe(false);
    expect(evaluateWhen('equals(steps.review.output, "LGTM")', results)).toBe(true);
    expect(evaluateWhen("matches(steps.tests.stderr, /\\d+ flaky/)", results)).toBe(true);
    expect(evaluateWhen("matches(steps.tests.stderr, /^clean$/)", results)).toBe(false);
    expect(evaluateWhen('equals(steps.review.vars.reviewText, "LGTM")', results)).toBe(true);
  });

  it("missing steps are neither success nor failure", () => {
    expect(evaluateWhen("success(ghost)", results)).toBe(false);
    expect(evaluateWhen("failure(ghost)", results)).toBe(false);
  });
});

describe("operators and precedence", () => {
  it("&& binds tighter than ||", () => {
    // false && false || true  →  true
    expect(evaluateWhen("failure(lint) && failure(lint) || success(lint)", results)).toBe(true);
    // true || (true && false) → short-circuit true
    expect(evaluateWhen("success(lint) || success(lint) && failure(lint)", results)).toBe(true);
  });

  it("parens and negation", () => {
    expect(evaluateWhen("!(success(lint) && success(tests))", results)).toBe(true);
    expect(evaluateWhen("!skipped(types)", results)).toBe(false);
    expect(evaluateWhen("!skipped(lint) && success(lint)", results)).toBe(true);
  });

  it("combined real-world expression", () => {
    expect(evaluateWhen('failure(tests) && contains(steps.tests.stderr, "flaky")', results)).toBe(true);
  });
});

describe("errors", () => {
  it.each([
    "success(",
    "success(lint))",
    "&& success(lint)",
    'contains("a")',
    "bogus(lint)",
    'contains(steps.tests.stderr, "unterminated',
    "matches(steps.tests.stderr, /unterminated)",
  ])("rejects %s", (expr) => {
    expect(() => evaluateWhen(expr, results)).toThrow();
  });

  it("names the allowed helpers", () => {
    expect(() => validateWhen("bogus(lint)")).toThrow(WhenError);
    expect(() => validateWhen("bogus(lint)")).toThrow(/allowed: always, contains/);
  });
});

describe("extractRefs", () => {
  it("collects ids from helper arguments and accessors", () => {
    expect(extractRefs("success(lint, tests)")).toEqual([{ id: "lint" }, { id: "tests" }]);
    expect(extractRefs('contains(steps.tests.stderr, "flaky")')).toEqual([{ id: "tests", field: "stderr" }]);
    expect(extractRefs("failure(tests) && equals(steps.review.vars.reviewText, steps.lint.output)")).toEqual([
      { id: "tests" },
      { id: "review", field: "vars.reviewText" },
      { id: "lint", field: "output" },
    ]);
    expect(extractRefs("always()")).toEqual([]);
  });
});
