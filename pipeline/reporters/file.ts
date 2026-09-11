/**
 * FileReporter — the on-disk record of a run.
 *
 *   <runsDir>/<runId>/run.json            manifest (atomic write at run_end)
 *                     run.partial.json    written at run_start, deleted at end
 *                     plan.json           frozen, env-expanded Plan IR
 *                     events.jsonl        every StepEvent, in order
 *                     steps/<id>/step.json | stdout.log | stderr.log
 *                     artifacts/sha256/<hh>/<hash>, artifacts/refs/<name>.json
 *   <runsDir>/index.jsonl                 one line per run
 *
 * Writes are synchronous: they are small, and ordering guarantees are worth
 * more here than throughput.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterEnv, mergeCounts, Redactor, DEFAULT_ENV_ALLOWLIST } from "../core/redact.ts";
import { gitInfo } from "../core/resolve.ts";
import { appendIndexLine, ensureDir } from "../core/runsDir.ts";
import type {
  Env,
  Plan,
  Reporter,
  RunContext,
  RunStatus,
  RunTotals,
  StepEndDetails,
  StepEvent,
} from "../core/types.ts";

export const SCHEMA_VERSION = "pipeline.v1";

export type FileReporterOptions = {
  runsDir: string;
  runId: string;
  plan: Plan;
  cwd: string;
  env: Env;
  invoker?: { kind: string; user?: string; sessionId?: string; assistantMessageId?: string };
  redactor?: Redactor;
  envAllowlist?: string[];
};

type StepRecord = {
  id: string;
  kind: string;
  path?: string;
  cwd?: string;
  config?: unknown;
  startedAt?: string;
  endedAt?: string;
  ok?: boolean;
  skipped?: boolean;
  details?: StepEndDetails;
  redactions: Record<string, number>;
  artifacts: string[];
};

export class FileReporter implements Reporter {
  readonly runDir: string;
  private readonly eventsFile: string;
  private readonly redactor: Redactor;
  private readonly steps = new Map<string, StepRecord>();
  private startedAt = new Date().toISOString();

  constructor(private readonly opts: FileReporterOptions) {
    this.runDir = join(opts.runsDir, opts.runId);
    this.eventsFile = join(this.runDir, "events.jsonl");
    this.redactor = opts.redactor ?? new Redactor();
  }

  onRunStart(_ctx: RunContext, plan: Plan): void {
    ensureDir(join(this.runDir, "steps"));
    ensureDir(join(this.runDir, "artifacts", "refs"));
    this.startedAt = new Date().toISOString();
    writeFileSync(join(this.runDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(this.eventsFile, "");
    this.writeManifest("partial", { durationMs: 0, steps: { total: 0, ok: 0, failed: 0, skipped: 0 } }, true);
  }

  onEvent(evt: StepEvent, meta: { t: string; runId: string }): void {
    let line: unknown = { t: meta.t, ...evt };

    if (evt.type === "step_start") {
      // Merge, don't replace: attachPlanPaths() has already seeded `path`.
      const rec = this.stepRecord(evt.stepId, evt.kind);
      rec.kind = evt.kind;
      rec.cwd = evt.cwd;
      rec.config = evt.config;
      rec.startedAt = meta.t;
    }

    if (evt.type === "log") {
      const rec = this.stepRecord(evt.stepId, "unknown");
      const { text, counts } = this.redactor.redact(evt.chunk);
      mergeCounts(rec.redactions, counts);
      line = { t: meta.t, ...evt, chunk: text };
      const dir = join(this.runDir, "steps", safe(evt.stepId));
      ensureDir(dir);
      appendFileSync(join(dir, evt.stream === "stdout" ? "stdout.log" : "stderr.log"), text);
    }

    appendFileSync(this.eventsFile, `${JSON.stringify(line)}\n`);

    if (evt.type === "step_end") this.finishStep(evt, meta.t);
  }

  onRunEnd(_ctx: RunContext, status: RunStatus, totals: RunTotals): void {
    const manifest = this.writeManifest(status, totals, false);
    appendIndexLine(this.opts.runsDir, {
      runId: this.opts.runId,
      pipeline: this.opts.plan.name,
      status,
      startedAt: this.startedAt,
      endedAt: manifest.endedAt,
      durationMs: totals.durationMs,
      cost: totals.usage?.cost,
      cwd: this.opts.cwd,
      runDir: this.runDir,
    });
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private stepRecord(id: string, kind: string): StepRecord {
    let rec = this.steps.get(id);
    if (!rec) {
      rec = { id, kind, redactions: {}, artifacts: [] };
      this.steps.set(id, rec);
    }
    return rec;
  }

  private finishStep(evt: Extract<StepEvent, { type: "step_end" }>, t: string): void {
    const details = (evt.details ?? {}) as StepEndDetails;
    const rec = this.stepRecord(evt.stepId, "unknown");
    rec.ok = evt.ok;
    rec.endedAt = t;
    rec.skipped = details.skipped === true;
    rec.details = details;

    if (!rec.skipped) {
      if (typeof details.output === "string" && details.output.length > 0) {
        const name = rec.kind === "llm" ? "finalOutput" : "stdout.tail";
        rec.artifacts.push(this.writeArtifact(evt.stepId, name, details.output, "text/plain"));
      }
      if (typeof details.stderr === "string" && details.stderr.length > 0) {
        rec.artifacts.push(this.writeArtifact(evt.stepId, "stderr.tail", details.stderr, "text/plain"));
      }
      const outputVarName = (details as any).outputVarName as string | undefined;
      if (outputVarName && typeof details.output === "string" && details.output.length > 0) {
        rec.artifacts.push(this.writeArtifact(evt.stepId, outputVarName, details.output, "text/plain"));
      }
    }

    const dir = join(this.runDir, "steps", safe(evt.stepId));
    ensureDir(dir);
    writeFileSync(
      join(dir, "step.json"),
      `${JSON.stringify(
        {
          schema: SCHEMA_VERSION,
          id: rec.id,
          kind: rec.kind,
          path: rec.path,
          cwd: rec.cwd,
          config: rec.config,
          startedAt: rec.startedAt,
          endedAt: rec.endedAt,
          ok: rec.ok,
          skipped: rec.skipped,
          durationMs: details.durationMs,
          exitCode: details.exitCode,
          usage: details.usage,
          turns: details.turns,
          model: details.model,
          appendSystemPromptSha256: details.appendSystemPromptSha256,
          redactions: rec.redactions,
          artifacts: rec.artifacts,
          error: details.error,
        },
        null,
        2,
      )}\n`,
    );
  }

  /** Content-addressed blob + a named ref pointing at it. Returns the ref name. */
  private writeArtifact(stepId: string, name: string, content: string, mime: string): string {
    const hash = createHash("sha256").update(content).digest("hex");
    const blobDir = join(this.runDir, "artifacts", "sha256", hash.slice(0, 2));
    ensureDir(blobDir);
    const blobPath = join(blobDir, hash);
    if (!existsSync(blobPath)) writeFileSync(blobPath, content);

    const refName = `${safe(stepId)}.${name}`;
    const refDir = join(this.runDir, "artifacts", "refs");
    ensureDir(refDir);
    writeFileSync(
      join(refDir, `${refName}.json`),
      `${JSON.stringify({ sha256: hash, mime, bytes: Buffer.byteLength(content), note: name }, null, 2)}\n`,
    );
    return refName;
  }

  private writeManifest(status: RunStatus | "partial", totals: RunTotals, partial: boolean) {
    const manifest = {
      schema: SCHEMA_VERSION,
      runId: this.opts.runId,
      pipeline: this.opts.plan.name,
      pipelineFile: this.opts.plan.source,
      pipelineSha256: this.opts.plan.sourceSha256,
      startedAt: this.startedAt,
      endedAt: partial ? undefined : new Date().toISOString(),
      status,
      invoker: this.opts.invoker ?? { kind: "command" },
      cwd: this.opts.cwd,
      git: gitInfo(this.opts.cwd),
      env: filterEnv(this.opts.env, this.opts.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),
      totals,
      steps: [...this.steps.values()].map((rec) => ({
        id: rec.id,
        kind: rec.kind,
        path: rec.path,
        ok: rec.ok,
        skipped: rec.skipped,
        durationMs: rec.details?.durationMs,
        exitCode: rec.details?.exitCode,
        usage: rec.details?.usage,
        turns: rec.details?.turns,
        model: rec.details?.model,
        artifacts: rec.artifacts,
        error: rec.details?.error,
      })),
    };
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (partial) {
      writeFileSync(join(this.runDir, "run.partial.json"), json);
    } else {
      const tmp = join(this.runDir, `.run.json.${process.pid}.tmp`);
      writeFileSync(tmp, json);
      renameSync(tmp, join(this.runDir, "run.json"));
      try {
        rmSync(join(this.runDir, "run.partial.json"), { force: true });
      } catch {
        /* ignore */
      }
    }
    return manifest;
  }

  /** Records step paths from the frozen plan so run.json can show them. */
  attachPlanPaths(plan: Plan): void {
    const walk = (node: Plan["root"]) => {
      if (node.kind === "step") {
        this.stepRecord(node.step.id, node.step.kind).path = node.step.path;
        this.stepRecord(node.step.id, node.step.kind).kind = node.step.kind;
        return;
      }
      if (node.kind === "loop") {
        this.stepRecord(node.loop.id, "loop").path = node.loop.path;
        this.stepRecord(node.loop.id, "loop").kind = "loop";
        walk(node.loop.body);
        return;
      }
      node.children.forEach(walk);
    };
    walk(plan.root);
  }
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_") || "step";
}

export { mkdirSync };
