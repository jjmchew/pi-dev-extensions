/**
 * Tests for anthropic-stall-retry. Run with: `bun test tests/anthropic-stall-retry.test.ts`
 * Uses a fake ExtensionAPI; no network.
 */
import { beforeAll, describe, expect, test } from "bun:test";

process.env.PI_ANTHROPIC_STALL_HEADERS_MS = "30";
process.env.PI_ANTHROPIC_STALL_IDLE_MS = "30";
process.env.PI_ANTHROPIC_STALL_MAX_RETRIES = "2";

type Handler = (event: any, ctx: any) => unknown;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(provider = "anthropic") {
	const handlers: Record<string, Handler[]> = {};
	const sent: any[] = [];
	const notes: string[] = [];
	let aborts = 0;
	const pi: any = {
		on: (name: string, h: Handler) => (handlers[name] ??= []).push(h),
		registerCommand: () => {},
		sendMessage: (m: any, o: any) => sent.push({ m, o }),
	};
	const ctx: any = {
		model: { provider },
		isIdle: () => false,
		abort: () => aborts++,
		ui: { notify: (m: string) => notes.push(m) },
	};
	const emit = async (name: string, event: any = {}) => {
		for (const h of handlers[name] ?? []) await h({ type: name, ...event }, ctx);
	};
	return { pi, emit, sent, notes, aborts: () => aborts };
}

let factory: (pi: any) => void;
beforeAll(async () => {
	factory = (await import("../anthropic-stall-retry.ts")).default;
});

describe("anthropic-stall-retry", () => {
	test("aborts and resends when headers never arrive", async () => {
		const h = harness();
		factory(h.pi);
		await h.emit("input");
		await h.emit("before_provider_request");
		await sleep(60);
		expect(h.aborts()).toBe(1);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		await h.emit("agent_settled", { aborted: true });
		await sleep(5);
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].o.triggerTurn).toBe(true);
	});

	test("stream events keep it alive; completion does not retry", async () => {
		const h = harness();
		factory(h.pi);
		await h.emit("before_provider_request");
		await h.emit("after_provider_response");
		for (let i = 0; i < 4; i++) {
			await sleep(15);
			await h.emit("provider_stream_event", { provider: "anthropic" });
		}
		await h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		await sleep(60);
		await h.emit("agent_settled", { aborted: false });
		expect(h.aborts()).toBe(0);
		expect(h.sent.length).toBe(0);
	});

	test("user abort (Esc) is not retried", async () => {
		const h = harness();
		factory(h.pi);
		await h.emit("before_provider_request");
		await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
		await h.emit("agent_settled", { aborted: true });
		await sleep(5);
		expect(h.sent.length).toBe(0);
	});

	test("non-anthropic models are ignored", async () => {
		const h = harness("openai-codex");
		factory(h.pi);
		await h.emit("before_provider_request");
		await sleep(60);
		expect(h.aborts()).toBe(0);
	});

	test("gives up after max retries", async () => {
		const h = harness();
		factory(h.pi);
		await h.emit("input");
		for (let i = 0; i < 3; i++) {
			await h.emit("before_provider_request");
			await sleep(60);
			await h.emit("message_end", { message: { role: "assistant", stopReason: "aborted" } });
			await h.emit("agent_settled", { aborted: true });
			await sleep(5);
		}
		expect(h.aborts()).toBe(3);
		expect(h.sent.length).toBe(2);
		expect(h.notes.at(-1)).toContain("gave up");
	});
});
