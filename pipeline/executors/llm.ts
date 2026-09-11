/**
 * `llm:` executor — runs one isolated agent turn in a sub-`pi` process.
 *
 *   pi --mode json -p --no-session [--model X] [--tools a,b]
 *      [--append-system-prompt <text>] "<prompt>"
 *
 * The child's newline-delimited JSON is spliced into the parent event stream
 * verbatim as `llm_event` (the TraceReporter writes those to trace.jsonl),
 * with `progress` on tool completion and usage/final text accumulated from
 * `message_end`. Completion signal is child exit.
 */
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chatKey,
  registerChat,
  unregisterChat,
  type ChatHandle,
  type ChatState,
  type FinalizeMode,
  type TranscriptEntry,
} from "../core/interactive-registry.ts";
import { EventQueue } from "../core/queue.ts";
import { mergeEnv, resolveStepCwd } from "../core/resolve.ts";
import { DEFAULTS, pipelineSettings } from "../core/settings.ts";
import type { LlmStepConfig, LlmUsage, Step, StepContext, StepEvent, StepExecutor } from "../core/types.ts";
import { LineSplitter, runChild, spawnChild, Tail } from "./spawn.ts";

/** Recursion guard: an llm step can itself run pipelines. Depth 2 is plenty. */
export const MAX_PIPELINE_DEPTH = 2;

export function getPiInvocation(args: string[], piBin?: string): { command: string; args: string[] } {
  if (piBin) return { command: piBin, args };
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

export function buildPrompt(cfg: LlmStepConfig): string {
  // Skills are invoked via pi's `/skill:<name>` command form (see
  // docs/skills.md); extension-registered slash commands are bare `/<name>`.
  if (cfg.skill) return `/skill:${cfg.skill}${cfg.args ? ` ${cfg.args}` : ""}`;
  if (cfg.command) return `/${cfg.command}${cfg.args ? ` ${cfg.args}` : ""}`;
  return cfg.args ? `${cfg.prompt}\n\n${cfg.args}` : cfg.prompt!;
}

/** Fold `reasoning` sugar into the model spec (`provider/id:thinking`). */
export function resolveModel(cfg: LlmStepConfig): string | undefined {
  if (!cfg.model) return undefined;
  if (!cfg.reasoning) return cfg.model;
  // Never double-append a level the user already spelled out.
  return cfg.model.includes(":") ? cfg.model : `${cfg.model}:${cfg.reasoning}`;
}

export function buildArgs(cfg: LlmStepConfig): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  const model = resolveModel(cfg);
  if (model) args.push("--model", model);
  if (cfg.tools?.length) args.push("--tools", cfg.tools.join(","));
  // --append-system-prompt takes text or a file path; we spawn without a
  // shell, so the text can be passed straight through (no temp file).
  if (cfg.appendSystemPrompt) args.push("--append-system-prompt", cfg.appendSystemPrompt);
  args.push(buildPrompt(cfg));
  return args;
}

export function buildRpcArgs(cfg: LlmStepConfig, name: string): string[] {
  const args = ["--mode", "rpc", "--no-session", "--name", name];
  const model = resolveModel(cfg);
  if (model) args.push("--model", model);
  if (cfg.tools?.length) args.push("--tools", cfg.tools.join(","));
  if (cfg.appendSystemPrompt) args.push("--append-system-prompt", cfg.appendSystemPrompt);
  return args;
}

