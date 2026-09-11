import { describe, expect, it } from "vitest";
import { freezePlan, interpolate, interpolateValue, mergeEnv, resolveCwd } from "../core/resolve.ts";
import type { Results } from "../core/types.ts";

describe("resolveCwd", () => {
  it("prefers step over plan over invocation cwd", () => {
    expect(resolveCwd("/abs/step", "/abs/plan", "/abs/ctx")).toBe("/abs/step");
    expect(resolveCwd(undefined, "/abs/plan", "/abs/ctx")).toBe("/abs/plan");
    expect(resolveCwd(undefined, undefined, "/abs/ctx")).toBe("/abs/ctx");
  });

  it("resolves relative paths against the invocation cwd, not the yaml file", () => {
    expect(resolveCwd("sub/dir", undefined, "/repo/worktree")).toBe("/repo/worktree/sub/dir");
    expect(resolveCwd(undefined, "../sibling", "/repo/worktree")).toBe("/repo/sibling");
  });
});

describe("mergeEnv", () => {
  it("merges left to right, dropping undefined", () => {
    expect(mergeEnv({ A: "1", B: "2" }, { B: "3" }, undefined, { C: "4" })).toEqual({ A: "1", B: "3", C: "4" });
    expect(mergeEnv({ A: undefined as unknown as string })).toEqual({});
  });
});

describe("interpolate", () => {
  const results: Results = {
    tests: { id: "tests", ok: false, skipped: false, stderr: "boom", vars: { log: "captured" } },
  };

  it("expands env in both forms", () => {
    const env = { FOO: "bar" };
    expect(interpolate("x=${FOO}", { env })).toBe("x=bar");
    expect(interpolate("x=${env.FOO}", { env })).toBe("x=bar");
  });

  it("expands step outputs including vars", () => {
    expect(interpolate("${steps.tests.stderr}", { results })).toBe("boom");
    expect(interpolate("${steps.tests.vars.log}", { results })).toBe("captured");
  });

  it("reports misses and substitutes empty string", () => {
    const misses: string[] = [];
    expect(interpolate("[${NOPE}][${steps.ghost.output}]", { env: {}, results, onMiss: (r) => misses.push(r) })).toBe(
      "[][]",
    );
    expect(misses).toEqual(["NOPE", "steps.ghost.output"]);
  });

  it("leaves step refs alone in envOnly mode", () => {
    expect(interpolate("${FOO} ${steps.tests.stderr}", { env: { FOO: "1" }, envOnly: true })).toBe(
      "1 ${steps.tests.stderr}",
    );
  });

  it("walks nested config structures", () => {
    const cfg = { cmd: "echo", args: ["${FOO}", { deep: "${FOO}" }] };
    expect(interpolateValue(cfg, { env: { FOO: "hi" } })).toEqual({ cmd: "echo", args: ["hi", { deep: "hi" }] });
  });
});

describe("freezePlan", () => {
  it("expands env eagerly, resolves plan cwd, and injects built-ins", () => {
    const { plan, env } = freezePlan(
      {
        name: "p",
        cwd: "sub",
        env: { GREETING: "hello ${env.RUN_ID}" },
        root: {
          kind: "sequence",
          children: [
            {
              kind: "step",
              step: {
                kind: "shell",
                id: "a",
                path: "root.sequence[0].shell",
                config: { shellForm: true, cmd: "echo ${GREETING} ${steps.b.output}" },
              },
            },
          ],
        },
      },
      { cwd: "/tmp/proj", runId: "RUN1" },
    );

    expect(plan.cwd).toBe("/tmp/proj/sub");
    expect(env.RUN_ID).toBe("RUN1");
    expect(env.PIPELINE_CWD).toBe("/tmp/proj/sub");
    expect(plan.env).toEqual({ GREETING: "hello RUN1" });
    const cfg = (plan.root as any).children[0].step.config;
    // env expanded eagerly, step refs left for dispatch time
    expect(cfg.cmd).toBe("echo hello RUN1 ${steps.b.output}");
  });
});
