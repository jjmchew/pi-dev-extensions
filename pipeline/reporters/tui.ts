/**
 * TuiReporter — a live tree of the run in a widget above the editor.
 *
 *   ▸ checks
 *     ├ ⠙ lint      shell   2.1s
 *     ├ ✓ tests     shell   8.2s
 *     └ ✗ review    llm     3 turns · $0.06
 */
import { markPendingClear, registerWidget } from "../core/widget-lifecycle.ts";
import type { Node, Plan, Reporter, RunStatus, RunTotals, StepEvent } from "../core/types.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Row = { id: string; kind: string; depth: number };
type State = {
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  startedAt?: number;
  durationMs?: number;
  note?: string;
};

export type TuiHost = {
  setWidget: (id: string, lines: string[] | undefined) => void;
};

export class TuiReporter implements Reporter {
  private readonly rows: Row[] = [];
  private readonly state = new Map<string, State>();
  private frame = 0;
  private timer?: ReturnType<typeof setInterval>;
  private finished = false;
  private summary?: string;

  constructor(
    private readonly host: TuiHost,
    private readonly plan: Plan,
    private readonly widgetId = "pipeline",
  ) {
    const walk = (node: Node, depth: number) => {
      if (node.kind === "step") {
        this.rows.push({ id: node.step.id, kind: node.step.kind, depth });
        this.state.set(node.step.id, { status: "pending" });
        return;
      }
      if (node.kind === "loop") {
        this.rows.push({ id: node.loop.id, kind: "loop", depth });
        this.state.set(node.loop.id, { status: "pending" });
        walk(node.loop.body, depth + 1);
        return;
      }
      node.children.forEach((c) => walk(c, depth + 1));
    };
    walk(plan.root, 0);
  }

  onRunStart(): void {
    registerWidget(this.widgetId);
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, 120);
    this.timer.unref?.();
    this.render();
  }

  onEvent(evt: StepEvent): void {
    switch (evt.type) {
      case "step_start": {
        const stateKey = this.stateKeyForEvent(evt.stepId);
        const s = this.state.get(stateKey) ?? { status: "pending" as const };
        s.status = "running";
        s.startedAt = Date.now();
        s.durationMs = undefined;
        s.note = iterationNote(evt.stepId);
        this.state.set(stateKey, s);
        break;
      }
      case "progress": {
        const stateKey = this.stateKeyForEvent(evt.stepId);
        const s = this.state.get(stateKey);
        const data = evt.data as any;
        if (s && data && typeof data === "object") {
          if (typeof data.turns === "number") {
            s.note = `${iterationNote(evt.stepId) ?? ""}${iterationNote(evt.stepId) ? " · " : ""}${data.turns} turn${data.turns === 1 ? "" : "s"}` + (data.cost ? ` · $${data.cost.toFixed(3)}` : "");
          } else if (typeof data.tool === "string") {
            s.note = `${iterationNote(evt.stepId) ?? ""}${iterationNote(evt.stepId) ? " · " : ""}${data.tool}`;
          }
        }
        break;
      }
      case "step_end": {
        const stateKey = this.stateKeyForEvent(evt.stepId);
        const s = this.state.get(stateKey) ?? { status: "pending" as const };
        const details = (evt.details ?? {}) as any;
        s.status = details.skipped ? "skipped" : evt.ok ? "ok" : "failed";
        s.durationMs = details.durationMs ?? (s.startedAt ? Date.now() - s.startedAt : undefined);
        if (details.timedOut) s.note = "timed out";
        this.state.set(stateKey, s);
        break;
      }
      default:
        break;
    }
    this.render();
  }

  onRunEnd(_ctx: unknown, status: RunStatus, totals: RunTotals): void {
    this.finished = true;
    if (this.timer) clearInterval(this.timer);
    const st = totals.steps;
    this.summary =
      `${statusGlyph(status)} ${status} · ${st.ok}/${st.total} ok` +
      (st.failed ? `, ${st.failed} failed` : "") +
      (st.skipped ? `, ${st.skipped} skipped` : "") +
      ` · ${fmtMs(totals.durationMs)}` +
      (totals.usage?.cost ? ` · $${totals.usage.cost.toFixed(3)}` : "");
    this.render();
    // Leave the summary up so the user can glance at it; the extension's
    // `input` hook will tear it down on the next typed message. Manual
    // dismissal is available via `/pipeline:clear`.
    markPendingClear(this.widgetId);
  }

  /** Remove the widget (call once the summary has been surfaced elsewhere). */
  clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.host.setWidget(this.widgetId, undefined);
  }

  private stateKeyForEvent(stepId: string): string {
    if (this.state.has(stepId)) return stepId;

    // Loop body events are emitted with physical ids like `fix.0.propose`,
    // while the compact widget renders the plan's logical row (`propose`).
    // Map physical loop ids back to their logical suffix so LLM progress
    // (tool name / turn count / cost) is visible for loop-body steps too.
    const parts = stepId.split(".");
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join(".");
      if (this.state.has(suffix)) return suffix;
    }
    return stepId;
  }

  private render(): void {
    const lines: string[] = [`▸ pipeline ${this.plan.name}`];
    for (const row of this.rows) {
      const s = this.state.get(row.id)!;
      const glyph =
        s.status === "running"
          ? SPINNER[this.frame % SPINNER.length]!
          : s.status === "ok"
            ? "✓"
            : s.status === "failed"
              ? "✗"
              : s.status === "skipped"
                ? "↷"
                : "·";
      const dur = s.durationMs !== undefined ? fmtMs(s.durationMs) : s.startedAt ? fmtMs(Date.now() - s.startedAt) : "";
      const indent = "  ".repeat(Math.max(0, row.depth - 1));
      lines.push(
        `  ${indent}${glyph} ${row.id.padEnd(14)} ${row.kind.padEnd(6)} ${dur}${s.note ? `  ${s.note}` : ""}`.trimEnd(),
      );
    }
    if (this.summary) lines.push(`  ${this.summary}`);
    this.host.setWidget(this.widgetId, lines);
    if (this.finished && this.timer) clearInterval(this.timer);
  }
}

function iterationNote(stepId: string): string | undefined {
  const m = stepId.match(/(?:^|\.)(\d+)\.[^.]+$/);
  return m ? `iter ${m[1]}` : undefined;
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

export function statusGlyph(status: RunStatus): string {
  return status === "ok" ? "✓" : status === "aborted" ? "⨯" : status === "partial" ? "◐" : "✗";
}
