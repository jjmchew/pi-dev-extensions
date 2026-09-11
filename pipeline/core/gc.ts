/**
 * Retention GC for the runs directory.
 *
 * Runs on extension load, asynchronously, under an advisory lock directory so
 * concurrent pi processes don't fight. Runs that only have `run.partial.json`
 * (still in progress) are never touched.
 *
 * Policy (settings `pipeline.retention`): keepLast: 200, keepDays: 30,
 * keepFailures: forever.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, pipelineSettings } from "./settings.ts";

export type GcResult = { scanned: number; deleted: string[]; skipped: number };

export function gcRuns(runsDir: string, now = Date.now()): GcResult {
  const retention = { ...DEFAULTS.retention, ...(pipelineSettings().retention ?? {}) };
  const result: GcResult = { scanned: 0, deleted: [], skipped: 0 };

  const lockDir = join(runsDir, ".gc.lock");
  try {
    mkdirSync(lockDir);
  } catch {
    return result; // another process is collecting
  }

  try {
    let entries: string[];
    try {
      entries = readdirSync(runsDir);
    } catch {
      return result;
    }

    type Run = { id: string; dir: string; endedAt: number; status: string };
    const runs: Run[] = [];

    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "index.jsonl") continue;
      const dir = join(runsDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      result.scanned++;
      let manifest: any;
      try {
        manifest = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
      } catch {
        result.skipped++; // in-progress or unreadable — leave it alone
        continue;
      }
      runs.push({
        id: entry,
        dir,
        endedAt: Date.parse(manifest?.endedAt ?? manifest?.startedAt ?? "") || 0,
        status: String(manifest?.status ?? "unknown"),
      });
    }

    runs.sort((a, b) => b.endedAt - a.endedAt);

    const keepFailures = retention.keepFailures !== false;
    const keepLast = retention.keepLast ?? DEFAULTS.retention.keepLast;
    const keepDays = retention.keepDays ?? DEFAULTS.retention.keepDays;
    const cutoff = now - keepDays * 24 * 60 * 60 * 1000;

    runs.forEach((run, i) => {
      const isFailure = run.status === "failed" || run.status === "partial" || run.status === "aborted";
      if (keepFailures && isFailure) return;
      const tooOld = run.endedAt > 0 && run.endedAt < cutoff;
      const tooMany = i >= keepLast;
      if (!tooOld && !tooMany) return;
      try {
        rmSync(run.dir, { recursive: true, force: true });
        result.deleted.push(run.id);
      } catch {
        /* ignore */
      }
    });
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return result;
}
