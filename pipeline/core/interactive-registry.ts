/**
 * Process-wide registry of live RPC-mode LLM steps.
 *
 * When an `llm` step is configured with `mode: rpc`, the executor spawns
 * `pi --mode rpc`, wraps stdio into a `ChatHandle`, and registers it here
 * under key `${runId}:${stepId}`. A slash command (e.g. `/pipeline chat`)
 * looks the handle up by step id and drives the sub-pi from the user's
 * chat pane.
 *
 * The step does not finish on child exit — the executor blocks until
 * `finalize()` resolves, then closes the child's stdin.
 */
import { EventEmitter } from "node:events";

export type ChatState = "idle" | "streaming" | "awaiting-input" | "finalizing" | "done";

export type TranscriptEntry =
  | { role: "user"; text: string; at: number }
  | { role: "assistant"; text: string; at: number }
  | { role: "system"; text: string; at: number };

export type FinalizeMode = "explicit" | "post-hoc";

export type ChatHandle = {
  runId: string;
  stepId: string;
  key: string;
  state: ChatState;
  transcript: TranscriptEntry[];
  startedAt: number;
  send(msg: string): boolean;
  finalize(mode: FinalizeMode): Promise<string>;
  abort(reason?: string): void;
  /** Subscribe to state/message updates. Returns an unsubscribe fn. */
  on(event: "state" | "message", cb: (...args: unknown[]) => void): () => void;
  /** Attached only after the step ends, for post-mortem lookup. */
  final?: string;
};

const chats = new Map<string, ChatHandle>();
const registry = new EventEmitter();

export function chatKey(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

export function registerChat(handle: ChatHandle): void {
  chats.set(handle.key, handle);
  registry.emit("register", handle);
}

export function unregisterChat(key: string): void {
  const h = chats.get(key);
  if (!h) return;
  chats.delete(key);
  registry.emit("unregister", h);
}

export function getChat(key: string): ChatHandle | undefined {
  return chats.get(key);
}

export function findChatByStepId(stepId: string): ChatHandle | undefined {
  for (const h of chats.values()) if (h.stepId === stepId) return h;
  return undefined;
}

export function listChats(): ChatHandle[] {
  return [...chats.values()];
}

export function onRegistryEvent(
  event: "register" | "unregister",
  cb: (handle: ChatHandle) => void,
): () => void {
  registry.on(event, cb);
  return () => registry.off(event, cb);
}
