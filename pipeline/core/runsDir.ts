/**
 * Run directory resolution, ULID run ids, and the append-with-lock helper
 * used for `index.jsonl`.
 *
 * Override order (first wins):
 *   1. invocation flag (`--runs-dir`)
 *   2. pipeline YAML `runsDir:`
 *   3. settings `pipeline.runsDir`
 *   4. ~/.pi/pipelines/runs/
 */
import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { pipelineSettings } from "./settings.ts";

export function defaultRunsDir(): string {
  return join(homedir(), ".pi", "pipelines", "runs");
}

export function resolveRunsDir(opts: {
  flag?: string;
  planRunsDir?: string;
  cwd: string;
}): string {
  const pick = opts.flag ?? opts.planRunsDir ?? pipelineSettings().runsDir;
  if (!pick) return defaultRunsDir();
  const expanded = pick.startsWith("~/") ? join(process.env.HOME ?? "", pick.slice(2)) : pick;
  return isAbsolute(expanded) ? expanded : resolve(opts.cwd, expanded);
}

// ─── ULID ─────────────────────────────────────────────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Monotonic-enough ULID: 48-bit timestamp + 80 bits of randomness. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}

export function runDirFor(runsDir: string, runId: string): string {
  return join(runsDir, runId);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

// ─── index.jsonl append with advisory lock ────────────────────────────────

/**
 * Appends one line to `index.jsonl`. Concurrency safety comes from an
 * O_APPEND write (atomic for small lines on local filesystems) plus a
 * best-effort lock directory so two runs never interleave a partial line.
 * Note: `runsDir` should live on a local filesystem.
 */
export function appendIndexLine(runsDir: string, obj: unknown): void {
  ensureDir(runsDir);
  const line = `${JSON.stringify(obj)}\n`;
  const lockDir = join(runsDir, ".index.lock");
  let held = false;
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lockDir);
      held = true;
      break;
    } catch {
      sleepSync(10);
    }
  }
  try {
    const fd = openSync(join(runsDir, "index.jsonl"), "a");
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } finally {
    if (held) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}
