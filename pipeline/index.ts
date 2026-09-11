/**
 * pipeline — run YAML-defined scripts of shell commands and isolated LLM
 * turns, composed with `sequence:` / `parallel:`.
 *
 * This file is wiring only: it populates the registries and registers the
 * command + tool surfaces. All behaviour lives in core/, parsers/, executors/,
 * reporters/ and commands/.
 *
 * See README.md for the YAML reference and the on-disk run layout.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { chatCommand } from "./commands/chat.ts";
import { editCommand, newCommand } from "./commands/new.ts";
import { listCommand } from "./commands/list.ts";
import { runCommand } from "./commands/run.ts";
import { runsCommand } from "./commands/runs.ts";
import { showCommand } from "./commands/show.ts";
import { runPipelineTool } from "./commands/tool.ts";
import { traceCommand } from "./commands/trace.ts";
import { gcRuns } from "./core/gc.ts";
import { discoverPipelines } from "./core/loader.ts";
import { registerExecutor, registerParser } from "./core/registry.ts";
import { defaultRunsDir, resolveRunsDir } from "./core/runsDir.ts";
import { pipelineSettings } from "./core/settings.ts";
import { abortAllActiveRuns } from "./core/active-runs.ts";
import { installChatWidgets } from "./core/chat-widget.ts";
import { bindSetWidget, clearAll, clearPending } from "./core/widget-lifecycle.ts";
import { llmExecutor } from "./executors/llm.ts";
import { shellExecutor } from "./executors/shell.ts";
import { yamlParser, ymlParser } from "./parsers/yaml.ts";
import type { CmdCtx } from "./commands/ctx.ts";

export default function (pi: ExtensionAPI) {
  // ─── registries ─────────────────────────────────────────────────────────
  // Executors first: the YAML parser asks the registry which keys are step
  // kinds, so anything registered here becomes usable in pipeline files.
  registerExecutor(shellExecutor, { replace: true });
  registerExecutor(llmExecutor, { replace: true });
  registerParser(yamlParser, { replace: true });
  registerParser(ymlParser, { replace: true });

  const pipelineNameCompletions = (cwd: string) => (prefix: string) => {
    const seen = new Set<string>();
    const items = discoverPipelines(cwd)
      .filter((p) => !p.shadowedBy && !seen.has(p.name) && seen.add(p.name))
      .filter((p) => p.name.startsWith(prefix))
      .map((p) => ({ value: p.name, label: p.name, description: p.file }));
    return items.length > 0 ? items : null;
  };

  // ─── commands ───────────────────────────────────────────────────────────
  // Every command is registered under two aliases: the canonical
  // `pipeline[:sub]` form and the shorter `pl[:sub]` form (faster to type).
  const clearHandler = async (_args: string, ctx: unknown) => {
    // The lifecycle registry already has a bound setWidget from
    // session_start, but bind here too in case someone runs this before
    // session_start has fired (defensive; unlikely in practice).
    const anyCtx = ctx as CmdCtx;
    if (anyCtx.ui?.setWidget) bindSetWidget(anyCtx.ui.setWidget.bind(anyCtx.ui));
    const { cleared } = clearAll();
    if (cleared === 0 && anyCtx.ui?.notify) anyCtx.ui.notify("no pipeline widgets to clear", "info");
  };

  const nameCompletions = pipelineNameCompletions(process.cwd());
  const commandSpecs: Array<{
    sub?: string;
    description: string;
    handler: (args: string, ctx: unknown) => Promise<void>;
    completions?: typeof nameCompletions;
  }> = [
    {
      description: "Run a pipeline: /pl <name> [args] [--runs-dir p] [--timeout ms] [--json]",
      handler: (args, ctx) => runCommand(args, ctx as CmdCtx),
      completions: nameCompletions,
    },
    { sub: "list", description: "List discovered pipelines", handler: (args, ctx) => listCommand(args, ctx as CmdCtx) },
    { sub: "new", description: "Scaffold a new pipeline: /pl:new <name>", handler: (args, ctx) => newCommand(args, ctx as CmdCtx) },
    {
      sub: "edit",
      description: "Edit a pipeline: /pl:edit <name>",
      handler: (args, ctx) => editCommand(args, ctx as CmdCtx),
      completions: nameCompletions,
    },
    { sub: "chat", description: "Attach to an interactive llm step: /pl:chat [stepId]", handler: (args, ctx) => chatCommand(args, ctx as CmdCtx) },
    { sub: "runs", description: "List recent pipeline runs", handler: (args, ctx) => runsCommand(args, ctx as CmdCtx) },
    { sub: "show", description: "Show a run manifest: /pl:show <runId> [--json]", handler: (args, ctx) => showCommand(args, ctx as CmdCtx) },
    { sub: "trace", description: "Replay an llm step trace: /pl:trace <runId> <stepId> [--raw]", handler: (args, ctx) => traceCommand(args, ctx as CmdCtx) },
    { sub: "clear", description: "Dismiss any leftover pipeline widget from a completed run", handler: clearHandler },
  ];

  for (const spec of commandSpecs) {
    for (const root of ["pipeline", "pl"] as const) {
      const name = spec.sub ? `${root}:${spec.sub}` : root;
      pi.registerCommand(name, {
        description: spec.description,
        ...(spec.completions ? { getArgumentCompletions: spec.completions } : {}),
        handler: async (args, ctx) => spec.handler(args, ctx),
      });
    }
  }

  // ─── tool ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "run_pipeline",
    label: "Run pipeline",
    description:
      "Run a named pipeline defined in .pi/pipelines/. Pipelines compose shell commands and " +
      "isolated LLM turns with sequence/parallel blocks. Returns the run status, totals and run directory.",
    promptSnippet: "Run a predefined pipeline of shell + LLM steps by name",
    parameters: Type.Object({
      name: Type.String({ description: "Pipeline name as shown by /pipeline:list" }),
      args: Type.Optional(Type.String({ description: "Opaque argument string exposed to steps as ${args}" })),
      runsDir: Type.Optional(Type.String({ description: "Override where run logs are written" })),
      timeoutMs: Type.Optional(Type.Number({ description: "Run-level timeout in milliseconds" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const result = await runPipelineTool(params as any, {
        cwd: ctx.cwd,
        signal,
        onUpdate: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
      });
      const st = result.totals.steps;
      return {
        content: [
          {
            type: "text",
            text:
              `pipeline ${params.name}: ${result.status} — ${st.ok}/${st.total} ok, ` +
              `${st.failed} failed, ${st.skipped} skipped (run ${result.runId})` +
              (result.runDir ? `\nrun dir: ${result.runDir}` : ""),
          },
        ],
        details: result,
        isError: result.status === "failed" || result.status === "aborted",
      };
    },
  });

  // ─── widget lifecycle hooks ────────────────────────────────────────
  // TuiReporter marks its widget "pending clear" on run completion; these
  // hooks are what actually tears it down (see core/widget-lifecycle.ts).
  pi.on?.("session_start", (_event: unknown, ctx: any) => {
    if (ctx?.ui?.setWidget) bindSetWidget(ctx.ui.setWidget.bind(ctx.ui));
    // Auto chat widget: surfaces every RPC llm step (esp. `awaiting-input`)
    // without the user having to know about /pipeline:chat.
    installChatWidgets();
  });

  pi.on?.("input", (event: any, _ctx: any) => {
    // Only clear on real user input, not on messages we inject programmatically.
    if (event?.source === "extension") return;
    clearPending();
  });

  pi.on?.("session_shutdown", () => {
    // Abort any detached runs so their sub-pis don't outlive the session.
    abortAllActiveRuns("session shutdown");
    clearAll();
    bindSetWidget(undefined);
  });

  // ─── retention GC (async, never blocks startup) ─────────────────────────
  if (pipelineSettings().reporters?.file !== false) {
    setTimeout(() => {
      try {
        gcRuns(resolveRunsDir({ cwd: process.cwd() }) || defaultRunsDir());
      } catch {
        // GC is best-effort.
      }
    }, 2000).unref?.();
  }
}
