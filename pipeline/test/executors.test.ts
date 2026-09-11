import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellExecutor } from "../executors/shell.ts";
import { buildArgs, buildPrompt, buildRpcArgs, foldLlmEvent, llmExecutor, resolveModel } from "../executors/llm.ts";
import type { Step, StepContext, StepEvent } from "../core/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(here, "fixtures", "fake-pi.mjs");

function ctx(over: Partial<StepContext> = {}): StepContext {
  return {
    runId: "r",
    cwd: process.cwd(),
    signal: new AbortController().signal,
    results: {},
    stepPath: "root.x",
    ...over,
  } as StepContext;
}

async function drain(gen: AsyncIterable<StepEvent>): Promise<StepEvent[]> {
  const out: StepEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function shellStep(config: any, over: Partial<Step> = {}): Step & { config: any } {
  return { kind: "shell", id: "sh", path: "root.sh", config, ...over } as any;
}

describe("shell executor", () => {
  it("runs the string form through /bin/sh (pipes work)", async () => {
    const events = await drain(
      shellExecutor.run(shellStep({ shellForm: true, cmd: "echo hello | tr a-z A-Z" }), ctx()),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(true);
    expect(end.details.exitCode).toBe(0);
    expect(end.details.output.trim()).toBe("HELLO");
    expect(events.some((e) => e.type === "log" && e.chunk.includes("HELLO"))).toBe(true);
  });

  it("runs the object form without a shell", async () => {
    const events = await drain(
      shellExecutor.run(shellStep({ shellForm: false, cmd: "echo", args: ["a", "b"] }), ctx()),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.details.output.trim()).toBe("a b");
  });

  it("captures stderr and a non-zero exit", async () => {
    const events = await drain(
      shellExecutor.run(shellStep({ shellForm: true, cmd: "echo oops >&2; exit 3" }), ctx()),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(false);
    expect(end.details.exitCode).toBe(3);
    expect(end.details.stderr.trim()).toBe("oops");
  });

  it("caps captured output at outputTailBytes", async () => {
    const events = await drain(
      shellExecutor.run(shellStep({ shellForm: true, cmd: "for i in $(seq 1 500); do echo abcdefghij; done" }), ctx({ outputTailBytes: 100 })),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.details.output.length).toBeLessThanOrEqual(100);
    expect(end.details.output.endsWith("abcdefghij\n")).toBe(true);
  });

  it("kills the process group on abort", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const events = await drain(
      shellExecutor.run(
        shellStep({ shellForm: true, cmd: "sleep 30" }),
        ctx({ signal: controller.signal, abortGraceMs: 50 }),
      ),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(false);
    expect(end.details.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports a spawn failure instead of hanging", async () => {
    const events = await drain(
      shellExecutor.run(shellStep({ shellForm: false, cmd: "/definitely/not/here", args: [] }), ctx()),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(false);
    expect(String(end.details.error)).toMatch(/ENOENT|not/);
  });
});

describe("llm executor argument building", () => {
  it("turns skill + args into a slash command", () => {
    expect(buildPrompt({ skill: "code-review", args: "src/" })).toBe("/skill:code-review src/");
    expect(buildPrompt({ skill: "code-review" })).toBe("/skill:code-review");
    expect(buildPrompt({ command: "dual-finalcheck" })).toBe("/dual-finalcheck");
    expect(buildPrompt({ command: "dual-finalcheck", args: "--base develop" })).toBe("/dual-finalcheck --base develop");
    expect(buildPrompt({ prompt: "hello" })).toBe("hello");
    expect(buildPrompt({ prompt: "hello", args: "world" })).toBe("hello\n\nworld");
  });

  it("folds `reasoning` sugar into the model spec", () => {
    expect(resolveModel({ model: "anthropic/x", reasoning: "high" })).toBe("anthropic/x:high");
    // Explicit :level wins over sugar.
    expect(resolveModel({ model: "anthropic/x:medium", reasoning: "high" })).toBe("anthropic/x:medium");
    expect(resolveModel({ reasoning: "high" })).toBeUndefined();
  });

  it("emits an --mode rpc arg set for interactive steps", () => {
    expect(buildRpcArgs({ prompt: "init", model: "anthropic/x", reasoning: "high" }, "pipeline-review")).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--name",
      "pipeline-review",
      "--model",
      "anthropic/x:high",
    ]);
  });

  it("emits the headless flag set", () => {
    expect(buildArgs({ prompt: "hi", model: "anthropic/x", tools: ["read", "bash"], appendSystemPrompt: "be brief" })).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "anthropic/x",
      "--tools",
      "read,bash",
      "--append-system-prompt",
      "be brief",
      "hi",
    ]);
  });
});

describe("foldLlmEvent", () => {
  it("accumulates usage, turns and final text from message_end", () => {
    const state = { usage: { input: 0, output: 0, cost: 0, turns: 0 }, finalText: "" };
    foldLlmEvent(state, {
      type: "message_end",
      message: {
        role: "assistant",
        model: "m",
        content: [{ type: "text", text: "first" }],
        usage: { input: 10, output: 2, cost: { total: 0.5 } },
      },
    });
    foldLlmEvent(state, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "second" }], usage: { input: 5, output: 1, cost: 0.25 } },
    });
    expect(state).toMatchObject({ finalText: "second", model: "m" });
    expect(state.usage).toEqual({ input: 15, output: 3, cost: 0.75, turns: 2 });
  });

  it("emits progress for tool completions", () => {
    const state = { usage: { input: 0, output: 0, cost: 0, turns: 0 }, finalText: "" };
    expect(foldLlmEvent(state, { type: "tool_execution_end", toolName: "bash", isError: false }).progress).toEqual({
      tool: "bash",
      isError: false,
    });
  });
});

