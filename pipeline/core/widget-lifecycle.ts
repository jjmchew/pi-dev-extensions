/**
 * Cross-cutting registry for pipeline TUI widgets.
 *
 * A run's TuiReporter renders `ctx.ui.setWidget("pipeline", …)` above the
 * editor and leaves the final summary in place after completion so the user
 * can glance at the result. That summary is then torn down on the *next*
 * user input (`pi.on("input", …)` in index.ts) or explicitly via
 * `/pipeline:clear`.
 *
 * TuiReporter can't clear the widget itself from those code paths because
 * the reporter instance is scoped to one run; this module holds the
 * process-wide state that outlives it.
 */

export type SetWidget = (id: string, lines: string[] | undefined) => void;

let setWidgetImpl: SetWidget | undefined;
const active = new Set<string>();
const pendingClear = new Set<string>();

/** Bind the host's setWidget once we have an ExtensionContext (session_start). */
export function bindSetWidget(fn: SetWidget | undefined): void {
  setWidgetImpl = fn;
}

/** Called when a TuiReporter starts drawing. */
export function registerWidget(id: string): void {
  active.add(id);
  pendingClear.delete(id);
}

/** Called on successful completion — clear on the next user input. */
export function markPendingClear(id: string): void {
  if (active.has(id)) pendingClear.add(id);
}

/**
 * Set (or clear) a widget through the host-bound setWidget while keeping
 * the active/pendingClear bookkeeping in sync. Reporters that already
 * hold their own host handle can keep calling `host.setWidget` directly;
 * this exists for cross-cutting widgets (e.g. the auto chat widget) that
 * live outside any single reporter instance.
 */
export function setPipelineWidget(id: string, lines: string[] | undefined): void {
  if (lines === undefined) {
    active.delete(id);
    pendingClear.delete(id);
    setWidgetImpl?.(id, undefined);
    return;
  }
  active.add(id);
  pendingClear.delete(id);
  setWidgetImpl?.(id, lines);
}

/** Called from the input hook. Clears anything marked pending. */
export function clearPending(): void {
  for (const id of pendingClear) {
    setWidgetImpl?.(id, undefined);
    active.delete(id);
  }
  pendingClear.clear();
}

/** Called by `/pipeline:clear` and on session_shutdown. Clears everything. */
export function clearAll(): { cleared: number } {
  const n = active.size;
  for (const id of active) setWidgetImpl?.(id, undefined);
  active.clear();
  pendingClear.clear();
  return { cleared: n };
}

/** For tests. */
export function _resetForTests(): void {
  setWidgetImpl = undefined;
  active.clear();
  pendingClear.clear();
}
