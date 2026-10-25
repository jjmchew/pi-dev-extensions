/**
 * Anthropic Stall Retry
 *
 * Watches Anthropic requests for stalls. If no response headers arrive, or the
 * stream goes quiet for too long, it aborts the request and sends it again by
 * posting a short "continue" note. Aborted assistant messages are dropped from
 * model context, so the retry sees the same transcript plus that note.
 *
 * Tuning (env vars):
 *   PI_ANTHROPIC_STALL_HEADERS_MS  wait for response headers   (default 45000)
 *   PI_ANTHROPIC_STALL_IDLE_MS     max gap between stream events (default 67500)
 *   PI_ANTHROPIC_STALL_MAX_RETRIES retries per user prompt        (default 3)
 *
 * /stall-retry toggles the extension for the current session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
const HEADERS_MS = num(process.env.PI_ANTHROPIC_STALL_HEADERS_MS, 45_000);
const IDLE_MS = num(process.env.PI_ANTHROPIC_STALL_IDLE_MS, 67_500);
const MAX_RETRIES = num(process.env.PI_ANTHROPIC_STALL_MAX_RETRIES, 3);
const MSG_TYPE = "anthropic-stall-retry";

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watching = false;
	let stalled = false; // we triggered the abort, not the user
	let retries = 0;
	let lastReason = "";

	const clear = () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		watching = false;
	};

	const arm = (ctx: ExtensionContext, ms: number, reason: string) => {
		if (timer) clearTimeout(timer);
		watching = true;
		timer = setTimeout(() => {
			timer = undefined;
			if (!watching || ctx.isIdle()) return;
			watching = false;
			stalled = true;
			lastReason = `${reason} after ${Math.round(ms / 1000)}s`;
			ctx.abort();
		}, ms);
	};

	const isAnthropic = (ctx: ExtensionContext) => ctx.model?.provider === "anthropic";

	pi.on("input", async () => {
		retries = 0; // fresh user prompt resets the budget
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (!enabled || !isAnthropic(ctx)) return;
		arm(ctx, HEADERS_MS, "no response headers");
	});

	pi.on("after_provider_response", async (_event, ctx) => {
		if (watching) arm(ctx, IDLE_MS, "stream idle");
	});

	pi.on("provider_stream_event", async (event, ctx) => {
		if (watching && event.provider === "anthropic") arm(ctx, IDLE_MS, "stream idle");
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		clear();
		const stop = (event.message as { stopReason?: string }).stopReason;
		if (stop !== "aborted" && stop !== "error") retries = 0;
	});

	pi.on("agent_end", async () => clear());

	pi.on("agent_settled", async (event, ctx) => {
		clear();
		if (!stalled) return;
		stalled = false;
		if (!event.aborted) return;

		if (retries >= MAX_RETRIES) {
			ctx.ui.notify(`Anthropic request stalled (${lastReason}); gave up after ${retries} retries.`, "error");
			return;
		}
		retries++;
		ctx.ui.notify(`Anthropic request stalled (${lastReason}); retrying ${retries}/${MAX_RETRIES}…`, "warning");
		// Defer so the settle finishes before the new turn starts.
		setTimeout(() => {
			pi.sendMessage(
				{
					customType: MSG_TYPE,
					content: "[auto-retry] The previous response stalled and was cancelled before completing. Continue where you left off.",
					display: true,
				},
				{ triggerTurn: true },
			);
		}, 0);
	});

	pi.on("session_shutdown", async () => clear());

	pi.registerCommand("stall-retry", {
		description: "Toggle automatic retry of stalled Anthropic requests",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!enabled) clear();
			ctx.ui.notify(
				`Anthropic stall retry ${enabled ? "enabled" : "disabled"} (headers ${HEADERS_MS / 1000}s, idle ${IDLE_MS / 1000}s, max ${MAX_RETRIES})`,
				"info",
			);
		},
	});
}