describe("llm executor against a fake pi", () => {
  const llmStep = (config: any): Step & { config: any } =>
    ({ kind: "llm", id: "review", path: "root.review", config }) as any;

  it("splices child events, captures usage and final text", async () => {
    const events = await drain(
      llmExecutor.run(llmStep({ prompt: "hi" }), ctx({ piBin: FAKE_PI, pipelineEnv: { FAKE_PI_TEXT: "LGTM" } })),
    );
    const llmEvents = events.filter((e) => e.type === "llm_event");
    expect(llmEvents.length).toBeGreaterThanOrEqual(5);
    expect((llmEvents[0] as any).event.type).toBe("session");

    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(true);
    expect(end.details.output).toBe("LGTM");
    expect(end.details.turns).toBe(1);
    expect(end.details.model).toBe("fake/model-1");
    expect(end.details.usage).toEqual({ input: 100, output: 20, cost: 0.01, turns: 1 });
    expect(events.some((e) => e.type === "progress" && (e.data as any).tool === "bash")).toBe(true);
  });

  it("tolerates non-JSON stdout and forwards stderr as log events", async () => {
    const events = await drain(
      llmExecutor.run(llmStep({ prompt: "hi" }), ctx({ piBin: FAKE_PI, pipelineEnv: { FAKE_PI_GARBAGE: "1" } })),
    );
    expect(events.some((e) => e.type === "log" && e.stream === "stdout" && e.chunk.includes("not json"))).toBe(true);
    expect(events.some((e) => e.type === "log" && e.stream === "stderr" && e.chunk.includes("a warning"))).toBe(true);
    expect((events.find((e) => e.type === "step_end") as any).ok).toBe(true);
  });

  it("fails when the child exits non-zero", async () => {
    const events = await drain(
      llmExecutor.run(llmStep({ prompt: "hi" }), ctx({ piBin: FAKE_PI, pipelineEnv: { FAKE_PI_EXIT: "2" } })),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(false);
    expect(end.details.exitCode).toBe(2);
  });

  it("fails when the child reports a provider error despite exiting 0", async () => {
    const events = await drain(
      llmExecutor.run(llmStep({ prompt: "hi" }), ctx({ piBin: FAKE_PI, pipelineEnv: { FAKE_PI_ERROR: "1" } })),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.details.exitCode).toBe(0);
    expect(end.ok).toBe(false);
    expect(end.details.error).toBe("Connection error.");
  });

  it("fails when the child exits 0 without producing any assistant turns", async () => {
    const events = await drain(
      llmExecutor.run(llmStep({ prompt: "hi" }), ctx({ piBin: FAKE_PI, pipelineEnv: { FAKE_PI_NO_TURNS: "1" } })),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.details.exitCode).toBe(0);
    expect(end.details.turns).toBe(0);
    expect(end.ok).toBe(false);
    expect(String(end.details.error)).toMatch(/without producing any assistant turns/);
  });

  it("kills a hung child on abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const events = await drain(
      llmExecutor.run(
        llmStep({ prompt: "hi" }),
        ctx({ piBin: FAKE_PI, pipelineEnv: { FAKE_PI_HANG: "1" }, signal: controller.signal, abortGraceMs: 50 }),
      ),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(false);
    expect(end.details.aborted).toBe(true);
  });

  it("hashes appendSystemPrompt instead of logging it", async () => {
    const events = await drain(
      llmExecutor.run(llmStep({ prompt: "hi", appendSystemPrompt: "secret guidance" }), ctx({ piBin: FAKE_PI })),
    );
    const start = events.find((e) => e.type === "step_start") as any;
    expect(start.config.appendSystemPrompt).toMatch(/^sha256:[0-9a-f]{64}$/);
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.details.appendSystemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("errors when `mode: rpc` runs without a UI", async () => {
    const events = await drain(
      llmExecutor.run(
        { kind: "llm", id: "chat", path: "root.chat", config: { prompt: "hi", mode: "rpc" } } as any,
        ctx({ piBin: FAKE_PI }),
      ),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(false);
    expect(String(end.details.error)).toMatch(/no interactive UI/);
  });

  it("falls back to oneshot when configured", async () => {
    const events = await drain(
      llmExecutor.run(
        {
          kind: "llm",
          id: "chat",
          path: "root.chat",
          config: { prompt: "hi", mode: "rpc", nonInteractiveFallback: "oneshot" },
        } as any,
        ctx({ piBin: FAKE_PI }),
      ),
    );
    const end = events.find((e) => e.type === "step_end") as any;
    expect(end.ok).toBe(true);
    expect(end.details.output).toBe("done");
  });

  it("refuses to nest pipelines beyond the depth guard", async () => {
    const events = await drain(
      llmExecutor.run(llmStep({ prompt: "hi" }), ctx({ piBin: FAKE_PI, pipelineEnv: { X: "1" } })),
    );
    expect((events.find((e) => e.type === "step_end") as any).ok).toBe(true);

    process.env.PIPELINE_DEPTH = "2";
    try {
      const guarded = await drain(llmExecutor.run(llmStep({ prompt: "hi" }), ctx({ piBin: FAKE_PI })));
      const end = guarded.find((e) => e.type === "step_end") as any;
      expect(end.ok).toBe(false);
      expect(String(end.details.error)).toMatch(/refusing to nest/);
    } finally {
      delete process.env.PIPELINE_DEPTH;
    }
  });
});
