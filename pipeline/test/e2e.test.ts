/**
 * End-to-end: a real temp project with a `.pi/pipelines/e2e.yaml` driven
 * through the command handlers and the `run_pipeline` tool, with llm steps
 * pointed at the fake-pi fixture.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { listCommand } from "../commands/list.ts";
import { runCommand } from "../commands/run.ts";
import { runsCommand } from "../commands/runs.ts";
import { showCommand } from "../commands/show.ts";
import { runPipelineTool } from "../commands/tool.ts";
import { traceCommand } from "../commands/trace.ts";
import { parseArgs } from "../commands/ctx.ts";
import type { CmdCtx } from "../commands/ctx.ts";
import { registerExecutor } from "../core/registry.ts";
import { llmExecutor } from "../executors/llm.ts";
import { shellExecutor } from "../executors/shell.ts";
import { setupRegistries } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(here, "fixtures", "fake-pi.mjs");

let runsDir: string;

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

beforeEach(() => {
  setupRegistries();
  registerExecutor(shellExecutor);
  registerExecutor(llmExecutor);

  // A private agent dir so the tests never read the developer's real settings.
  const agentDir = tmp("pipeline-agent-");
  runsDir = join(agentDir, "runs", "pipelines");
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      pipeline: { piBin: FAKE_PI, retention: { keepLast: 5 }, runsDir },
    }),
  );
  process.env.PI_AGENT_DIR = agentDir;
});

function writePipeline(dir: string, name: string, yaml: string): void {
  const pdir = join(dir, ".pi", "pipelines");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, `${name}.yaml`), yaml);
}

function mockCtx(cwd: string): CmdCtx & { output: string[]; widgets: Array<string[] | undefined> } {
  const output: string[] = [];
  const widgets: Array<string[] | undefined> = [];
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    output,
    widgets,
    ui: {
      notify: (msg: string) => output.push(msg),
      setWidget: (_id: string, lines: string[] | undefined) => widgets.push(lines),
    },
  };
}

const E2E_YAML = `
name: e2e
description: shell + llm, sequential and parallel
sequence:
  - parallel:
      - shell: echo linting
        id: lint
      - shell: "echo testing; exit 1"
        id: tests
        continueOnError: true
  - llm:
      prompt: "review please"
    id: review
    outputVar: reviewText
    when: success(lint)
  - shell:
      cmd: echo
      args: ["\${steps.review.vars.reviewText}"]
    id: echoReview
  - llm:
      prompt: "should not run"
    id: skipMe
    when: success(tests)
`;

describe("/pipeline end to end", () => {
  it("runs a mixed pipeline and reports a summary", async () => {
    const cwd = tmp("pipeline-proj-");
    writePipeline(cwd, "e2e", E2E_YAML);
    const ctx = mockCtx(cwd);

    await runCommand("e2e", ctx);

    const summary = ctx.output.join("\n");
    expect(summary).toContain("pipeline e2e: partial");
    expect(summary).toContain("3/5 ok");
    expect(summary).toContain("1 failed");
    expect(summary).toContain("1 skipped");

    // TUI widget was rendered with one row per step
    const lastWidget = ctx.widgets.at(-1)!;
    expect(lastWidget[0]).toContain("pipeline e2e");
    expect(lastWidget.join("\n")).toMatch(/✓ lint/);
    expect(lastWidget.join("\n")).toMatch(/✗ tests/);
    expect(lastWidget.join("\n")).toMatch(/↷ skipMe/);

    // disk layout
    const runId = summary.match(/([0-9A-Z]{26})/)![1]!;
    const runDir = join(runsDir, runId);
    expect(existsSync(join(runDir, "run.json"))).toBe(true);

    // the llm step's verbatim child stream landed in trace.jsonl
    const trace = readFileSync(join(runDir, "steps", "review", "trace.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(trace[0].type).toBe("session");
    expect(trace.some((e) => e.type === "message_end")).toBe(true);

    // ${steps.review.vars.reviewText} reached the following shell step
    expect(readFileSync(join(runDir, "steps", "echoReview", "stdout.log"), "utf8").trim()).toBe("done");

    const manifest = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    expect(manifest.status).toBe("partial");
    expect(manifest.totals.usage).toMatchObject({ input: 100, output: 20, turns: 1 });
    expect(manifest.invoker.kind).toBe("command");
  });

  it("reports load errors instead of throwing", async () => {
    const cwd = tmp("pipeline-proj-");
    writePipeline(cwd, "bad", "sequence:\n  - shell: a\n    when: success(ghost)\n");
    const ctx = mockCtx(cwd);
    await runCommand("bad", ctx);
    expect(ctx.output.join("\n")).toMatch(/failed to start.*unknown step id "ghost"/s);
  });

  it("says something useful when the pipeline does not exist", async () => {
    const ctx = mockCtx(tmp("pipeline-proj-"));
    await runCommand("nope", ctx);
    expect(ctx.output.join("\n")).toMatch(/not found/);
  });
});

describe("run_pipeline tool", () => {
  it("returns the documented output shape", async () => {
    const cwd = tmp("pipeline-proj-");
    writePipeline(cwd, "tool", `sequence:\n  - shell: echo hi\n    id: hi\n`);
    const updates: string[] = [];
    const result = await runPipelineTool(
      { name: "tool" },
      { cwd, onUpdate: (t) => updates.push(t), sessionId: "sess-1" },
    );
    expect(result.status).toBe("ok");
    expect(result.runId).toMatch(/^[0-9A-Z]{26}$/);
    expect(result.totals.steps).toEqual({ total: 1, ok: 1, failed: 0, skipped: 0 });
    expect(existsSync(join(result.runDir!, "run.json"))).toBe(true);
    expect(updates.at(-1)).toContain("✓ hi");
    const manifest = JSON.parse(readFileSync(join(result.runDir!, "run.json"), "utf8"));
    expect(manifest.invoker).toMatchObject({ kind: "tool", sessionId: "sess-1" });
  });

  it("honours a run-level timeout by aborting", async () => {
    const cwd = tmp("pipeline-proj-");
    writePipeline(cwd, "slow", `sequence:\n  - shell: sleep 10\n    id: slow\n`);
    const result = await runPipelineTool({ name: "slow", timeoutMs: 150 }, { cwd });
    expect(result.status).toBe("aborted");
  });
});

describe("review commands", () => {
  it("lists, shows and traces a run", async () => {
    const cwd = tmp("pipeline-proj-");
    writePipeline(cwd, "e2e", E2E_YAML);
    const ctx = mockCtx(cwd);

    await listCommand("", ctx);
    expect(ctx.output.at(-1)).toMatch(/e2e\s+project\s+.*e2e\.yaml/);

    await runCommand("e2e", ctx);
    const runId = ctx.output.join("\n").match(/([0-9A-Z]{26})/)![1]!;

    await runsCommand("", ctx);
    expect(ctx.output.at(-1)).toContain(runId);
    expect(ctx.output.at(-1)).toContain("partial");

    await showCommand(runId, ctx);
    const shown = ctx.output.at(-1)!;
    expect(shown).toContain("e2e");
    expect(shown).toContain("✓ lint");
    expect(shown).toContain("root.sequence[0].parallel[0].shell");

    // a unique run-id prefix resolves too
    await showCommand(runId.slice(0, 10), ctx);
    expect(ctx.output.at(-1)).toContain(runId);

    await traceCommand(`${runId} review`, ctx);
    expect(ctx.output.at(-1)).toContain("assistant: done");
    expect(ctx.output.at(-1)).toContain("← bash");

    await traceCommand(`${runId} lint`, ctx);
    expect(ctx.output.at(-1)).toMatch(/no trace for step "lint"/);
  });
});

describe("discovery and shadowing", () => {
  it("prefers a project pipeline over the global one", async () => {
    const home = tmp("pipeline-home-");
    const cwd = tmp("pipeline-proj-");
    writePipeline(home, "dup", `sequence:\n  - shell: echo global\n    id: g\n`);
    writePipeline(cwd, "dup", `sequence:\n  - shell: echo project\n    id: p\n`);

    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = mockCtx(cwd);
      await listCommand("", ctx);
      const listing = ctx.output.at(-1)!;
      expect(listing.split("\n").filter((l) => l.includes(" dup "))).toHaveLength(2);
      expect(listing).toContain("(shadowed)");

      await runCommand("dup", ctx);
      const runId = ctx.output.join("\n").match(/([0-9A-Z]{26})/)![1]!;
      expect(readFileSync(join(runsDir, runId, "steps", "p", "stdout.log"), "utf8").trim()).toBe("project");
    } finally {
      process.env.HOME = realHome;
    }
  });
});

describe("flag parsing", () => {
  it("splits positional text from recognised flags", () => {
    expect(parseArgs('checks some args --runs-dir /tmp/x --json', ["runs-dir", "json", "timeout"])).toEqual({
      positional: "checks some args",
      flags: { "runs-dir": "/tmp/x", json: true },
    });
    expect(parseArgs("checks --timeout=500", ["timeout"])).toEqual({
      positional: "checks",
      flags: { timeout: "500" },
    });
    expect(parseArgs('run "quoted arg"', [])).toEqual({ positional: "run quoted arg", flags: {} });
  });
});
