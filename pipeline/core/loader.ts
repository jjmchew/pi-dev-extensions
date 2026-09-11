/**
 * Pipeline discovery and loading.
 *
 * Search order (first hit wins, project shadows global):
 *   1. <cwd>/.pi/pipelines/<name>.<ext>
 *   2. <repoRoot>/.pi/pipelines/<name>.<ext>
 *   3. ~/.pi/pipelines/<name>.<ext>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getParser, listParserExts } from "./registry.ts";
import type { Plan } from "./types.ts";
import { validatePlan } from "./validate.ts";

export const PIPELINES_SUBDIR = join(".pi", "pipelines");

export type DiscoveredPipeline = {
  name: string;
  file: string;
  scope: "project" | "repo" | "global";
  /** Set when this entry is shadowed by a higher-priority file. */
  shadowedBy?: string;
};

export function repoRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function pipelineDirs(cwd: string): Array<{ dir: string; scope: DiscoveredPipeline["scope"] }> {
  const dirs: Array<{ dir: string; scope: DiscoveredPipeline["scope"] }> = [];
  const projectDir = join(cwd, PIPELINES_SUBDIR);
  dirs.push({ dir: projectDir, scope: "project" });

  const root = repoRoot(cwd);
  if (root) {
    const repoDir = join(root, PIPELINES_SUBDIR);
    if (repoDir !== projectDir) dirs.push({ dir: repoDir, scope: "repo" });
  }
  dirs.push({ dir: join(homedir(), PIPELINES_SUBDIR), scope: "global" });
  return dirs;
}

/** Every pipeline visible from `cwd`, in priority order, shadowing annotated. */
export function discoverPipelines(cwd: string): DiscoveredPipeline[] {
  const exts = listParserExts();
  const out: DiscoveredPipeline[] = [];
  const winners = new Map<string, string>();

  for (const { dir, scope } of pipelineDirs(cwd)) {
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const dot = entry.lastIndexOf(".");
      if (dot <= 0) continue;
      const ext = entry.slice(dot + 1);
      if (!exts.includes(ext)) continue;
      const name = entry.slice(0, dot);
      const file = join(dir, entry);
      const shadowedBy = winners.get(name);
      if (!shadowedBy) winners.set(name, file);
      out.push({ name, file, scope, shadowedBy });
    }
  }
  return out;
}

export function resolvePipelineFile(name: string, cwd: string): string | undefined {
  // An explicit path (contains a separator or an extension) is honored as-is.
  if (name.includes("/") || name.includes("\\")) {
    const p = resolve(cwd, name);
    return existsSync(p) ? p : undefined;
  }
  const exts = listParserExts();
  for (const { dir } of pipelineDirs(cwd)) {
    for (const ext of exts) {
      const p = join(dir, `${name}.${ext}`);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

export class PipelineNotFoundError extends Error {
  constructor(name: string, cwd: string) {
    super(
      `pipeline "${name}" not found. Looked in:\n` +
        pipelineDirs(cwd)
          .map((d) => `  ${d.dir}`)
          .join("\n"),
    );
    this.name = "PipelineNotFoundError";
  }
}

export function loadPipelineFile(file: string): Plan {
  const ext = file.slice(file.lastIndexOf(".") + 1);
  const parser = getParser(ext);
  if (!parser) {
    throw new Error(`pipeline: no parser registered for ".${ext}" (have: ${listParserExts().join(", ")})`);
  }
  const text = readFileSync(file, "utf8");
  const plan = parser.parse(text, file);
  validatePlan(plan);
  return plan;
}

export function loadPipeline(name: string, cwd: string): Plan {
  const file = resolvePipelineFile(name, cwd);
  if (!file) throw new PipelineNotFoundError(name, cwd);
  return loadPipelineFile(file);
}
