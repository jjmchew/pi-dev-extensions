/** `/pipeline:show <runId> [--json] [--runs-dir p]` — the run manifest. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRunsDir } from "../core/runsDir.ts";
import { fmtMs } from "../reporters/tui.ts";
import { parseArgs, say, type CmdCtx } from "./ctx.ts";

export function findRunDir(runsDir: string, runId: string): string | undefined {
  const direct = join(runsDir, runId);
  if (existsSync(direct)) return direct;
  // Allow a unique prefix.
  try {
    const matches = readdirSync(runsDir).filter((e) => e.startsWith(runId));
    if (matches.length === 1) return join(runsDir, matches[0]!);
  } catch {
    /* ignore */
  }
  return undefined;
}

export function readManifest(runDir: string): any | undefined {
  for (const file of ["run.json", "run.partial.json"]) {
    const p = join(runDir, file);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function formatManifest(m: any): string {
  const lines: string[] = [];
  lines.push(`${m.pipeline} · ${m.runId} · ${m.status}`);
  if (m.pipelineFile) lines.push(`  file:    ${m.pipelineFile}`);
  lines.push(`  cwd:     ${m.cwd}`);
  if (m.git?.branch) lines.push(`  git:     ${m.git.branch}@${String(m.git.commit ?? "").slice(0, 8)}${m.git.dirty ? " (dirty)" : ""}`);
  lines.push(`  started: ${m.startedAt}${m.endedAt ? `  ended: ${m.endedAt}` : "  (in progress)"}`);
  const t = m.totals ?? {};
  const st = t.steps ?? {};
  lines.push(
    `  totals:  ${st.ok ?? 0}/${st.total ?? 0} ok, ${st.failed ?? 0} failed, ${st.skipped ?? 0} skipped · ${fmtMs(
      t.durationMs ?? 0,
    )}${t.usage?.cost ? ` · $${t.usage.cost.toFixed(3)}` : ""}`,
  );
  lines.push("  steps:");
  for (const s of m.steps ?? []) {
    const glyph = s.skipped ? "↷" : s.ok ? "✓" : "✗";
    const extra =
      s.kind === "llm"
        ? `${s.turns ?? 0} turns${s.usage?.cost ? ` · $${s.usage.cost.toFixed(3)}` : ""}${s.model ? ` · ${s.model}` : ""}`
        : s.exitCode !== undefined
          ? `exit ${s.exitCode}`
          : "";
    lines.push(
      `    ${glyph} ${String(s.id).padEnd(14)} ${String(s.kind).padEnd(6)} ${fmtMs(s.durationMs ?? 0).padStart(7)}  ${extra}` +
        (s.error ? `  ${s.error}` : ""),
    );
    if (s.path) lines.push(`        ${s.path}`);
  }
  return lines.join("\n");
}

export async function showCommand(args: string, ctx: CmdCtx): Promise<void> {
  const { positional, flags } = parseArgs(args ?? "", ["json", "runs-dir"]);
  const runId = positional.trim().split(/\s+/)[0];
  if (!runId) {
    say(ctx, "usage: /pipeline:show <runId> [--json]", "warn");
    return;
  }
  const runsDir = resolveRunsDir({
    flag: typeof flags["runs-dir"] === "string" ? (flags["runs-dir"] as string) : undefined,
    cwd: ctx.cwd,
  });
  const runDir = findRunDir(runsDir, runId);
  const manifest = runDir ? readManifest(runDir) : undefined;
  if (!manifest) {
    say(ctx, `run "${runId}" not found under ${runsDir}`, "error");
    return;
  }
  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  say(ctx, `${formatManifest(manifest)}\n  dir:     ${runDir}`);
}
