/**
 * JsonReporter — mirrors the event stream as NDJSON on stdout.
 *
 * Used when there is no UI (`pi -p …`, CI, git hooks) so a pipeline run is
 * still machine-readable from the outside.
 */
import type { Reporter, StepEvent } from "../core/types.ts";

export class JsonReporter implements Reporter {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(l)) {}

  onEvent(evt: StepEvent, meta: { t: string; runId: string }): void {
    this.write(`${JSON.stringify({ t: meta.t, runId: meta.runId, ...evt })}\n`);
  }
}
