/**
 * `/pipeline:trace <runId> <stepId> [--raw]` — replay an llm step's trace.
 *
 * Day one this is a plain text render of the child's event stream; a richer
 * TUI replay is a follow-up.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunsDir } from "../core/runsDir.ts";
import { parseArgs, say, type CmdCtx } from "./ctx.ts";
import { findRunDir } from "./show.ts";

export function renderTrace(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    switch (evt.type) {
      case "message_end": {
        const msg = evt.message;
        if (!msg || msg.role !== "assistant") break;
        for (const part of msg.content ?? []) {
          if (part?.type === "text" && part.text?.trim()) out.push(`assistant: ${part.text.trim()}`);
          if (part?.type === "toolCall") out.push(`  → ${part.name}(${preview(part.arguments)})`);
        }
        if (msg.usage) {
          out.push(
            `  [usage ↑${msg.usage.input ?? 0} ↓${msg.usage.output ?? 0}` +
              (msg.usage.cost?.total ? ` $${Number(msg.usage.cost.total).toFixed(4)}` : "") +
              `]`,
          );
        }
        break;
      }
      case "tool_execution_end":
        out.push(`  ← ${evt.toolName}${evt.isError ? " (error)" : ""}: ${preview(evt.result)}`);
        break;
      default:
        break;
    }
  }
  return out.join("\n");
}

function preview(v: unknown, max = 160): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function traceCommand(args: string, ctx: CmdCtx): Promise<void> {
  const { positional, flags } = parseArgs(args ?? "", ["raw", "runs-dir"]);
  const [runId, stepId] = positional.trim().split(/\s+/);
  if (!runId || !stepId) {
    say(ctx, "usage: /pipeline:trace <runId> <stepId> [--raw]", "warn");
    return;
  }
  const runsDir = resolveRunsDir({
    flag: typeof flags["runs-dir"] === "string" ? (flags["runs-dir"] as string) : undefined,
    cwd: ctx.cwd,
  });
  const runDir = findRunDir(runsDir, runId);
  const file = runDir ? join(runDir, "steps", stepId, "trace.jsonl") : undefined;
  if (!file || !existsSync(file)) {
    say(ctx, `no trace for step "${stepId}" in run "${runId}" (llm steps only)`, "error");
    return;
  }
  const lines = readFileSync(file, "utf8").split("\n");
  say(ctx, flags.raw === true ? lines.join("\n") : renderTrace(lines) || "(empty trace)");
}
