/**
 * Process-wide registry of in-flight detached `/pipeline` runs.
 *
 * `/pipeline` in a UI session returns from its command handler as soon as
 * the run is scheduled (see commands/run.ts for why: pi dispatches slash
 * commands serially, so a blocking `/pipeline` handler stalls
 * `/pipeline:chat` — the very command needed to drive an RPC step — until
 * the run finishes). This module holds each in-flight run so
 * `session_shutdown` can abort them and future commands
 * (e.g. `/pipeline:cancel`) can look them up.
 */

export type ActiveRun = {
  key: string;
  name: string;
  startedAt: number;
  abort: (reason?: string) => void;
  promise: Promise<unknown>;
};

const runs = new Map<string, ActiveRun>();

export function registerActiveRun(run: ActiveRun): void {
  runs.set(run.key, run);
}

export function unregisterActiveRun(key: string): void {
  runs.delete(key);
}

export function listActiveRuns(): ActiveRun[] {
  return [...runs.values()];
}

/** SIGTERM every in-flight run. Called from session_shutdown. */
export function abortAllActiveRuns(reason = "session shutdown"): number {
  const n = runs.size;
  for (const r of runs.values()) {
    try {
      r.abort(reason);
    } catch {
      // best-effort
    }
  }
  return n;
}

/** For tests. */
export function _resetActiveRunsForTests(): void {
  runs.clear();
}
