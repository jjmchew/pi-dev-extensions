import { beforeEach, describe, expect, it } from "vitest";
import { parsePipelineYaml } from "../parsers/yaml.ts";
import { happensBefore, indexSteps, validatePlan } from "../core/validate.ts";
import { setupRegistries } from "./helpers.ts";
import { registerExecutor } from "../core/registry.ts";
import { shellExecutor } from "../executors/shell.ts";
import { llmExecutor } from "../executors/llm.ts";

beforeEach(() => {
  setupRegistries();
  registerExecutor(shellExecutor);
  registerExecutor(llmExecutor);
});

function parse(yaml: string) {
  return parsePipelineYaml(yaml, "/tmp/test.yaml");
}

describe("YAML surface → IR mapping", () => {
  it("shell string form", () => {
    const plan = parse(`sequence:\n  - shell: yarn lint\n`);
    expect((plan.root as any).children[0]).toEqual({
      kind: "step",
      step: expect.objectContaining({
        kind: "shell",
        id: "s0",
        explicitId: false,
        path: "root.sequence[0].shell",
        config: { shellForm: true, cmd: "yarn lint" },
      }),
    });
  });

  it("shell object form", () => {
    const plan = parse(`sequence:\n  - shell: { cmd: yarn, args: [lint] }\n`);
    expect((plan.root as any).children[0].step.config).toEqual({
      shellForm: false,
      cmd: "yarn",
      args: ["lint"],
      env: undefined,
    });
  });

  it("llm skill and prompt forms", () => {
    const skill = parse(`sequence:\n  - llm: { skill: code-review }\n`);
    expect((skill.root as any).children[0].step.config).toMatchObject({ skill: "code-review" });
    const prompt = parse(`sequence:\n  - llm: { prompt: "hi" }\n`);
    expect((prompt.root as any).children[0].step.config).toMatchObject({ prompt: "hi" });
  });

  it("step knobs sit next to the kind key", () => {
    const plan = parse(
      `sequence:\n  - shell: yarn test\n    id: tests\n    continueOnError: true\n    outputVar: testLog\n    when: always()\n    timeoutMs: 5000\n    cwd: sub\n    env: { CI: "1" }\n`,
    );
    expect((plan.root as any).children[0].step).toMatchObject({
      id: "tests",
      explicitId: true,
      continueOnError: true,
      outputVar: "testLog",
      when: "always()",
      timeoutMs: 5000,
      cwd: "sub",
      env: { CI: "1" },
    });
  });

  it("parallel list form and object form with knobs", () => {
    const list = parse(`parallel:\n  - shell: a\n  - shell: b\n`);
    expect(list.root).toMatchObject({ kind: "parallel", children: [{}, {}] });

    const obj = parse(`parallel:\n  failFast: true\n  maxConcurrency: 4\n  children:\n    - shell: a\n`);
    expect(obj.root).toMatchObject({ kind: "parallel", failFast: true, maxConcurrency: 4 });
  });

  it("nested composers and DFS auto-ids", () => {
    const plan = parse(
      `sequence:\n  - parallel:\n      - shell: a\n      - sequence:\n          - shell: b\n          - shell: c\n  - shell: d\n`,
    );
    const ids = [...indexSteps(plan).keys()];
    expect(ids).toEqual(["s0", "s1", "s2", "s3"]);
    const paths = [...indexSteps(plan).values()].map((v) => v.step.path);
    expect(paths).toEqual([
      "root.sequence[0].parallel[0].shell",
      "root.sequence[0].parallel[1].sequence[0].shell",
      "root.sequence[0].parallel[1].sequence[1].shell",
      "root.sequence[1].shell",
    ]);
  });

  it("captures metadata and hashes the source", () => {
    const plan = parse(`name: checks\ndescription: d\nrunsDir: /tmp/runs\ntimeoutMs: 1000\nsequence:\n  - shell: a\n`);
    expect(plan).toMatchObject({ name: "checks", description: "d", runsDir: "/tmp/runs", timeoutMs: 1000 });
    expect(plan.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to the file name when `name:` is omitted", () => {
    expect(parse(`sequence:\n  - shell: a\n`).name).toBe("test");
  });

  it("reads promptFile relative to the pipeline source and hashes it", () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-promptfile-"));
    const file = join(dir, "prompt.md");
    const yamlSource = join(dir, "pipeline.yaml");
    writeFileSync(file, "be terse\n");
    try {
      const plan = parsePipelineYaml(
        `sequence:\n  - llm:\n      promptFile: prompt.md\n      mode: rpc\n      reasoning: high\n`,
        yamlSource,
      );
      const cfg = (plan.root as any).children[0].step.config;
      expect(cfg.prompt).toBe("be terse\n");
      expect(cfg.promptFile).toBe(file);
      expect(cfg.promptFileSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(cfg.mode).toBe("rpc");
      expect(cfg.reasoning).toBe("high");
    } finally {
      unlinkSync(file);
    }
  });

  it("rejects an unknown reasoning level", () => {
    expect(() => parse(`sequence:\n  - llm:\n      prompt: hi\n      reasoning: turbo\n`)).toThrow(/reasoning/);
  });
});

describe("parse errors", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["no composer", `shell: yarn lint\n`, /exactly one of `sequence:` or `parallel:`/],
    ["steps: key", `steps:\n  - shell: a\n`, /`steps:` is not supported/],
    ["two composers", `sequence: []\nparallel: []\n`, /exactly one composer key/],
    ["unknown top-level key", `bogus: 1\nsequence: []\n`, /unknown top-level key "bogus"/],
    ["mixing composers in an item", `sequence:\n  - sequence: []\n    parallel: []\n`, /cannot mix/],
    ["mixing kinds", `sequence:\n  - shell: a\n    llm: { prompt: x }\n`, /cannot mix step kinds/],
    ["unknown step key", `sequence:\n  - shell: a\n    bogus: 1\n`, /unknown step key "bogus"/],
    ["knob inside llm", `sequence:\n  - llm: { prompt: x, id: y }\n`, /step knob/],
    [
      "llm with skill+prompt",
      `sequence:\n  - llm: { skill: a, prompt: b }\n`,
      /exactly one of `skill`, `command`, `prompt`, or `promptFile`/,
    ],
    [
      "llm with skill+command",
      `sequence:\n  - llm: { skill: a, command: b }\n`,
      /exactly one of `skill`, `command`, `prompt`, or `promptFile`/,
    ],
    ["llm with neither", `sequence:\n  - llm: {}\n`, /exactly one of `skill`, `command`, `prompt`, or `promptFile`/],
    ["empty shell", `sequence:\n  - shell: ""\n`, /may not be empty/],
    ["auto-id collision", `sequence:\n  - shell: a\n    id: s3\n`, /auto-id namespace/],
    ["bad timeout", `sequence:\n  - shell: a\n    timeoutMs: -1\n`, /positive number/],
    ["knobs on composer", `sequence:\n  - parallel: []\n    when: always()\n`, /unexpected key/],
    ["non-mapping item", `sequence:\n  - just a string\n`, /must be a mapping/],
    ["unknown kind", `sequence:\n  - http: { url: x }\n`, /no step kind or composer found/],
  ];

  it.each(cases)("%s", (_name, yaml, re) => {
    expect(() => parse(yaml)).toThrow(re);
  });

  it("error messages name the file and the yaml path", () => {
    expect(() => parse(`sequence:\n  - shell: a\n    bogus: 1\n`)).toThrow(/\/tmp\/test\.yaml: at root\.sequence\[0\]\.bogus/);
  });
});

