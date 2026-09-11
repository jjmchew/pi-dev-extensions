/**
 * `/pipeline:chat [stepId]` \u2014 attach to an in-flight `mode: rpc` llm step.
 *
 * The rollout slice implements a bare-bones loop: repeatedly open the host's
 * multi-line editor for user input, forward each entry to the chat handle,
 * mirror assistant replies back through `ctx.ui.notify` / `setWidget`. A
 * blank submit means "end" (`explicit` if the user just sent a message,
 * `post-hoc` otherwise). `/end` forces explicit (wait for the next
 * assistant turn), `/end-now` forces post-hoc (close immediately with
 * whatever text is already on record). No custom overlay component in
 * v1 \u2014 that lands once the multi-chat widget and status badge follow.
 */
import { renderChatWidget, repaintChatWidget, widgetIdFor } from "../core/chat-widget.ts";
import { findChatByStepId, getChat, listChats, type ChatHandle } from "../core/interactive-registry.ts";
import { say, type CmdCtx } from "./ctx.ts";

function pickHandle(arg: string | undefined): ChatHandle | undefined {
  if (!arg) {
    const all = listChats();
    return all.length === 1 ? all[0] : undefined;
  }
  // Accept either `stepId` or `runId:stepId`.
  return arg.includes(":") ? getChat(arg) : findChatByStepId(arg);
}

export async function chatCommand(argsInput: string, ctx: CmdCtx): Promise<void> {
  const [target] = (argsInput ?? "").trim().split(/\s+/).filter(Boolean);

  if (!ctx.hasUI) {
    say(ctx, "/pipeline:chat requires an interactive UI", "error");
    return;
  }
  const editor = ctx.ui?.editor;
  if (!editor) {
    say(ctx, "/pipeline:chat needs `ctx.ui.editor` (unsupported in this host)", "error");
    return;
  }

  const handle = pickHandle(target);
  if (!handle) {
    const all = listChats();
    if (all.length === 0) {
      say(ctx, "no interactive llm steps are currently registered", "warn");
      return;
    }
    const ids = all.map((h) => `${h.stepId} (${h.state})`).join(", ");
    say(ctx, `pick a step: /pipeline:chat <stepId>. active: ${ids}`, "warn");
    return;
  }

  // Share the auto chat-widget id so attaching upgrades the widget in
  // place rather than stacking a second one, and detaching hands
  // rendering back to the auto manager (see core/chat-widget.ts).
  const widgetKey = widgetIdFor(handle);
  const setWidget = ctx.ui?.setWidget;
  const paint = () => setWidget?.(widgetKey, renderChatWidget(handle, { attached: true }));
  // Repaint on both state changes and new messages so the [attached]
  // header and hint line stay in sync with the sub-pi.
  const offMsg = handle.on("message", paint);
  const offState = handle.on("state", paint);
  const off = () => {
    offMsg();
    offState();
  };
  paint();

  try {
    let userJustSent = false;
    while (true) {
      const title = `chat: ${handle.stepId} \u00b7 ${handle.state}`;
      const input = await editor(title, "");
      if (input === undefined) {
        // Esc / cancel: detach without killing the child.
        say(ctx, `detached from ${handle.stepId} (still running)`, "info");
        break;
      }
      const trimmed = input.trim();
      if (!trimmed) {
        const mode = userJustSent ? "explicit" : "post-hoc";
        say(ctx, `finalizing ${handle.stepId} (${mode})\u2026`, "info");
        const text = await handle.finalize(mode);
        say(ctx, `finalized ${handle.stepId} (${text.length} chars)`, "success");
        break;
      }
      if (trimmed === "/end") {
        // Wait for the current/next assistant turn to complete, then close.
        say(ctx, `ending ${handle.stepId} (after next turn)\u2026`, "info");
        const text = await handle.finalize("explicit");
        say(ctx, `ended ${handle.stepId} (${text.length} chars)`, "success");
        break;
      }
      if (trimmed === "/end-now") {
        // Close immediately using whatever assistant text is already on record.
        say(ctx, `ending ${handle.stepId} (now)\u2026`, "info");
        const text = await handle.finalize("post-hoc");
        say(ctx, `ended ${handle.stepId} (${text.length} chars)`, "success");
        break;
      }
      if (trimmed === "/abort") {
        handle.abort("user");
        say(ctx, `aborted ${handle.stepId}`, "warn");
        break;
      }
      handle.send(trimmed);
      userJustSent = true;
    }
  } finally {
    off();
    // Hand rendering back to the auto chat widget while the step is
    // still live. If the handle already unregistered (finalize/abort),
    // repaintChatWidget is a no-op and the auto manager's `unregister`
    // listener has already cleared the widget.
    repaintChatWidget(handle);
  }
}
