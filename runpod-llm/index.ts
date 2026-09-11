import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	createAssistantMessageEventStream,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// URLs are configured in ~/.pi/agent/models.json under providers["runpod-llm"].
// - baseUrl at provider level: default LiteLLM proxy for OpenAI-compatible calls.
// - baseUrl per model: overrides the provider URL for that specific model id.
const DEFAULT_MAX_TOKENS = 16_384;

// Models whose thinking is toggled via chat_template_kwargs.enable_thinking (vLLM/SGLang
// chat templates) rather than a native reasoning_effort-only path.
const CHAT_TEMPLATE_THINKING_MODELS = new Set<string>(["moonshotai/Kimi-K3", "qwen/qwen3.8-27b-fp8"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object" && "type" in block) {
				const typed = block as { type?: string; text?: string; name?: string; arguments?: unknown };
				if (typed.type === "text") return typed.text ?? "";
				if (typed.type === "image") return "[image]";
				if (typed.type === "toolCall") return `[tool call: ${typed.name ?? "unknown"} ${JSON.stringify(typed.arguments ?? {})}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

type OpenAIMessage =
	| { role: "system" | "user"; content: string }
	| { role: "assistant"; content?: string | null; tool_calls?: OpenAIToolCall[] }
	| { role: "tool"; tool_call_id: string; name?: string; content: string };

type OpenAIToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

function toolProtocolPrompt(tools: Tool[] | undefined): string {
	if (!tools?.length) return "";
	const toolList = tools
		.map((tool) => `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`)
		.join("\n");
	// Kept as a safety net: if the upstream model ever ignores native tool_calls
	// and prints JSON in the assistant text, we still recover on the client side.
	return `\n\nTOOL-CALLING FALLBACK PROTOCOL:\nPrefer native OpenAI tool_calls. If for any reason you cannot emit them, respond with ONLY JSON in this exact shape:\n{"tool_calls":[{"name":"tool_name","arguments":{"arg":"value"}}]}\nAvailable tools:\n${toolList}`;
}

function convertMessages(context: Context): OpenAIMessage[] {
	const messages: OpenAIMessage[] = [];
	const systemPrompt = `${context.systemPrompt?.trim() ?? ""}${toolProtocolPrompt(context.tools)}`.trim();
	if (systemPrompt) {
		messages.push({ role: "system", content: systemPrompt });
	}

	for (const message of context.messages as Message[]) {
		if (message.role === "user") {
			const content = textFromContent(message.content);
			if (content.trim()) messages.push({ role: "user", content });
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.filter(Boolean)
				.join("\n");
			const toolCalls: OpenAIToolCall[] = message.content
				.filter((block): block is ToolCall => block.type === "toolCall")
				.map((block, index) => ({
					id: block.id || `call_${Date.now()}_${index}`,
					type: "function" as const,
					function: {
						name: block.name,
						arguments: JSON.stringify(block.arguments ?? {}),
					},
				}));
			if (toolCalls.length > 0) {
				messages.push({
					role: "assistant",
					content: text || null,
					tool_calls: toolCalls,
				});
			} else if (text.trim()) {
				messages.push({ role: "assistant", content: text });
			}
		} else if (message.role === "toolResult") {
			const content = textFromContent(message.content);
			messages.push({
				role: "tool",
				tool_call_id: message.toolCallId,
				name: message.toolName,
				content,
			});
		}
	}

	return messages;
}

function convertTools(tools: Tool[] | undefined): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

function firstExtractedText(...values: unknown[]): string | undefined {
	for (const value of values) {
		const text = extractText(value, false).trim();
		if (text) return text;
	}
	return undefined;
}

function extractText(value: unknown, allowFallback = true): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	if (Array.isArray(value)) return value.map((item) => extractText(item, allowFallback)).filter(Boolean).join("\n");
	if (typeof value !== "object") return allowFallback ? String(value) : "";

	const object = value as Record<string, unknown>;

	const choices = object.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		return choices
			.map((choice) => {
				const c = choice as Record<string, unknown>;
				return extractText((c.message as Record<string, unknown> | undefined)?.content ?? c.text ?? c.delta);
			})
			.filter(Boolean)
			.join("\n");
	}

	const direct = firstExtractedText(object.text, object.response, object.generated_text, object.output_text, object.content);
	if (direct) return direct;

	return allowFallback ? JSON.stringify(value, null, 2) : "";
}

function extractUsage(value: unknown): { input?: number; output?: number; total?: number } {
	if (!value || typeof value !== "object") return {};
	const usage = (value as Record<string, unknown>).usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return {};
	const input = Number(usage.prompt_tokens ?? usage.input_tokens);
	const output = Number(usage.completion_tokens ?? usage.output_tokens);
	const total = Number(usage.total_tokens);
	return {
		input: Number.isFinite(input) ? input : undefined,
		output: Number.isFinite(output) ? output : undefined,
		total: Number.isFinite(total) ? total : undefined,
	};
}

function parseToolArguments(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function normalizeToolCall(value: unknown, index: number): ToolCall | undefined {
	if (!value || typeof value !== "object") return undefined;
	const object = value as Record<string, unknown>;
	const fn = object.function as Record<string, unknown> | undefined;
	const name = typeof fn?.name === "string" ? fn.name : typeof object.name === "string" ? object.name : undefined;
	if (!name) return undefined;
	return {
		type: "toolCall",
		id: typeof object.id === "string" && object.id ? object.id : `call_${Date.now()}_${index}`,
		name,
		arguments: parseToolArguments(fn?.arguments ?? object.arguments ?? object.args),
	};
}

function firstOpenAIChoice(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const choices = (value as Record<string, unknown>).choices;
	if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") return choices[0] as Record<string, unknown>;
	return undefined;
}

function extractToolCalls(value: unknown): ToolCall[] {
	const choice = firstOpenAIChoice(value);
	const message = (choice?.message ?? choice?.delta) as Record<string, unknown> | undefined;
	const rawToolCalls = message && typeof message === "object" ? (message.tool_calls ?? message.toolCalls) : undefined;
	if (!Array.isArray(rawToolCalls)) return [];
	return rawToolCalls.map(normalizeToolCall).filter((call): call is ToolCall => Boolean(call));
}

function parseToolCallsFromText(text: string): ToolCall[] {
	const candidates: string[] = [];
	const trimmed = text.trim();
	if (trimmed) candidates.push(trimmed);

	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		if (match[1]?.trim()) candidates.push(match[1].trim());
	}
	for (const match of text.matchAll(/<tool_calls?>\s*([\s\S]*?)\s*<\/tool_calls?>/gi)) {
		if (match[1]?.trim()) candidates.push(match[1].trim());
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as unknown;
			const raw = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
			const calls = Array.isArray(raw?.tool_calls)
				? raw.tool_calls
				: Array.isArray(raw?.toolCalls)
					? raw.toolCalls
					: raw?.name
						? [raw]
						: undefined;
			if (calls) {
				return calls.map(normalizeToolCall).filter((call): call is ToolCall => Boolean(call));
			}
		} catch {}
	}

	return [];
}

function extractAssistantText(value: unknown, includeReasoningFallback = true): string {
	const choice = firstOpenAIChoice(value);
	const message = (choice?.message ?? choice?.delta) as Record<string, unknown> | undefined;
	if (message && typeof message === "object") {
		const content = extractText(message.content, false).trim();
		if (content) return content;
		// Non-reasoning models (Kimi/Qwen) sometimes emit everything in reasoning_content;
		// treat that as text. Reasoning models surface reasoning_content separately instead
		// (see extractReasoning + the thinking blocks in the stream handler).
		return includeReasoningFallback ? extractText(message.reasoning_content, false).trim() : "";
	}
	return extractText(value).trim();
}

function extractReasoning(value: unknown): string {
	const choice = firstOpenAIChoice(value);
	const message = (choice?.message ?? choice?.delta) as Record<string, unknown> | undefined;
	if (message && typeof message === "object") {
		return extractText(message.reasoning_content, false).trim();
	}
	return "";
}

function readLegacyModelsJson(): Record<string, unknown> | undefined {
	const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const path = join(configDir, "models.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function getLegacyProviderField<T>(field: string): T | undefined {
	const config = readLegacyModelsJson();
	const providers = config?.providers as Record<string, Record<string, unknown>> | undefined;
	return providers?.["runpod-llm"]?.[field] as T | undefined;
}

function getLegacyModelField<T>(modelId: string, field: string): T | undefined {
	const models = getLegacyProviderField<Array<Record<string, unknown>>>("models");
	if (!Array.isArray(models)) return undefined;
	const entry = models.find((m) => (m as { id?: unknown }).id === modelId);
	return entry?.[field] as T | undefined;
}

function getProviderBaseUrl(): string {
	const url = getLegacyProviderField<string>("baseUrl");
	if (!url) {
		throw new Error(
			'runpod-llm: missing baseUrl. Set providers["runpod-llm"].baseUrl in ~/.pi/agent/models.json.',
		);
	}
	return url;
}

function getApiKeyConfig(): string {
	// Prefer an env var; fall back to whatever apiKey is set in models.json.
	return process.env.RUNPOD_LITELLM_API_KEY ? "RUNPOD_LITELLM_API_KEY" : getLegacyProviderField<string>("apiKey") ?? "RUNPOD_LITELLM_API_KEY";
}

function getHeaderConfig(): Record<string, string> | undefined {
	const headers = getLegacyProviderField<Record<string, string>>("headers") ?? {};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function debugLog(entry: Record<string, unknown>) {
	if (!process.env.RUNPOD_KIMI_DEBUG) return;
	const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	appendFileSync(join(configDir, "runpod-llm-debug.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
}

function defaultToolChoice(_context: Context): "auto" | "required" {
	// "auto" lets the model choose to call a tool OR stop and answer with text.
	// Forcing "required" after a bash/read result traps the model: it can never
	// terminate a turn with a plain answer, so it emits endless no-op bash calls.
	// Override with RUNPOD_KIMI_TOOL_CHOICE if a specific value is needed.
	return "auto";
}

function buildRequestBody(model: Model<Api>, context: Context, options: SimpleStreamOptions | undefined) {
	const maxTokens = Math.min(options?.maxTokens ?? DEFAULT_MAX_TOKENS, model.maxTokens ?? DEFAULT_MAX_TOKENS);
	const tools = convertTools(context.tools);
	const toolChoice = process.env.RUNPOD_KIMI_TOOL_CHOICE ?? defaultToolChoice(context);
	// Thinking is driven by the caller's requested level. pi passes options.reasoning
	// from the session thinking level (--thinking / defaultThinkingLevel) and leaves it
	// undefined when the level is "off".
	const reasoningEnabled = model.reasoning === true;
	const thinkingLevel = options?.reasoning; // "minimal"|"low"|"medium"|"high"|"xhigh" | undefined
	// vLLM/SGLang chat-template models (Kimi/Qwen) toggle thinking via
	// chat_template_kwargs.enable_thinking; native reasoning models (DeepSeek) think
	// by default and only take reasoning_effort.
	const chatTemplateThinking = CHAT_TEMPLATE_THINKING_MODELS.has(model.id);

	const body: Record<string, Json> = {
		model: model.id,
		messages: convertMessages(context) as unknown as Json,
		max_tokens: maxTokens,
		stream: false,
	};
	if (tools) {
		body.tools = tools as unknown as Json;
		body.tool_choice = toolChoice;
	}
	if (process.env.RUNPOD_TEMPERATURE) body.temperature = Number(process.env.RUNPOD_TEMPERATURE);
	if (process.env.RUNPOD_TOP_P) body.top_p = Number(process.env.RUNPOD_TOP_P);
	if (process.env.RUNPOD_TOP_K) body.top_k = Number(process.env.RUNPOD_TOP_K);
	if (chatTemplateThinking) {
		// Kimi/Qwen: explicit thinking toggle plus effort, forwarded through LiteLLM to
		// the underlying vLLM/SGLang worker.
		if (thinkingLevel) {
			body.chat_template_kwargs = { enable_thinking: true };
			body.reasoning_effort = thinkingLevel;
		} else {
			body.chat_template_kwargs = { enable_thinking: false };
			body.reasoning_effort = "none";
		}
	} else if (reasoningEnabled) {
		// Native reasoning models (e.g. DeepSeek) think by default; forward the requested effort when set.
		if (thinkingLevel) body.reasoning_effort = thinkingLevel;
	}
	return body;
}

function streamRunpodLiteLLM(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) throw new Error("Missing RunPod LiteLLM API key. Set RUNPOD_LITELLM_API_KEY, or configure this provider with an apiKey.");

			stream.push({ type: "start", partial: output });

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
				...(options?.headers ?? {}),
			};

			const baseUrl = (model.baseUrl || getProviderBaseUrl()).replace(/\/+$/, "");
			const url = `${baseUrl}/chat/completions`;
			const requestBody = buildRequestBody(model, context, options);
			debugLog({ phase: "request", url, body: requestBody });

			const response = await fetch(url, {
				method: "POST",
				headers,
				signal: options?.signal,
				body: JSON.stringify(requestBody),
			});

			const rawText = await response.text();
			let payload: unknown = rawText;
			try {
				payload = JSON.parse(rawText);
			} catch {}

			if (!response.ok) {
				throw new Error(`RunPod LiteLLM ${response.status} ${response.statusText}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
			}

			let text = extractAssistantText(payload, !model.reasoning);
			const reasoning = model.reasoning ? extractReasoning(payload) : "";
			let toolCalls = extractToolCalls(payload);
			if (toolCalls.length === 0) {
				toolCalls = parseToolCallsFromText(text);
				if (toolCalls.length > 0) text = "";
			}
			debugLog({ phase: "response", payload, extractedReasoning: reasoning, extractedText: text, extractedToolCalls: toolCalls });

			const usage = extractUsage(payload);
			output.usage.input = usage.input ?? 0;
			output.usage.output = usage.output ?? 0;
			output.usage.totalTokens = usage.total ?? output.usage.input + output.usage.output;
			output.stopReason = toolCalls.length > 0 ? "toolUse" : "stop";
			calculateCost(model, output.usage);

			if (reasoning) {
				const contentIndex = output.content.length;
				output.content.push({ type: "thinking", thinking: "" });
				stream.push({ type: "thinking_start", contentIndex, partial: output });
				output.content[contentIndex] = { type: "thinking", thinking: reasoning };
				stream.push({ type: "thinking_delta", contentIndex, delta: reasoning, partial: output });
				stream.push({ type: "thinking_end", contentIndex, content: reasoning, partial: output });
			}

			if (text) {
				const contentIndex = output.content.length;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex, partial: output });
				output.content[contentIndex] = { type: "text", text };
				stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex, content: text, partial: output });
			}

			for (const toolCall of toolCalls) {
				const contentIndex = output.content.length;
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	const providerBaseUrl = getLegacyProviderField<string>("baseUrl");
	if (!providerBaseUrl) {
		throw new Error(
			'runpod-llm: missing baseUrl. Set providers["runpod-llm"].baseUrl in ~/.pi/agent/models.json.',
		);
	}

	pi.registerProvider("runpod-llm", {
		name: "runpod-llm",
		baseUrl: providerBaseUrl,
		apiKey: getApiKeyConfig(),
		headers: getHeaderConfig(),
		api: "openai-compatible",
		models: [
			{
				id: "moonshotai/Kimi-K3",
				name: "Kimi K3 (RunPod)",
				baseUrl: getLegacyModelField<string>("moonshotai/Kimi-K3", "baseUrl"),
				reasoning: true,
				input: ["text"],
				contextWindow: 430_000,
				maxTokens: 65_536,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "qwen/qwen3.8-27b-fp8",
				name: "Qwen 3.8 27B FP8 (RunPod)",
				baseUrl: getLegacyModelField<string>("qwen/qwen3.8-27b-fp8", "baseUrl"),
				reasoning: true,
				input: ["text"],
				contextWindow: 262_144,
				maxTokens: 65_536,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "deepseek-ai/DeepSeek-V4.1-Flash",
				name: "DeepSeek V4.1 Flash (RunPod)",
				baseUrl: getLegacyModelField<string>("deepseek-ai/DeepSeek-V4.1-Flash", "baseUrl"),
				reasoning: true,
				input: ["text"],
				contextWindow: 262_144,
				maxTokens: 65_536,
				// pi-ai cost is per 1M tokens (models.js: cost / 1_000_000 * tokens).
				// Proxy per-token rates → per-1M: 4e-8→0.04, 4e-7→0.4, 6e-9→0.006.
				cost: { input: 0.04, output: 0.4, cacheRead: 0.006, cacheWrite: 0 },
			},
		],
		streamSimple: streamRunpodLiteLLM,
	});
}
