/**
 * `shell:` executor.
 *
 *   string form  →  /bin/sh -c "<cmd>"   (pipes, globs, redirection work)
 *   object form  →  exec cmd with argv   (no shell involved)
 *
 * Completion signal is child exit; `ok = exitCode === 0 && !aborted`.
 */
import { EventQueue } from "../core/queue.ts";
import { resolveStepCwd } from "../core/resolve.ts";
import { mergeEnv } from "../core/resolve.ts";
import { DEFAULTS } from "../core/settings.ts";
import type { ShellStepConfig, Step, StepContext, StepEvent, StepExecutor } from "../core/types.ts";
import { LineSplitter, runChild, Tail } from "./spawn.ts";

export const shellExecutor: StepExecutor<ShellStepConfig> = {
  kind: "shell",
  resultFields: ["exitCode", "output", "stderr"],

  validate(cfg) {
    if (!cfg || typeof (cfg as any).cmd !== "string" || !(cfg as any).cmd.trim()) {
      throw new Error("shell step requires a non-empty `cmd`");
    }
  },

  run(step: Step & { config: ShellStepConfig }, ctx: StepContext): AsyncIterable<StepEvent> {
    const queue = new EventQueue<StepEvent>();
    const cfg = step.config;
    const cwd = resolveStepCwd(step, ctx);
    const env = mergeEnv(process.env as Record<string, string>, ctx.pipelineEnv, step.env, cfg.env);
    const tailBytes = ctx.outputTailBytes ?? DEFAULTS.outputTailBytes;

    const command = cfg.shellForm ? "/bin/sh" : cfg.cmd;
    const args = cfg.shellForm ? ["-c", cfg.cmd] : ((cfg as any).args ?? []);

    queue.push({ type: "step_start", stepId: step.id, kind: "shell", cwd, config: cfg });

    const startedAt = Date.now();
    const outTail = new Tail(tailBytes);
    const errTail = new Tail(tailBytes);

    // Emit log events line-wise so consumers get tidy chunks, but keep the
    // raw bytes for the tails.
    const stdoutLines = new LineSplitter((line) =>
      queue.push({ type: "log", stepId: step.id, stream: "stdout", chunk: `${line}\n` }),
    );
    const stderrLines = new LineSplitter((line) =>
      queue.push({ type: "log", stepId: step.id, stream: "stderr", chunk: `${line}\n` }),
    );

    void runChild(command, args, {
      cwd,
      env,
      signal: ctx.signal,
      abortGraceMs: ctx.abortGraceMs ?? DEFAULTS.abortGraceMs,
      onStdout: (chunk) => {
        outTail.push(chunk);
        stdoutLines.push(chunk);
      },
      onStderr: (chunk) => {
        errTail.push(chunk);
        stderrLines.push(chunk);
      },
    }).then((res) => {
      stdoutLines.flush();
      stderrLines.flush();
      if (res.spawnError) {
        queue.push({ type: "log", stepId: step.id, stream: "stderr", chunk: `${res.spawnError}\n` });
        errTail.push(`${res.spawnError}\n`);
      }
      queue.push({
        type: "step_end",
        stepId: step.id,
        ok: res.exitCode === 0 && !res.aborted && !res.spawnError,
        details: {
          exitCode: res.exitCode,
          durationMs: Date.now() - startedAt,
          aborted: res.aborted || undefined,
          signal: res.signalName,
          output: outTail.value,
          stderr: errTail.value,
          error: res.spawnError,
        },
      });
      queue.close();
    });

    return queue.drain();
  },
};
