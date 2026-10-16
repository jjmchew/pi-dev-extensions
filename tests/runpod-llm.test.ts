/**
 * Regression tests for the runpod-llm provider extension.
 *
 * Run with: `bun test tests/runpod-llm.test.ts` (from ~/.pi/agent/extensions/).
 * `@earendil-works/pi-ai` must resolve; bun ignores NODE_PATH, so temporarily
 * symlink pi's copy:
 *   mkdir -p node_modules && ln -sfn "$(npm root -g)/@earendil-works/pi-coding-agent/node_modules/@earendil-works" node_modules/@earendil-works
 * (remove it afterwards: `unlink node_modules/@earendil-works; rmdir node_modules`)
 *
 * Locks in the TranscriptContext fix: pi passes the system prompt and tools as
 * `system` messages in context.messages (context.systemPrompt/context.tools are
 * gone), and the extension previously sent requests with no tools and no system
 * prompt, so every model hallucinated text "<tool_call>" output.
 *
 * fetch is mocked; no network. Every registered model is exercised.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeContext, type Context, type Tool } from "@earendil-works/pi-ai";

const TMP = join(import.meta.dir, ".tmp-runpod-llm");
mkdirSync(TMP, { recursive: true });
writeFileSync(
	join(TMP, "models.json"),
	JSON.stringify({ providers: { "runpod-llm": { baseUrl: "https://proxy.example/v1", apiKey: "sk-test" } } }),
);
process.env.PI_CODING_AGENT_DIR = TMP;
delete process.env.RUNPOD_LITELLM_API_KEY;
delete process.env.RUNPOD_KIMI_TOOL_CHOICE;
delete process.env.RUNPOD_KIMI_DEBUG;

type Provider = { models: any[]; streamSimple: (model: any, context: any, options?: any) => AsyncIterable<any> };
let provider: Provider;

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; body: any }> = [];
let nextPayload: unknown;

beforeAll(async () => {
	const mod = await import("../runpod-llm/index.ts");
	mod.default({
		registerProvider: (_name: string, config: Provider) => {
			provider = config;
		},
	} as any);
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		requests.push({ url, body: JSON.parse(String(init.body)) });
		return new Response(JSON.stringify(nextPayload), { status: 200 });
	}) as typeof fetch;
});

afterAll(() => {
	globalThis.fetch = realFetch;
	rmSync(TMP, { recursive: true, force: true });
});

const bashTool: Tool = {
	name: "bash",
	description: "Run a shell command",
	parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } as any,
};
const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as any,
};

const toolCallPayload = {
	choices: [
		{
			finish_reason: "tool_calls",
			message: {
				role: "assistant",
				content: null,
				reasoning_content: "I should list files.",
				tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
			},
		},
	],
	usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

async function run(model: any, context: unknown, options: Record<string, unknown> = {}) {
	requests = [];
	let final: any;
	for await (const event of provider.streamSimple(model, context, { apiKey: "sk-test", ...options })) {
		if (event.type === "done") final = event.message;
		if (event.type === "error") throw new Error(event.error.errorMessage);
	}
	expect(requests).toHaveLength(1);
	return { body: requests[0]!.body, url: requests[0]!.url, message: final };
}

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

test("registers the expected models", () => {
	expect(provider.models.map((m) => m.id).sort()).toEqual(
		["deepseek-ai/DeepSeek-V4.1-Flash", "moonshotai/Kimi-K3", "qwen/qwen3.8-27b-fp8", "zai-org/GLM-5.3"].sort(),
	);
});

describe.each(["moonshotai/Kimi-K3", "qwen/qwen3.8-27b-fp8", "deepseek-ai/DeepSeek-V4.1-Flash", "zai-org/GLM-5.3"])(
	"%s",
	(modelId) => {
		const model = () => ({ ...provider.models.find((m) => m.id === modelId)!, provider: "runpod-llm", api: "runpod-llm" });

		test("TranscriptContext: sends tools, tool_choice and a single leading system prompt", async () => {
			nextPayload = toolCallPayload;
			const context = normalizeContext({
				systemPrompt: "You are pi.",
				tools: [bashTool],
				messages: [userMsg("list files")],
			} as Context);
			const { body, url } = await run(model(), context);

			expect(url).toBe("https://proxy.example/v1/chat/completions");
			expect(body.model).toBe(modelId);
			expect(body.tools).toEqual([
				{ type: "function", function: { name: "bash", description: bashTool.description, parameters: bashTool.parameters } },
			]);
			expect(body.tool_choice).toBe("auto");
			expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
			expect(body.messages[0].content).toStartWith("You are pi.");
			expect(body.messages[0].content).toContain("- bash: Run a shell command");
		});

		test("parses native tool_calls into a toolUse turn", async () => {
			nextPayload = toolCallPayload;
			const context = normalizeContext({ systemPrompt: "x", tools: [bashTool], messages: [userMsg("ls")] } as Context);
			const { message } = await run(model(), context);
			expect(message.stopReason).toBe("toolUse");
			const call = message.content.find((b: any) => b.type === "toolCall");
			expect(call).toMatchObject({ id: "call_1", name: "bash", arguments: { command: "ls" } });
			expect(message.content.some((b: any) => b.type === "thinking" && b.thinking === "I should list files.")).toBe(true);
		});

		test("multi-turn: replays assistant tool_calls and tool results", async () => {
			nextPayload = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done." } }] };
			const context = normalizeContext({
				systemPrompt: "x",
				tools: [bashTool],
				messages: [
					userMsg("ls"),
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
						api: "runpod-llm",
						provider: "runpod-llm",
						model: modelId,
						usage: {} as any,
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
					{ role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: Date.now() },
				],
			} as Context);
			const { body, message } = await run(model(), context);
			expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
			expect(body.messages[2].tool_calls[0]).toEqual({ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } });
			expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "a.txt" });
			expect(message.stopReason).toBe("stop");
			expect(message.content).toContainEqual({ type: "text", text: "Done." });
		});

		test("mid-conversation system message: tools accumulate, system messages collapse", async () => {
			nextPayload = toolCallPayload;
			const base = normalizeContext({ systemPrompt: "Base.", tools: [bashTool], messages: [userMsg("one")] } as Context);
			const context = {
				...base,
				messages: [
					...base.messages,
					{ role: "system", content: "Extra rule.", toolsAdded: [readTool], timestamp: Date.now() },
					userMsg("two"),
				],
			};
			const { body } = await run(model(), context);
			expect(body.tools.map((t: any) => t.function.name)).toEqual(["bash", "read"]);
			expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user", "user"]);
			expect(body.messages[0].content).toContain("Base.");
			expect(body.messages[0].content).toContain("Extra rule.");
		});

		test("no tools: omits tools/tool_choice", async () => {
			nextPayload = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hi" } }] };
			const { body } = await run(model(), normalizeContext({ systemPrompt: "x", messages: [userMsg("hi")] } as Context));
			expect(body.tools).toBeUndefined();
			expect(body.tool_choice).toBeUndefined();
		});

		test("legacy Context shape still works", async () => {
			nextPayload = toolCallPayload;
			const { body } = await run(model(), { systemPrompt: "Legacy.", tools: [bashTool], messages: [userMsg("ls")] });
			expect(body.tools).toHaveLength(1);
			expect(body.messages[0]).toMatchObject({ role: "system" });
			expect(body.messages[0].content).toStartWith("Legacy.");
		});
	},
);

describe("thinking parameters (unchanged per-model behavior)", () => {
	const ctx = () => normalizeContext({ systemPrompt: "x", tools: [bashTool], messages: [userMsg("ls")] } as Context);
	const model = (id: string) => ({ ...provider.models.find((m) => m.id === id)!, provider: "runpod-llm", api: "runpod-llm" });

	test.each(["moonshotai/Kimi-K3", "qwen/qwen3.8-27b-fp8"])("%s uses chat_template_kwargs", async (id) => {
		nextPayload = toolCallPayload;
		const on = await run(model(id), ctx(), { reasoning: "high" });
		expect(on.body.chat_template_kwargs).toEqual({ enable_thinking: true });
		expect(on.body.reasoning_effort).toBeDefined();
		const off = await run(model(id), ctx());
		expect(off.body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(off.body.reasoning_effort).toBe("none");
	});

	test.each(["deepseek-ai/DeepSeek-V4.1-Flash", "zai-org/GLM-5.3"])("%s uses reasoning_effort only", async (id) => {
		nextPayload = toolCallPayload;
		const on = await run(model(id), ctx(), { reasoning: "high" });
		expect(on.body.chat_template_kwargs).toBeUndefined();
		expect(on.body.reasoning_effort).toBeDefined();
		const off = await run(model(id), ctx());
		expect(off.body.chat_template_kwargs).toBeUndefined();
		expect(off.body.reasoning_effort).toBeUndefined();
	});
});
