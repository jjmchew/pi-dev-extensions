/**
 * TraceReporter — writes each llm step's verbatim sub-pi event stream to
 * `steps/<id>/trace.jsonl`.
 *
 * Raw and unredacted by design: this is what eval harnesses consume. See
 * `pipeline.redactTraces` in the spec's follow-ups if that ever needs to
 * change.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../core/runsDir.ts";
import type { Reporter, StepEvent } from "../core/types.ts";

export class TraceReporter implements Reporter {
  private readonly seen = new Set<string>();

  constructor(private readonly runDir: string) {}

  onEvent(evt: StepEvent): void {
    if (evt.type !== "llm_event") return;
    const dir = join(this.runDir, "steps", safe(evt.stepId));
    if (!this.seen.has(dir)) {
      ensureDir(dir);
      this.seen.add(dir);
    }
    appendFileSync(join(dir, "trace.jsonl"), `${JSON.stringify(evt.event)}\n`);
  }
}

function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_") || "step";
}
