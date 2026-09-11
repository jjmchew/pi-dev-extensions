/** `/pipeline:runs [--limit n] [--runs-dir p]` — recent runs from index.jsonl. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunsDir } from "../core/runsDir.ts";
import { fmtMs } from "../reporters/tui.ts";
import { parseArgs, say, type CmdCtx } from "./ctx.ts";

export type IndexEntry = {
  runId: string;
  pipeline: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  cost?: number;
  cwd?: string;
  runDir?: string;
};

export function readIndex(runsDir: string, limit = 20): IndexEntry[] {
  const file = join(runsDir, "index.jsonl");
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  const out: IndexEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip torn line */
    }
  }
  return out.reverse();
}

export async function runsCommand(args: string, ctx: CmdCtx): Promise<void> {
  const { flags } = parseArgs(args ?? "", ["limit", "runs-dir"]);
  const runsDir = resolveRunsDir({
    flag: typeof flags["runs-dir"] === "string" ? (flags["runs-dir"] as string) : undefined,
    cwd: ctx.cwd,
  });
  const limit = typeof flags.limit === "string" ? Number(flags.limit) || 20 : 20;
  const entries = readIndex(runsDir, limit);
  if (entries.length === 0) {
    say(ctx, `no runs recorded in ${runsDir}`, "warn");
    return;
  }
  const lines = entries.map((e) => {
    const when = e.endedAt ?? e.startedAt ?? "";
    return `  ${e.runId}  ${(e.pipeline ?? "").padEnd(16)} ${(e.status ?? "").padEnd(8)} ${fmtMs(
      e.durationMs ?? 0,
    ).padStart(7)}  ${e.cost ? `$${e.cost.toFixed(3)} ` : ""}${when}`;
  });
  say(ctx, `recent runs (${runsDir}):\n${lines.join("\n")}`);
}