describe("static reference validation", () => {
  it("accepts a reference to an earlier sequence sibling", () => {
    const plan = parse(
      `sequence:\n  - shell: yarn test\n    id: tests\n  - llm:\n      skill: bug\n      args: "\${steps.tests.stderr}"\n    when: failure(tests)\n`,
    );
    expect(() => validatePlan(plan)).not.toThrow();
  });

  it("accepts a reference into an already-finished parallel block", () => {
    const plan = parse(
      `sequence:\n  - parallel:\n      - shell: a\n        id: lint\n      - shell: b\n        id: tests\n  - shell: c\n    when: success(lint, tests)\n`,
    );
    expect(() => validatePlan(plan)).not.toThrow();
  });

  it("rejects referencing a concurrent sibling", () => {
    const plan = parse(
      `parallel:\n  - shell: a\n    id: lint\n  - shell: b\n    id: tests\n    when: success(lint)\n`,
    );
    expect(() => validatePlan(plan)).toThrow(/not guaranteed to finish first/);
  });

  it("rejects referencing a later step", () => {
    const plan = parse(`sequence:\n  - shell: a\n    when: success(later)\n  - shell: b\n    id: later\n`);
    expect(() => validatePlan(plan)).toThrow(/not guaranteed to finish first/);
  });

  it("rejects referencing an auto-generated id", () => {
    const plan = parse(`sequence:\n  - shell: a\n  - shell: b\n    when: success(s0)\n`);
    expect(() => validatePlan(plan)).toThrow(/auto-generated id/);
  });

  it("rejects unknown ids", () => {
    const plan = parse(`sequence:\n  - shell: a\n    when: success(ghost)\n`);
    expect(() => validatePlan(plan)).toThrow(/unknown step id "ghost"/);
  });

  it("rejects duplicate explicit ids", () => {
    const plan = parse(`sequence:\n  - shell: a\n    id: dup\n  - shell: b\n    id: dup\n`);
    expect(() => validatePlan(plan)).toThrow(/duplicate step id/);
  });

  it("rejects fields that the producer kind cannot produce", () => {
    const plan = parse(
      `sequence:\n  - llm: { prompt: hi }\n    id: gen\n  - shell: "echo \${steps.gen.exitCode}"\n`,
    );
    expect(() => validatePlan(plan)).toThrow(/"exitCode" is not a field of a llm step/);
  });

  it("rejects vars.<name> that does not match the producer outputVar", () => {
    const plan = parse(
      `sequence:\n  - llm: { prompt: hi }\n    id: gen\n    outputVar: reviewText\n  - shell: "echo \${steps.gen.vars.other}"\n`,
    );
    expect(() => validatePlan(plan)).toThrow(/does not define `outputVar: other`/);
  });

  it("accepts a matching vars.<name>", () => {
    const plan = parse(
      `sequence:\n  - llm: { prompt: hi }\n    id: gen\n    outputVar: reviewText\n  - shell:\n      cmd: echo\n      args: ["\${steps.gen.vars.reviewText}"]\n`,
    );
    expect(() => validatePlan(plan)).not.toThrow();
  });

  it("rejects a malformed when expression at load time", () => {
    const plan = parse(`sequence:\n  - shell: a\n    when: "success("\n`);
    expect(() => validatePlan(plan)).toThrow(/when:/);
  });
});

describe("happensBefore", () => {
  it("orders by the closest common ancestor", () => {
    const seqEarly = [{ kind: "sequence" as const, index: 0 }];
    const seqLate = [{ kind: "sequence" as const, index: 1 }];
    expect(happensBefore(seqEarly, seqLate)).toBe(true);
    expect(happensBefore(seqLate, seqEarly)).toBe(false);

    const parA = [{ kind: "parallel" as const, index: 0 }];
    const parB = [{ kind: "parallel" as const, index: 1 }];
    expect(happensBefore(parA, parB)).toBe(false);

    // Inside an earlier sequence branch, nesting depth does not matter.
    const deep = [
      { kind: "sequence" as const, index: 0 },
      { kind: "parallel" as const, index: 3 },
    ];
    expect(happensBefore(deep, seqLate)).toBe(true);
  });
});

describe("bundled examples", () => {
  it("every file in examples/ parses and validates", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    const names = files.map((f) => {
      const file = join(dir, f);
      const plan = parsePipelineYaml(readFileSync(file, "utf8"), file);
      validatePlan(plan);
      return plan.name;
    });
    expect(names).toContain("checks");
    expect(names).toContain("review-and-clean");
  });
});