type LlmState = {
  usage: LlmUsage;
  finalText: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

/** Folds one sub-pi event into the accumulated step state. */
export function foldLlmEvent(state: LlmState, event: any): { progress?: unknown } {
  if (!event || typeof event !== "object") return {};
  if (event.type === "message_end") {
    const msg = event.message;
    if (!msg || msg.role !== "assistant") return {};
    state.usage.turns += 1;
    if (typeof msg.model === "string") state.model = msg.model;
    if (typeof msg.stopReason === "string") state.stopReason = msg.stopReason;
    // Last message wins, so a successful retry clears an earlier error.
    state.errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : undefined;
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const texts: string[] = [];
    for (const part of parts) {
      if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    const combined = texts.join("\n").trim();
    if (combined) state.finalText = combined;
    const u = msg.usage;
    if (u && typeof u === "object") {
      state.usage.input += Number(u.input) || 0;
      state.usage.output += Number(u.output) || 0;
      state.usage.cost += Number(u.cost?.total ?? u.cost) || 0;
    }
    return { progress: { turns: state.usage.turns, cost: state.usage.cost } };
  }
  if (event.type === "tool_execution_end") {
    return { progress: { tool: event.toolName, isError: Boolean(event.isError) } };
  }
  return {};
}

export const llmExecutor: StepExecutor<LlmStepConfig> = {
  kind: "llm",
  resultFields: ["output", "usage", "turns", "model"],

  validate(cfg) {
    const modes = [Boolean(cfg?.skill), Boolean(cfg?.command), Boolean(cfg?.prompt)].filter(Boolean).length;
    if (modes !== 1) {
      throw new Error("llm step requires exactly one of `skill`, `command`, `prompt`, or `promptFile`");
    }
    if (cfg?.mode && cfg.mode !== "oneshot" && cfg.mode !== "rpc") {
      throw new Error(`llm.mode must be "oneshot" or "rpc" (got "${cfg.mode}")`);
    }
  },

  run(step: Step & { config: LlmStepConfig }, ctx: StepContext): AsyncIterable<StepEvent> {
    const queue = new EventQueue<StepEvent>();
    const cfg = step.config;
    const cwd = resolveStepCwd(step, ctx);
    const tailBytes = ctx.outputTailBytes ?? DEFAULTS.outputTailBytes;

    const depth = Number(process.env.PIPELINE_DEPTH ?? "0") || 0;
    const env = mergeEnv(process.env as Record<string, string>, ctx.pipelineEnv, step.env, {
      PIPELINE_DEPTH: String(depth + 1),
    });

    const appendSystemPromptSha256 = cfg.appendSystemPrompt
      ? createHash("sha256").update(cfg.appendSystemPrompt).digest("hex")
      : undefined;

    queue.push({
      type: "step_start",
      stepId: step.id,
      kind: "llm",
      cwd,
      config: {
        ...cfg,
        appendSystemPrompt: appendSystemPromptSha256 ? `sha256:${appendSystemPromptSha256}` : undefined,
        // Don't inline the whole file body; sha lives in step_end details too.
        prompt: cfg.promptFileSha256 ? `promptFile:sha256:${cfg.promptFileSha256}` : cfg.prompt,
      },
    });

    // `mode: rpc` needs a UI to be driveable. Honor the fallback opt-in.
    const wantsInteractive = cfg.mode === "rpc";
    if (wantsInteractive && !ctx.hasUI) {
      const fallback = cfg.nonInteractiveFallback ?? "error";
      if (fallback === "error") {
        queue.push({
          type: "step_end",
          stepId: step.id,
          ok: false,
          details: {
            error:
              `llm step "${step.id}" has \`mode: rpc\` but no interactive UI is attached — ` +
              "set `nonInteractiveFallback: oneshot` to allow degrading, or run this pipeline from /pipeline in a TUI/RPC session",
            durationMs: 0,
          },
        });
        queue.close();
        return queue.drain();
      }
      // Fall through to oneshot; the executor treats the step as non-interactive.
    }

    if (depth >= MAX_PIPELINE_DEPTH) {
      queue.push({
        type: "step_end",
        stepId: step.id,
        ok: false,
        details: {
          error: `refusing to nest pipelines deeper than ${MAX_PIPELINE_DEPTH} (PIPELINE_DEPTH=${depth})`,
          durationMs: 0,
        },
      });
      queue.close();
      return queue.drain();
    }

    if (wantsInteractive && ctx.hasUI) {
      runInteractive(step, cfg, ctx, queue, {
        cwd,
        env,
        tailBytes,
        appendSystemPromptSha256,
      });
      return queue.drain();
    }

    const args = buildArgs(cfg);
    const invocation = getPiInvocation(args, ctx.piBin ?? pipelineSettings().piBin);

    const state: LlmState = {
      usage: { input: 0, output: 0, cost: 0, turns: 0 },
      finalText: "",
    };
    const startedAt = Date.now();
    const stderrTail = new Tail(tailBytes);

    const stdoutLines = new LineSplitter((line) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // Non-JSON on stdout (banner, warning) is still worth keeping.
        queue.push({ type: "log", stepId: step.id, stream: "stdout", chunk: `${line}\n` });
        return;
      }
      queue.push({ type: "llm_event", stepId: step.id, event });
      const { progress } = foldLlmEvent(state, event);
      if (progress) queue.push({ type: "progress", stepId: step.id, data: progress });
    });

    const stderrLines = new LineSplitter((line) =>
      queue.push({ type: "log", stepId: step.id, stream: "stderr", chunk: `${line}\n` }),
    );

    void runChild(invocation.command, invocation.args, {
      cwd,
      env,
      signal: ctx.signal,
      abortGraceMs: ctx.abortGraceMs ?? DEFAULTS.abortGraceMs,
      onStdout: (chunk) => stdoutLines.push(chunk),
      onStderr: (chunk) => {
        stderrTail.push(chunk);
        stderrLines.push(chunk);
      },
    }).then((res) => {
      stdoutLines.flush();
      stderrLines.flush();
      // Exit code is the primary completion signal, but a sub-pi that hit a
      // provider error still exits 0 with an empty answer — that is a failed
      // step, not a successful one. A clean exit with zero assistant turns
      // means the child never actually produced a message (e.g. an
      // unrecognized `/slash` prompt was consumed silently). Treat that as a
      // failure so the pipeline doesn't succeed silently.
      const noTurns = state.usage.turns === 0;
      const zeroTurnError = noTurns
        ? "sub-pi exited without producing any assistant turns (prompt was likely handled as a no-op slash command; use `prompt:` with an explicit instruction, or verify the skill/command name)"
        : undefined;
      const ok =
        res.exitCode === 0 &&
        !res.aborted &&
        !res.spawnError &&
        !state.errorMessage &&
        !noTurns;
      queue.push({
        type: "step_end",
        stepId: step.id,
        ok,
        details: {
          durationMs: Date.now() - startedAt,
          exitCode: res.exitCode,
          aborted: res.aborted || undefined,
          usage: state.usage,
          turns: state.usage.turns,
          model: state.model ?? cfg.model,
          output: state.finalText,
          stderr: stderrTail.value || undefined,
          stopReason: state.stopReason,
          error: res.spawnError ?? state.errorMessage ?? zeroTurnError,
          appendSystemPromptSha256,
        },
      });
      queue.close();
    });

    return queue.drain();
  },
};

