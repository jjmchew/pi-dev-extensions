/**
 * Auto chat widget for interactive (`mode: rpc`) llm steps.
 *
 * The `llm` executor registers a `ChatHandle` in `interactive-registry` for
 * every RPC-mode step. Without this module the only surface for that
 * handle is `/pipeline:chat`, which the user has to know about and invoke
 * — so an RPC step that lands in `awaiting-input` looks identical to one
 * still churning. This module fixes that: it listens to the registry and
 * paints a bordered widget per active chat, keyed `pipeline-chat:<stepId>`.
 *
 * `/pipeline:chat` paints into the same widget id (see commands/chat.ts)
 * with `attached: true`, so attaching upgrades the widget to a richer
 * transcript in place and detaching hands rendering back here.
 *
 * All widget writes go through `setPipelineWidget` so `clearAll()` on
 * session shutdown still tears these down cleanly.
 */
import {
  listChats,
  onRegistryEvent,
  type ChatHandle,
  type ChatState,
  type TranscriptEntry,
} from "./interactive-registry.ts";
import { setPipelineWidget } from "./widget-lifecycle.ts";

/** Widget geometry. Width is derived from the terminal at paint time so
 *  the rules span the full pane; role labels line up in a fixed column. */
const LABEL_W = 10; // "assistant" is the widest role label
const GUTTER = "  "; // outer indent under the top/bottom rule
const MIN_WIDTH = 40;
const MAX_WIDTH = 200;
const DEFAULT_WIDTH = 80;

const AUTO_MAX_ENTRIES = 8;
const ATTACHED_MAX_ENTRIES = 30;

function paneWidth(): number {
  const cols = process.stdout.columns ?? DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, cols));
}

let installed = false;
let resizeHandler: (() => void) | undefined;
const attached = new Map<string, () => void>();

export function widgetIdFor(handle: ChatHandle): string {
  return `pipeline-chat:${handle.stepId}`;
}

// ─── rendering ─────────────────────────────────────────────────────────────

function stateLabel(state: ChatState): string {
  switch (state) {
    case "awaiting-input":
      return "⏸ awaiting input";
    case "streaming":
      return "… streaming";
    case "finalizing":
      return "⏳ finalizing";
    case "done":
      return "✓ done";
    default:
      return "· idle";
  }
}

function roleLabel(role: TranscriptEntry["role"]): string {
  return role === "user" ? "you" : role === "assistant" ? "assistant" : "system";
}

/** `═══ 💬 chat: <id> · <state>  [attached] ══…══` padded to `width`. */
function headerLine(handle: ChatHandle, isAttached: boolean, width: number): string {
  const tag = isAttached ? "  [attached]" : "";
  const title = ` 💬 chat: ${handle.stepId} · ${stateLabel(handle.state)}${tag} `;
  const leading = "═══";
  // The emoji is width-2 in most terminals; pad on the low side so we
  // don't accidentally wrap onto a second line in narrow panes.
  const rest = Math.max(3, width - leading.length - title.length - 1);
  return `${leading}${title}${"═".repeat(rest)}`;
}

function footerLine(width: number): string {
  return "═".repeat(width);
}

