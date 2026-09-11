/**
 * `/pipeline <name> [args] [--runs-dir <path>] [--timeout <ms>] [--json]`
 *
 * Runs entirely outside the agent loop — no LLM turn happens in the current
 * session; llm steps get their own sub-`pi` processes.
 *
 * In a UI session the command returns as soon as the run is scheduled, and
 * the completion summary is delivered later via `ctx.ui.notify`. This is
 * required because pi dispatches slash commands serially — if `/pipeline`
 * awaited the run to completion here, `/pipeline:chat` (the command you
 * need to drive an RPC step) would sit queued in the input buffer for the
 * entire duration of the run. In headless (`--json` or no UI) mode we
 * keep the blocking behaviour so the CLI caller still gets the summary
 * before the process exits.
 */
import { randomUUID } from "node:crypto";

import { registerActiveRun, unregisterActiveRun } from "../core/active-runs.ts";
import { executeRun, type ExecuteResult } from "../core/execute.ts";
import { TuiReporter, fmtMs, statusGlyph } from "../reporters/tui.ts";
import type { Plan, Reporter } from "../core/types.ts";
import { parseArgs, say, type CmdCtx } from "./ctx.ts";

export const RUN_FLAGS = ["runs-dir", "timeout", "json"];

export async function runCommand(argsInput: string, ctx: CmdCtx): Promise<void> {
  const { positional, flags } = parseArgs(argsInput ?? "", RUN_FLAGS);
  const [name, ...rest] = positional.split(/\s+/).filter(Boolean);
  if (!name) {
    say(ctx, "usage: /pipeline <name> [args] [--runs-dir <path>] [--timeout <ms>] [--json]", "warn");
    return;
  }

  const pipelineArgs = rest.join(" ") || undefined;
  const timeoutMs = typeof flags.timeout === "string" ? Number(flags.timeout) : undefined;
  const useTui = Boolean(ctx.hasUI && ctx.ui?.setWidget);
  const json = flags.json === true || !ctx.hasUI;

  const reporters: Reporter[] = [];
  let tui: TuiReporter | undefined;

  // ctx.signal is scoped to the current command turn; in detached mode it
  // may abort as soon as this handler returns and kill the run. We route
  // through a private controller so session_shutdown / future cancel can
  // stop it explicitly.
  const controller = new AbortController();
  const forwardHostSignal = () => controller.abort(new Error("host signal"));

  const key = randomUUID();

  const summarize = (result: ExecuteResult): { text: string; level: "success" | "warn" | "error" } => {
    const st = result.totals.steps;
    const text =
      `${statusGlyph(result.status)} pipeline ${result.plan.name}: ${result.status} — ` +
      `${st.ok}/${st.total} ok` +
      (st.failed ? `, ${st.failed} failed` : "") +
      (st.skipped ? `, ${st.skipped} skipped` : "") +
      ` in ${fmtMs(result.totals.durationMs)}` +
      (result.totals.usage?.cost ? ` · $${result.totals.usage.cost.toFixed(3)}` : "") +
      (result.runDir ? `\n  ${result.runId} · /pipeline:show ${result.runId}` : "");
    const level = result.status === "ok" ? "success" : result.status === "partial" ? "warn" : "error";
    return { text, level };
  };

  let plan: Plan | undefined;
  const runPromise = executeRun({
    name,
    cwd: ctx.cwd,
    args: pipelineArgs,
    runsDirFlag: typeof flags["runs-dir"] === "string" ? (flags["runs-dir"] as string) : undefined,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
    signal: controller.signal,
    invoker: {
      kind: "command",
      user: process.env.USER,
      sessionId: ctx.sessionManager?.getSessionFile?.(),
    },
    json,
    hasUI: Boolean(ctx.hasUI),
    reporters,
    onPlan: (p) => {
      plan = p;
      if (!useTui) return;
      tui = new TuiReporter({ setWidget: (id, lines) => ctx.ui.setWidget?.(id, lines) }, p);
      reporters.push(tui);
    },
  });

  // `onPlan` fires synchronously inside executeRun before its first await
  // (see core/execute.ts), so `plan` is populated by now. Detach only when
  // the plan has an interactive RPC step — those are the runs that must
  // not block the slash-command queue, since /pipeline:chat is the only
  // way to drive them.
  const interactiveIds = plan ? findInteractiveStepIds(plan) : [];
  const detached = Boolean(ctx.hasUI) && !json && interactiveIds.length > 0;

  // In blocking mode we forward host aborts to our controller so ctx.signal
  // still cancels the run. In detached mode we deliberately do NOT forward,
  // so the command handler returning (and any turn-scoped signal aborting)
  // won't kill the still-running pipeline.
  if (!detached) ctx.signal?.addEventListener?.("abort", forwardHostSignal);

  const settled = runPromise
    .then((result) => {
      const { text, level } = summarize(result);
      say(ctx, text, level);
      return result;
    })
    .catch((err: unknown) => {
      tui?.clear();
      say(ctx, `pipeline failed to start: ${(err as Error).message}`, "error");
    })
    .finally(() => {
      unregisterActiveRun(key);
      ctx.signal?.removeEventListener?.("abort", forwardHostSignal);
    });

  registerActiveRun({
    key,
    name,
    startedAt: Date.now(),
    abort: (reason) => controller.abort(reason ? new Error(reason) : undefined),
    promise: settled,
  });

  if (!detached) {
    await settled;
    return;
  }

  // Fire-and-forget: leave a breadcrumb so the user knows the run is live
  // and how to reach any RPC step from the main prompt.
  const hint =
    interactiveIds.length === 1
      ? ` · interactive: /pipeline:chat ${interactiveIds[0]}`
      : ` · interactive: /pipeline:chat <${interactiveIds.join("|")}>`;
  say(ctx, `▸ pipeline ${name} started${hint}`, "info");
}

function findInteractiveStepIds(plan: Plan): string[] {
  const out: string[] = [];
  const walk = (node: Plan["root"]): void => {
    if (node.kind === "step") {
      const cfg = node.step.config as { mode?: string } | undefined;
      if (node.step.kind === "llm" && cfg?.mode === "rpc") out.push(node.step.id);
      return;
    }
    if (node.kind === "loop") {
      walk(node.loop.body);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(plan.root);
  return out;
}