// ─── interactive (mode: rpc) ────────────────────────────────────────────

type InteractiveEnv = {
  cwd: string;
  env: Record<string, string>;
  tailBytes: number;
  appendSystemPromptSha256?: string;
};

/**
 * Spawn `pi --mode rpc`, register a `ChatHandle` so a chat pane can drive
 * the sub-pi, and block the step until `finalize()` resolves. Child exit
 * alone is not enough — the user might still be reading the transcript.
 */
function runInteractive(
  step: Step & { config: LlmStepConfig },
  cfg: LlmStepConfig,
  ctx: StepContext,
  queue: EventQueue<StepEvent>,
  ienv: InteractiveEnv,
): void {
  const startedAt = Date.now();
  const state: LlmState = {
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    finalText: "",
  };
  const stderrTail = new Tail(ienv.tailBytes);
  const emitter = new EventEmitter();
  const transcript: TranscriptEntry[] = [];

  const rpcArgs = buildRpcArgs(cfg, `pipeline-${step.id}`);
  const invocation = getPiInvocation(rpcArgs, ctx.piBin ?? pipelineSettings().piBin);

  let currentState: ChatState = "idle";
  let handle: ChatHandle | undefined;
  const setState = (next: ChatState) => {
    if (currentState === next) return;
    currentState = next;
    if (handle) handle.state = next;
    emitter.emit("state", next);
  };

  const stdoutLines = new LineSplitter((line) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      queue.push({ type: "log", stepId: step.id, stream: "stdout", chunk: `${line}\n` });
      return;
    }
    // Filter RPC-envelope responses out of the trace stream; they're plumbing.
    if (event?.type !== "response" && event?.type !== "extension_ui_request") {
      queue.push({ type: "llm_event", stepId: step.id, event });
      const { progress } = foldLlmEvent(state, event);
      if (progress) queue.push({ type: "progress", stepId: step.id, data: progress });
    }
    if (event?.type === "agent_start") setState("streaming");
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const parts = Array.isArray(event.message.content) ? event.message.content : [];
      const text = parts
        .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim();
      if (text) {
        transcript.push({ role: "assistant", text, at: Date.now() });
        emitter.emit("message", transcript[transcript.length - 1]);
      }
    }
    if (event?.type === "agent_settled") {
      if (currentState !== "finalizing") setState("awaiting-input");
    }
  });

  const stderrLines = new LineSplitter((line) =>
    queue.push({ type: "log", stepId: step.id, stream: "stderr", chunk: `${line}\n` }),
  );

  const child = spawnChild(invocation.command, invocation.args, {
    cwd: ienv.cwd,
    env: ienv.env,
    signal: ctx.signal,
    abortGraceMs: ctx.abortGraceMs ?? DEFAULTS.abortGraceMs,
    stdin: "pipe",
    onStdout: (chunk) => stdoutLines.push(chunk),
    onStderr: (chunk) => {
      stderrTail.push(chunk);
      stderrLines.push(chunk);
    },
  });

  const writeFrame = (frame: Record<string, unknown>): boolean => {
    return child.write(`${JSON.stringify(frame)}\n`);
  };

  const initialPrompt = buildPrompt(cfg);
  transcript.push({ role: "system", text: `init prompt: ${initialPrompt.slice(0, 200)}`, at: startedAt });
  writeFrame({ id: randomUUID(), type: "prompt", message: initialPrompt });
  setState("streaming");

  let finalizePromise: Promise<string> | undefined;
  let resolveFinalize: ((text: string) => void) | undefined;
  let finalizeMode: FinalizeMode = "explicit";

  handle = {
    runId: ctx.runId,
    stepId: step.id,
    key: chatKey(ctx.runId, step.id),
    state: currentState,
    transcript,
    startedAt,
    send(msg: string): boolean {
      const text = msg.trim();
      if (!text) return false;
      transcript.push({ role: "user", text, at: Date.now() });
      emitter.emit("message", transcript[transcript.length - 1]);
      const frame: Record<string, unknown> = { id: randomUUID(), type: "prompt", message: text };
      if (currentState === "streaming") frame.streamingBehavior = "steer";
      const ok = writeFrame(frame);
      if (ok) setState("streaming");
      return ok;
    },
    finalize(mode: FinalizeMode): Promise<string> {
      if (finalizePromise) return finalizePromise;
      finalizeMode = mode;
      setState("finalizing");
      finalizePromise = new Promise<string>((res) => {
        resolveFinalize = res;
      });
      if (mode === "post-hoc") {
        // Use whatever assistant text is already on record.
        settle(state.finalText);
      } else {
        // Explicit finalize: caller has already sent the last message; wait
        // for the next assistant message_end to land, then close stdin.
        const last = transcript[transcript.length - 1];
        if (last?.role === "assistant") {
          settle(last.text);
        } else {
          const listener = (entry: TranscriptEntry) => {
            if (entry.role !== "assistant") return;
            emitter.off("message", listener as any);
            settle(entry.text);
          };
          emitter.on("message", listener as any);
        }
      }
      return finalizePromise;
    },
    abort(reason?: string) {
      transcript.push({ role: "system", text: `aborted${reason ? `: ${reason}` : ""}`, at: Date.now() });
      child.kill("SIGTERM");
      settle(state.finalText);
    },
    on(event, cb) {
      emitter.on(event, cb);
      return () => emitter.off(event, cb);
    },
  };

  let settled = false;
  function settle(text: string): void {
    if (settled) return;
    settled = true;
    handle!.final = text;
    // Best-effort clean shutdown; the child may already be gone.
    try {
      writeFrame({ id: randomUUID(), type: "abort" });
    } catch {
      /* ignore */
    }
    child.closeStdin();
    resolveFinalize?.(text);
  }

  registerChat(handle!);


  void child.result.then((res) => {
    stdoutLines.flush();
    stderrLines.flush();
    // If the child died before finalize, resolve with whatever we have so
    // the step can end (marked failed if the child exited badly).
    if (!settled) settle(state.finalText);
    setState("done");
    unregisterChat(handle!.key);

    const noTurns = state.usage.turns === 0;
    const ok =
      !res.aborted &&
      !res.spawnError &&
      !state.errorMessage &&
      !noTurns &&
      (res.exitCode === 0 || finalizeMode !== undefined);

    queue.push({
      type: "step_end",
      stepId: step.id,
      ok,
      details: {
        durationMs: Date.now() - startedAt,
        exitCode: res.exitCode,
        aborted: res.aborted || undefined,
        usage: state.usage,
        turns: state.usage.turns,
        model: state.model ?? resolveModel(cfg),
        output: handle!.final ?? state.finalText,
        stderr: stderrTail.value || undefined,
        stopReason: state.stopReason,
        error:
          res.spawnError ??
          state.errorMessage ??
          (noTurns
            ? "interactive sub-pi produced no assistant turns before finalize"
            : undefined),
        appendSystemPromptSha256: ienv.appendSystemPromptSha256,
        interactive: true,
        transcriptEntries: transcript.length,
      },
    });
    queue.close();
  });
}