/** Word-wrap `text` onto lines of at most `width` chars. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut <= 0) cut = width; // no space to break on — hard-cut
      out.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
    }
    out.push(line);
  }
  // Preserve at least one empty line for a truly empty entry.
  return out.length === 0 ? [""] : out;
}

function renderEntry(entry: TranscriptEntry, width: number): string[] {
  const label = roleLabel(entry.role);
  const contentW = Math.max(10, width - GUTTER.length - LABEL_W - 1);
  const wrapped = wrap(entry.text.trim(), contentW);
  const lines: string[] = [];
  const pad = " ".repeat(LABEL_W);
  for (let i = 0; i < wrapped.length; i++) {
    const prefix = i === 0 ? label.padEnd(LABEL_W) : pad;
    lines.push(`${GUTTER}${prefix} ${wrapped[i]}`);
  }
  return lines;
}

function hintLine(handle: ChatHandle, isAttached: boolean): string | undefined {
  if (isAttached) {
    return `${GUTTER}Esc detach · empty submit end · /end · /end-now · /abort`;
  }
  switch (handle.state) {
    case "awaiting-input":
      return `${GUTTER}⚠ input needed — /pipeline:chat ${handle.stepId}   (submit empty to end)`;
    case "streaming":
      return `${GUTTER}attach to steer: /pipeline:chat ${handle.stepId}`;
    case "finalizing":
      return `${GUTTER}ending…`;
    default:
      return undefined;
  }
}

export type RenderOptions = { attached?: boolean; maxEntries?: number; width?: number };

/** Bordered per-step chat view, used by both the auto manager and /pipeline:chat. */
export function renderChatWidget(handle: ChatHandle, opts: RenderOptions = {}): string[] {
  const isAttached = Boolean(opts.attached);
  const max = opts.maxEntries ?? (isAttached ? ATTACHED_MAX_ENTRIES : AUTO_MAX_ENTRIES);
  const width = opts.width ?? paneWidth();

  const lines: string[] = [headerLine(handle, isAttached, width), ""];

  const rows = handle.transcript.slice(-max);
  if (rows.length === 0) {
    lines.push(`${GUTTER}${"—".padEnd(LABEL_W)} (no messages yet)`);
  } else {
    for (let i = 0; i < rows.length; i++) {
      lines.push(...renderEntry(rows[i]!, width));
      // Blank spacer between entries so wrapped bodies don't run together.
      if (i < rows.length - 1) lines.push("");
    }
  }

  lines.push("");
  const hint = hintLine(handle, isAttached);
  if (hint) lines.push(hint);
  lines.push(footerLine(width));
  return lines;
}

// ─── registry wiring ───────────────────────────────────────────────────────

function attach(handle: ChatHandle): void {
  if (attached.has(handle.key)) return;
  const id = widgetIdFor(handle);
  const paint = () => setPipelineWidget(id, renderChatWidget(handle));
  paint();
  const offState = handle.on("state", paint);
  const offMsg = handle.on("message", paint);
  attached.set(handle.key, () => {
    offState();
    offMsg();
  });
}

function detach(handle: ChatHandle): void {
  const cleanup = attached.get(handle.key);
  if (cleanup) {
    cleanup();
    attached.delete(handle.key);
  }
  setPipelineWidget(widgetIdFor(handle), undefined);
}

/** Repaint every currently attached widget (e.g. after a terminal resize). */
function repaintAll(): void {
  for (const h of listChats()) {
    if (attached.has(h.key)) setPipelineWidget(widgetIdFor(h), renderChatWidget(h));
  }
}

/**
 * Install once at session_start. Idempotent so nested pipeline runs that
 * re-enter session_start (e.g. tests) don't stack listeners.
 */
export function installChatWidgets(): void {
  if (installed) return;
  installed = true;
  for (const h of listChats()) attach(h);
  onRegistryEvent("register", attach);
  onRegistryEvent("unregister", detach);
  // Re-fit rules and wrapping when the terminal resizes.
  resizeHandler = repaintAll;
  process.stdout.on("resize", resizeHandler);
}

/**
 * Re-paint the auto widget for a still-live handle. Called from
 * `/pipeline:chat` when the user detaches without finalizing so the
 * un-attached view takes over from the attached transcript.
 */
export function repaintChatWidget(handle: ChatHandle): void {
  if (!attached.has(handle.key)) return; // already unregistered
  setPipelineWidget(widgetIdFor(handle), renderChatWidget(handle));
}

/** For tests. */
export function _resetChatWidgetsForTests(): void {
  for (const [, cleanup] of attached) cleanup();
  attached.clear();
  if (resizeHandler) {
    process.stdout.off("resize", resizeHandler);
    resizeHandler = undefined;
  }
  installed = false;
}
