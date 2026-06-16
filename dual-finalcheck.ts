import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";

/**
 * Dual Finalcheck
 * ===============
 *
 * Runs the `finalcheck` skill in parallel with two reviewer models, then asks a
 * consolidator model to merge their findings into a single deduplicated list.
 *
 * This extension intentionally does NOT run `git fetch` or `git rebase` — the
 * caller is expected to have prepared the branch first. It also does not run
 * tests, lint, type-checks, or formatters; those are the pre-push script's job.
 *
 * --------------------------------------------------------------------------
 * Roles
 * --------------------------------------------------------------------------
 *
 *   Reviewer A  —  anthropic/claude-opus-4-7   (default)
 *                  Runs the finalcheck skill independently. Writes findingsA.md
 *                  with findings numbered A1, A2, A3, ...
 *
 *   Reviewer B  —  openai-codex/gpt-5.5        (default)
 *                  Runs the finalcheck skill independently in parallel with A.
 *                  Writes findingsB.md with findings numbered B1, B2, B3, ...
 *
 *   Fallback B  —  anthropic/claude-opus-4-6:xhigh   (default)
 *                  If reviewer B fails (rate limit, API error, etc.) and the
 *                  run was not user-cancelled, B is automatically retried in
 *                  place with the fallback model + thinking level. Reviewer A
 *                  is NOT re-run — its output is preserved. The original
 *                  failure is recorded under "previous attempts" in the
 *                  rendered tool row.
 *
 *   Consolidator C — same model as reviewer A by default
 *                  Reads findingsA.md and findingsB.md, deduplicates, splits
 *                  compound findings, preserves provenance (A1, B3, ...), and
 *                  writes findingsC.md with findings numbered C1, C2, C3, ...
 *
 * --------------------------------------------------------------------------
 * Output files
 * --------------------------------------------------------------------------
 *
 * All paths below are relative to `--out-dir` (default: the directory you
 * launched pi from, i.e. the parent pi process's cwd).
 *
 *   findingsA.md                  Reviewer A output (A1, A2, ...)
 *   findingsB.md                  Reviewer B output (B1, B2, ...)
 *   findingsC.md                  Consolidated output (C1, C2, ...)
 *
 * Debug mode (on by default; disable with --no-debug):
 *
 *   .dual-finalcheck-A.jsonl      Raw JSON event stream from reviewer A
 *   .dual-finalcheck-B.jsonl      Raw JSON event stream from reviewer B
 *   .dual-finalcheck-B-retry.jsonl  Raw JSON event stream from the B fallback,
 *                                  only present if the primary B failed
 *   .dual-finalcheck-C.jsonl      Raw JSON event stream from the consolidator
 *
 * Inspect a debug log with, e.g., `jq -c 'select(.type=="message_end")' .dual-finalcheck-A.jsonl`.
 *
 * --------------------------------------------------------------------------
 * Command: /dual-finalcheck
 * --------------------------------------------------------------------------
 *
 * Thin shim that nudges the active LLM to call the `dual_finalcheck` tool.
 * Registering the workhorse as a tool (rather than running spawn directly from
 * the command) is what gives us live tool-row streaming, ctrl+O expansion,
 * reasoning visibility, and per-reviewer error rendering for free.
 *
 * Usage:
 *   /dual-finalcheck                                     run with all defaults
 *   /dual-finalcheck --out-dir .pi/finalcheck            put all output under that directory
 *   /dual-finalcheck --base develop                      diff against 'develop' instead of 'main'
 *   /dual-finalcheck --base v1.2.0                       diff against a tag or commit SHA
 *   /dual-finalcheck --anthropic anthropic/claude-opus-4-7
 *   /dual-finalcheck --gpt openai-codex/gpt-5.5
 *   /dual-finalcheck --fallback-b anthropic/claude-opus-4-7:high
 *   /dual-finalcheck --no-fallback                       fail rather than retrying B
 *   /dual-finalcheck --consolidator anthropic/claude-opus-4-7
 *   /dual-finalcheck --no-resume                         force a clean run; ignore any existing findingsA.md / findingsB.md
 *   /dual-finalcheck --no-debug                          do not write the .dual-finalcheck-*.jsonl event streams
 *   /dual-finalcheck --debug                             (default) write the .dual-finalcheck-*.jsonl event streams
 *
 * Model spec format: `provider/id` or `provider/id:thinkingLevel`, where
 * thinkingLevel is one of: off | minimal | low | medium | high | xhigh.
 *
 * --------------------------------------------------------------------------
 * Flags in detail
 * --------------------------------------------------------------------------
 *
 *   --out-dir <path>
 *     Where to write findingsA.md / findingsB.md / findingsC.md, plus the
 *     debug .jsonl files when debug mode is on. Defaults to the parent pi's
 *     cwd. Both relative (resolved against parent cwd) and absolute paths
 *     are accepted. The directory is created if it does not exist.
 *
 *   --base <ref>
 *     Git base ref to diff against. The reviewed range is
 *     merge-base(HEAD, base)..HEAD. Accepts a branch name, tag, or commit
 *     SHA. For each, `origin/<ref>` is tried first, then `<ref>` directly.
 *     Default: main.
 *
 *   --anthropic <spec>
 *     Override reviewer A. Default: anthropic/claude-opus-4-7
 *
 *   --gpt <spec>
 *     Override reviewer B. Default: openai-codex/gpt-5.5
 *
 *   --fallback-b <spec>
 *     Override the fallback model used when reviewer B fails. Default:
 *     anthropic/claude-opus-4-6:xhigh
 *
 *   --no-fallback
 *     Disable the B fallback entirely. If B fails, the whole run fails.
 *
 *   --consolidator <spec>
 *     Override the consolidator model. Defaults to whatever --anthropic
 *     resolves to.
 *
 *   --resume / --no-resume
 *     Resume mode is ON by default. With resume on, if findingsA.md (or B)
 *     already exists and is non-empty in --out-dir, that reviewer is treated
 *     as already complete and is NOT re-run. This prevents redoing work when
 *     the tool is invoked a second time. Use --no-resume to force a fresh run.
 *
 *   --debug / --no-debug
 *     Debug mode is ON by default. It writes one .jsonl file per child
 *     subprocess, containing the raw JSON event stream from `pi --mode json`.
 *     Useful for inspecting reasoning blocks, tool calls, and stop reasons
 *     after the fact. Use --no-debug to skip writing those files.
 *
 * --------------------------------------------------------------------------
 * Child process integration
 * --------------------------------------------------------------------------
 *
 * Each reviewer / consolidator runs in a separate `pi --mode json -p
 * --no-session` subprocess so its context is isolated. The same extension is
 * loaded inside that subprocess; it detects child mode via the
 * PI_DUAL_FINALCHECK_OUTPUT environment variable and:
 *
 *   - Registers only the restricted `write_finalcheck_findings` tool, which
 *     writes to the assigned output file and nothing else.
 *   - Scopes the active toolset (read + bash + grep + find + ls + mcp +
 *     writer for reviewers; read + writer for the consolidator).
 *   - Appends a hard safety policy to the system prompt: no source edits,
 *     no tests/lint/builds, no git fetch/rebase, single writer call.
 *
 * --------------------------------------------------------------------------
 * Failure modes
 * --------------------------------------------------------------------------
 *
 *   - If reviewer A fails: the run aborts; the LLM is told what failed.
 *     Reviewer A is not auto-retried (only B has a configured fallback).
 *   - If reviewer B fails AND fallback is enabled AND the run was not
 *     cancelled: B is retried once with the fallback model. The original
 *     failure stays visible in the rendered "previous attempts" section.
 *   - If reviewer B still fails (or fallback was disabled): the run aborts.
 *   - If the consolidator fails: the run aborts; findingsA.md and
 *     findingsB.md remain on disk for inspection.
 *
 * In every failure case, any debug .jsonl files already written remain on
 * disk for post-mortem.
 */

type ModelRef = { provider: string; model: string };
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ModelSpec = { ref: ModelRef; thinking?: ThinkingLevel };

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type ToolCallEntry = { name: string; args: Record<string, any> };

type ReviewerStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

interface AttemptSummary {
	model: string;
	status: ReviewerStatus;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	stderrTail: string;
	toolCallsCount: number;
}

interface ReviewerState {
	label: "A" | "B" | "C";
	role: "reviewer" | "consolidator";
	model: string;
	thinkingLevel?: ThinkingLevel;
	outputPath: string;
	status: ReviewerStatus;
	skipped: boolean;
	toolCalls: ToolCallEntry[];
	assistantTexts: string[];
	thinkingTexts: string[];
	liveText: string;
	liveThinking: string;
	finalText: string;
	fileWritten: boolean;
	exitCode?: number;
	stopReason?: string;
	errorMessage?: string;
	stderrTail: string;
	usage: UsageStats;
	previousAttempts: AttemptSummary[];
}

interface GitMetadata {
	baseSha: string;
	headSha: string;
	stat: string;
	log: string;
	status: string;
}

interface DualFinalcheckDetails {
	phase: "preparing" | "reviewing" | "consolidating" | "done" | "failed";
	baseSha: string;
	headSha: string;
	outDir: string;
	paths: { a: string; b: string; c: string };
	reviewerA: ReviewerState;
	reviewerB: ReviewerState;
	consolidator: ReviewerState;
	error?: string;
	finalcheckSkillPath?: string;
}

const DEFAULT_ANTHROPIC: ModelRef = { provider: "anthropic", model: "claude-opus-4-7" };
const DEFAULT_GPT: ModelRef = { provider: "openai-codex", model: "gpt-5.5" };
const WRITER_TOOL = "write_finalcheck_findings";
const CHILD_OUTPUT_ENV = "PI_DUAL_FINALCHECK_OUTPUT";
const CHILD_MODE_ENV = "PI_DUAL_FINALCHECK_MODE";

const STDERR_TAIL_LIMIT = 4000;
const LIVE_TEXT_TAIL = 800;
const COLLAPSED_TOOL_LIMIT = 6;
const COLLAPSED_TEXT_LINES = 4;
const UPDATE_THROTTLE_MS = 150;

// --- helpers ---------------------------------------------------------------

function modelKey(ref: ModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

function parseModelRef(value: string): ModelRef {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`Invalid model '${value}'. Expected provider/model`);
	}
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function parseModelSpec(value: string | undefined, fallback?: ModelSpec): ModelSpec {
	if (!value) {
		if (!fallback) throw new Error("parseModelSpec: value required when no fallback");
		return fallback;
	}
	const lastColon = value.lastIndexOf(":");
	const firstSlash = value.indexOf("/");
	if (lastColon > firstSlash && lastColon > 0) {
		const level = value.slice(lastColon + 1) as ThinkingLevel;
		if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
			throw new Error(`Invalid thinking level '${level}' in '${value}'. Use off|minimal|low|medium|high|xhigh.`);
		}
		return { ref: parseModelRef(value.slice(0, lastColon)), thinking: level };
	}
	return { ref: parseModelRef(value) };
}

function formatSpec(spec: ModelSpec): string {
	return spec.thinking ? `${modelKey(spec.ref)}:${spec.thinking}` : modelKey(spec.ref);
}

function formatTokens(count: number): string {
	if (!count) return "0";
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	return parts.join(" ");
}

function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatToolCall(entry: ToolCallEntry, themeFg: (color: any, text: string) => string): string {
	const { name, args } = entry;
	const a = (args ?? {}) as Record<string, any>;
	switch (name) {
		case "bash": {
			const cmd = String(a.command ?? "...");
			const preview = cmd.length > 70 ? `${cmd.slice(0, 70)}...` : cmd;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const raw = String(a.file_path ?? a.path ?? "...");
			const filePath = shortenPath(raw);
			const offset = typeof a.offset === "number" ? a.offset : undefined;
			const limit = typeof a.limit === "number" ? a.limit : undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "grep": {
			const pattern = String(a.pattern ?? "");
			const raw = String(a.path ?? ".");
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(raw)}`)
			);
		}
		case "find": {
			const pattern = String(a.pattern ?? "*");
			const raw = String(a.path ?? ".");
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(raw)}`);
		}
		case "ls": {
			const raw = String(a.path ?? ".");
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(raw));
		}
		case WRITER_TOOL: {
			const content = typeof a.content === "string" ? a.content : "";
			const lines = content ? content.split("\n").length : 0;
			return (
				themeFg("muted", "write ") +
				themeFg("accent", "findings") +
				(lines ? themeFg("dim", ` (${lines} lines)`) : "")
			);
		}
		default: {
			const argsStr = JSON.stringify(args ?? {});
			const preview = argsStr.length > 60 ? `${argsStr.slice(0, 60)}...` : argsStr;
			return themeFg("accent", name) + themeFg("dim", ` ${preview}`);
		}
	}
}

// --- git + skill discovery -------------------------------------------------

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function runProcess(
	command: string,
	args: string[],
	options: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolveProc) => {
		const proc = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			resolveProc({ code, stdout, stderr });
		};
		proc.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		proc.on("close", (code) => finish(code ?? 0));
		proc.on("error", (err) => {
			stderr += `${err instanceof Error ? err.message : String(err)}\n`;
			finish(1);
		});
		const abort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref?.();
		};
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
	});
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await runProcess("git", args, { cwd, signal });
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout.trim();
}

async function collectGitMetadata(cwd: string, base: string, signal?: AbortSignal): Promise<GitMetadata> {
	let baseSha: string;
	try {
		baseSha = await git(cwd, ["merge-base", "HEAD", `origin/${base}`], signal);
	} catch {
		baseSha = await git(cwd, ["merge-base", "HEAD", base], signal);
	}
	const headSha = await git(cwd, ["rev-parse", "HEAD"], signal);
	const stat = await git(cwd, ["diff", "--stat", baseSha, headSha], signal);
	const log = await git(cwd, ["log", `${baseSha}..${headSha}`, "--oneline"], signal);
	const status = await git(cwd, ["status", "--porcelain"], signal);
	return { baseSha, headSha, stat, log, status };
}

function findFinalcheckSkill(cwd: string): string | undefined {
	const candidates = [
		join(cwd, ".pi", "skills", "finalcheck", "SKILL.md"),
		join(cwd, ".agents", "skills", "finalcheck", "SKILL.md"),
		join(getAgentDir(), "skills", "finalcheck", "SKILL.md"),
		join(homedir(), ".agents", "skills", "finalcheck", "SKILL.md"),
		join(homedir(), ".claude", "skills", "finalcheck", "SKILL.md"),
		join(homedir(), ".codex", "skills", "finalcheck", "SKILL.md"),
	];
	return candidates.find((path) => existsSync(path));
}

async function readFinalcheckSkill(cwd: string): Promise<{ path: string; content: string }> {
	const path = findFinalcheckSkill(cwd);
	if (!path) throw new Error("Could not find the finalcheck skill (looked under .pi/skills, .agents/skills, ~/.claude/skills, ~/.codex/skills).");
	return { path, content: await readFile(path, "utf8") };
}

// --- prompts ---------------------------------------------------------------

function buildReviewPrompt(params: {
	label: "A" | "B";
	modelLabel: string;
	outputPath: string;
	git: GitMetadata;
	finalcheckSkillPath: string;
	finalcheckSkillContent: string;
}): string {
	const prefix = params.label;
	return `You are independent reviewer ${prefix} running the finalcheck skill in a parallel dual-review workflow.

Your assigned model: ${params.modelLabel}
Your assigned output file: ${params.outputPath}

You MUST follow the finalcheck skill content below, with the overrides in this prompt taking precedence.

<finalcheck_skill path="${params.finalcheckSkillPath}">
${params.finalcheckSkillContent}
</finalcheck_skill>

Overrides / workflow rules:
1. Do NOT run \`git fetch\`, \`git rebase\`, or any command that modifies git state. The user already prepared the branch. Skip finalcheck step 0 entirely.
2. Do NOT run tests, lint, type-check, formatters, or builds.
3. Do NOT delegate to code-review-local or any other subagent. You are already the isolated fresh reviewer. Perform the review inline.
4. Review the committed branch diff only: BASE_SHA=${params.git.baseSha}, HEAD_SHA=${params.git.headSha}. If the working tree status below is non-empty, mention that those uncommitted changes were not reviewed.
5. Use the context MCP if an MCP tool is available and relevant. If it is unavailable, continue and note that MCP context was unavailable.
6. Do not edit source code. The only write action allowed is calling ${WRITER_TOOL}, which writes your assigned findings file.
7. Once your findings markdown is complete, call ${WRITER_TOOL} exactly once with the full markdown content.

Git diff stat:
\`\`\`
${params.git.stat || "(no diff stat)"}
\`\`\`

Commits in range:
\`\`\`
${params.git.log || "(no commits in range)"}
\`\`\`

Working tree status at workflow start:
\`\`\`
${params.git.status || "(clean)"}
\`\`\`

Required markdown format for ${params.outputPath}:
# Finalcheck Findings ${prefix}

## Scope
- Reviewer: ${prefix}
- Model: ${params.modelLabel}
- Base: ${params.git.baseSha}
- Head: ${params.git.headSha}
- Note whether uncommitted changes were excluded.

## Findings

Number every finding as ${prefix}1, ${prefix}2, ${prefix}3, ... . For each finding include:
- Severity: Critical, Important, or Minor
- Summary
- Evidence: file path(s), line(s), or diff context
- Impact
- Recommendation

If there are no findings, write exactly: "No findings." under Findings.

## Verdict
State either "ready to push" or "fix-before-push" and list blocking ${prefix}-numbered items.`;
}

function buildConsolidationPrompt(params: {
	modelLabel: string;
	findingsAPath: string;
	findingsBPath: string;
	outputPath: string;
	git: GitMetadata;
}): string {
	return `You are the consolidation reviewer for a dual finalcheck workflow.

Your assigned model: ${params.modelLabel}
Input files:
- ${params.findingsAPath}
- ${params.findingsBPath}
Output file: ${params.outputPath}

Task:
1. Read both input files.
2. Consolidate their findings into one deduplicated list.
3. Deduplicate findings that describe the same underlying issue.
4. Split a source finding if it contains multiple independent issues.
5. Preserve provenance for each consolidated finding using source IDs like A1, A2, B1, B2.
6. Do not inspect code or run git commands unless absolutely necessary to resolve an ambiguity in the finding text. Prefer consolidating from the files only.
7. Do not edit source code. The only write action allowed is calling ${WRITER_TOOL}, which writes ${params.outputPath}.
8. Once the consolidated markdown is complete, call ${WRITER_TOOL} exactly once with the full markdown content.

Required markdown format for ${params.outputPath}:
# Consolidated Finalcheck Findings

## Scope
- Consolidator model: ${params.modelLabel}
- Base: ${params.git.baseSha}
- Head: ${params.git.headSha}
- Inputs: ${params.findingsAPath}, ${params.findingsBPath}

## Consolidated Findings

Number every consolidated finding as C1, C2, C3, ... . For each finding include:
- Severity: Critical, Important, or Minor
- Summary
- Sources: e.g. A1, B3
- Evidence
- Impact
- Recommendation
- Consolidation note: deduplicated, split from a source finding, severity adjusted, or unchanged

If there are no findings in either input, write exactly: "No findings." under Consolidated Findings.

## Verdict
State either "ready to push" or "fix-before-push" and list blocking C-numbered items.`;
}

// --- child streaming -------------------------------------------------------

function trimTail(s: string, limit: number): string {
	if (s.length <= limit) return s;
	return s.slice(s.length - limit);
}

function newReviewerState(
	label: ReviewerState["label"],
	role: ReviewerState["role"],
	spec: ModelSpec,
	outputPath: string,
): ReviewerState {
	return {
		label,
		role,
		model: modelKey(spec.ref),
		thinkingLevel: spec.thinking,
		outputPath,
		status: "pending",
		skipped: false,
		toolCalls: [],
		assistantTexts: [],
		thinkingTexts: [],
		liveText: "",
		liveThinking: "",
		finalText: "",
		fileWritten: false,
		stderrTail: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		previousAttempts: [],
	};
}

function attemptFromState(state: ReviewerState): AttemptSummary {
	return {
		model: state.thinkingLevel ? `${state.model}:${state.thinkingLevel}` : state.model,
		status: state.status,
		exitCode: state.exitCode,
		stopReason: state.stopReason,
		errorMessage: state.errorMessage,
		stderrTail: state.stderrTail,
		toolCallsCount: state.toolCalls.length,
	};
}

function resetReviewerForRetry(state: ReviewerState, spec: ModelSpec): void {
	state.previousAttempts.push(attemptFromState(state));
	state.model = modelKey(spec.ref);
	state.thinkingLevel = spec.thinking;
	state.status = "pending";
	state.skipped = false;
	state.toolCalls = [];
	state.assistantTexts = [];
	state.thinkingTexts = [];
	state.liveText = "";
	state.liveThinking = "";
	state.finalText = "";
	state.fileWritten = false;
	state.stderrTail = "";
	state.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	state.exitCode = undefined;
	state.stopReason = undefined;
	state.errorMessage = undefined;
}

function handleStreamEvent(state: ReviewerState, event: any): void {
	if (!event || typeof event !== "object") return;
	const type = event.type;

	if (type === "message_start") {
		const msg = event.message;
		if (msg?.role === "assistant") {
			state.status = "running";
			state.liveText = "";
			state.liveThinking = "";
		}
		return;
	}

	if (type === "message_update") {
		const delta = event.assistantMessageEvent;
		if (!delta || typeof delta !== "object") return;
		if (delta.type === "text_delta" && typeof delta.delta === "string") {
			state.liveText = trimTail(state.liveText + delta.delta, LIVE_TEXT_TAIL);
		} else if (delta.type === "thinking_delta" && typeof delta.delta === "string") {
			state.liveThinking = trimTail(state.liveThinking + delta.delta, LIVE_TEXT_TAIL);
		} else if (delta.type === "thinking_end" && typeof delta.content === "string" && delta.content.trim()) {
			// Snapshot the complete thinking block into thinkingTexts so it survives after liveThinking is cleared.
			state.thinkingTexts.push(delta.content.trim());
			state.liveThinking = "";
		}
		return;
	}

	if (type === "message_end") {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		state.usage.turns += 1;
		const parts = Array.isArray(msg.content) ? msg.content : [];
		const textParts: string[] = [];
		const thinkingParts: string[] = [];
		for (const part of parts) {
			if (!part || typeof part !== "object") continue;
			if (part.type === "text" && typeof part.text === "string") {
				textParts.push(part.text);
			} else if (part.type === "toolCall") {
				state.toolCalls.push({
					name: typeof part.name === "string" ? part.name : "unknown",
					args: (part.arguments ?? {}) as Record<string, any>,
				});
			} else if (part.type === "thinking" && typeof part.thinking === "string") {
				// ThinkingContent uses { type: "thinking", thinking: string } per pi-ai.
				thinkingParts.push(part.thinking);
			}
		}
		if (thinkingParts.length > 0) {
			const combined = thinkingParts.join("\n\n").trim();
			if (combined && state.thinkingTexts[state.thinkingTexts.length - 1] !== combined) {
				state.thinkingTexts.push(combined);
			}
		} else if (state.liveThinking.trim()) {
			// Fallback: if no thinking content part in the finalized message, preserve any
			// accumulated streaming reasoning so the user can still inspect it later.
			state.thinkingTexts.push(state.liveThinking.trim());
		}
		if (textParts.length > 0) {
			const combined = textParts.join("\n").trim();
			if (combined) {
				state.assistantTexts.push(combined);
				state.finalText = combined;
			}
		}
		if (msg.usage && typeof msg.usage === "object") {
			const u = msg.usage as any;
			state.usage.input += Number(u.input) || 0;
			state.usage.output += Number(u.output) || 0;
			state.usage.cacheRead += Number(u.cacheRead) || 0;
			state.usage.cacheWrite += Number(u.cacheWrite) || 0;
			state.usage.cost += Number(u.cost?.total ?? u.cost) || 0;
			state.usage.contextTokens = Number(u.totalTokens) || state.usage.contextTokens;
		}
		if (typeof msg.stopReason === "string") state.stopReason = msg.stopReason;
		if (typeof msg.errorMessage === "string") state.errorMessage = msg.errorMessage;
		state.liveText = "";
		state.liveThinking = "";
		return;
	}

	if (type === "tool_execution_end") {
		if (event.toolName === WRITER_TOOL && !event.isError) {
			state.fileWritten = true;
		}
		return;
	}
}

async function runChild(params: {
	state: ReviewerState;
	cwd: string;
	model: ModelRef;
	thinking?: ThinkingLevel;
	mode: "review" | "consolidate";
	prompt: string;
	signal?: AbortSignal;
	onProgress: () => void;
	debugLogPath?: string;
}): Promise<void> {
	const modelArg = params.thinking ? `${modelKey(params.model)}:${params.thinking}` : modelKey(params.model);
	const args = ["--mode", "json", "-p", "--no-session", "--model", modelArg, params.prompt];
	const invocation = getPiInvocation(args);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[CHILD_OUTPUT_ENV]: params.state.outputPath,
		[CHILD_MODE_ENV]: params.mode,
	};

	let debugStream: import("node:fs").WriteStream | undefined;
	if (params.debugLogPath) {
		try {
			await mkdir(dirname(params.debugLogPath), { recursive: true });
			const fs = await import("node:fs");
			debugStream = fs.createWriteStream(params.debugLogPath, { flags: "w" });
		} catch {
			// non-fatal
		}
	}

	params.state.status = "running";
	params.onProgress();

	await new Promise<void>((resolveChild) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: params.cwd,
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			if (debugStream) {
				try {
					debugStream.write(`${line}\n`);
				} catch {
					// non-fatal
				}
			}
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			handleStreamEvent(params.state, event);
			params.onProgress();
		};

		proc.stdout.on("data", (d) => {
			const chunk = d.toString();
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (d) => {
			params.state.stderrTail = trimTail(params.state.stderrTail + d.toString(), STDERR_TAIL_LIMIT);
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			params.state.exitCode = code ?? 0;
			if (params.signal?.aborted) {
				params.state.status = "cancelled";
			} else if ((code ?? 0) === 0 && params.state.fileWritten) {
				params.state.status = "completed";
			} else {
				params.state.status = "failed";
			}
			try {
				debugStream?.end();
			} catch {
				// non-fatal
			}
			params.onProgress();
			resolveChild();
		});

		proc.on("error", (err) => {
			params.state.stderrTail = trimTail(
				params.state.stderrTail + `${err instanceof Error ? err.message : String(err)}\n`,
				STDERR_TAIL_LIMIT,
			);
		});

		const abort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000).unref?.();
		};
		if (params.signal?.aborted) abort();
		else params.signal?.addEventListener("abort", abort, { once: true });
	});
}

// --- rendering -------------------------------------------------------------

function statusIcon(theme: any, status: ReviewerStatus): string {
	switch (status) {
		case "pending":
			return theme.fg("muted", "·");
		case "running":
			return theme.fg("warning", "⏳");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("warning", "◐");
	}
}

function lastLines(text: string, n: number): string {
	if (!text) return "";
	const lines = text.split("\n");
	return lines.slice(-n).join("\n");
}

function describeReviewerModel(reviewer: ReviewerState): string {
	return reviewer.thinkingLevel ? `${reviewer.model}:${reviewer.thinkingLevel}` : reviewer.model;
}

function collectReasoningText(reviewer: ReviewerState): string {
	const pieces: string[] = [];
	for (const t of reviewer.thinkingTexts) {
		if (t && t.trim()) pieces.push(t.trim());
	}
	if (reviewer.liveThinking.trim()) pieces.push(reviewer.liveThinking.trim());
	return pieces.join("\n\n");
}

function renderReviewerCollapsed(reviewer: ReviewerState, theme: any, _cwd: string): string {
	const lines: string[] = [];
	const skippedTag = reviewer.skipped ? ` ${theme.fg("dim", "(resumed from existing file)")}` : "";
	const retryTag =
		reviewer.previousAttempts.length > 0
			? ` ${theme.fg("warning", `(fallback after ${reviewer.previousAttempts[0].model} ${reviewer.previousAttempts[0].status})`)}`
			: "";
	const header =
		statusIcon(theme, reviewer.status) +
		" " +
		theme.fg("toolTitle", theme.bold(`Reviewer ${reviewer.label}`)) +
		" " +
		theme.fg("muted", `(${describeReviewerModel(reviewer)})`) +
		skippedTag +
		retryTag;
	lines.push(header);
	lines.push("  " + theme.fg("dim", `→ ${reviewer.outputPath}`));

	const toolsToShow = reviewer.toolCalls.slice(-COLLAPSED_TOOL_LIMIT);
	const skipped = reviewer.toolCalls.length - toolsToShow.length;
	if (skipped > 0) lines.push("  " + theme.fg("muted", `... ${skipped} earlier tool calls`));
	for (const tc of toolsToShow) {
		lines.push("  " + theme.fg("muted", "→ ") + formatToolCall(tc, theme.fg.bind(theme)));
	}

	// Always show reasoning when present — live during streaming, persisted after.
	const reasoning = collectReasoningText(reviewer);
	if (reasoning) {
		const snippet = lastLines(reasoning, 3);
		lines.push("  " + theme.fg("muted", "reasoning: ") + theme.fg("dim", theme.italic(snippet)));
	}

	if (reviewer.status === "running" && reviewer.liveText.trim()) {
		const snippet = lastLines(reviewer.liveText.trim(), 3);
		lines.push("  " + theme.fg("toolOutput", snippet));
	}

	if (reviewer.status === "completed" && reviewer.finalText.trim()) {
		const snippet = lastLines(reviewer.finalText.trim(), COLLAPSED_TEXT_LINES);
		lines.push("  " + theme.fg("toolOutput", snippet));
	}

	if (reviewer.status === "failed" || reviewer.status === "cancelled") {
		const detail =
			reviewer.errorMessage ||
			(reviewer.stopReason ? `stopReason: ${reviewer.stopReason}` : undefined) ||
			(reviewer.stderrTail ? reviewer.stderrTail.trim().split("\n").slice(-3).join("\n") : undefined) ||
			`exit ${reviewer.exitCode ?? "?"}`;
		lines.push("  " + theme.fg("error", detail));
	}

	const usage = formatUsageStats(reviewer.usage);
	if (usage) lines.push("  " + theme.fg("dim", usage));

	return lines.join("\n");
}

function renderReviewerExpanded(container: Container, reviewer: ReviewerState, theme: any, _cwd: string, mdTheme: any): void {
	const skippedTag = reviewer.skipped ? ` ${theme.fg("dim", "(resumed from existing file)")}` : "";
	const retryTag =
		reviewer.previousAttempts.length > 0
			? ` ${theme.fg("warning", `(fallback after ${reviewer.previousAttempts[0].model})`)}`
			: "";
	const header =
		statusIcon(theme, reviewer.status) +
		" " +
		theme.fg("toolTitle", theme.bold(`Reviewer ${reviewer.label}`)) +
		" " +
		theme.fg("muted", `(${describeReviewerModel(reviewer)})`) +
		skippedTag +
		retryTag;
	container.addChild(new Text(header, 0, 0));
	container.addChild(new Text(theme.fg("dim", `output: ${reviewer.outputPath}`), 0, 0));

	if (reviewer.previousAttempts.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── previous attempts ───"), 0, 0));
		for (const att of reviewer.previousAttempts) {
			const desc = [
				att.model,
				att.status,
				att.stopReason ? `stop:${att.stopReason}` : undefined,
				att.exitCode !== undefined ? `exit:${att.exitCode}` : undefined,
				att.errorMessage ? `error:${att.errorMessage}` : undefined,
			]
				.filter(Boolean)
				.join("  ");
			container.addChild(new Text(theme.fg("warning", `• ${desc}`), 0, 0));
			if (att.stderrTail.trim()) {
				container.addChild(new Text(theme.fg("dim", att.stderrTail.trim().split("\n").slice(-4).join("\n")), 0, 0));
			}
		}
	}

	if (reviewer.toolCalls.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── tool calls ───"), 0, 0));
		for (const tc of reviewer.toolCalls) {
			container.addChild(
				new Text("  " + theme.fg("muted", "→ ") + formatToolCall(tc, theme.fg.bind(theme)), 0, 0),
			);
		}
	}

	const reasoning = collectReasoningText(reviewer);
	if (reasoning) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── reasoning ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", theme.italic(reasoning)), 0, 0));
	}

	if (reviewer.status === "running" && reviewer.liveText.trim()) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── live output ───"), 0, 0));
		container.addChild(new Text(theme.fg("toolOutput", reviewer.liveText.trim()), 0, 0));
	}

	if (reviewer.finalText.trim()) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── final assistant output ───"), 0, 0));
		container.addChild(new Markdown(reviewer.finalText.trim(), 0, 0, mdTheme));
	}

	if (reviewer.status === "failed" || reviewer.status === "cancelled") {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── failure ───"), 0, 0));
		if (reviewer.stopReason) container.addChild(new Text(theme.fg("error", `stopReason: ${reviewer.stopReason}`), 0, 0));
		if (reviewer.errorMessage) container.addChild(new Text(theme.fg("error", `error: ${reviewer.errorMessage}`), 0, 0));
		if (reviewer.stderrTail.trim()) {
			container.addChild(new Text(theme.fg("error", `stderr:\n${reviewer.stderrTail.trim()}`), 0, 0));
		}
		container.addChild(new Text(theme.fg("error", `exit code: ${reviewer.exitCode ?? "?"}`), 0, 0));
	}

	const usage = formatUsageStats(reviewer.usage);
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	}
}

function summarizePhase(theme: any, details: DualFinalcheckDetails): string {
	const phaseLabel: Record<DualFinalcheckDetails["phase"], string> = {
		preparing: "preparing",
		reviewing: "reviewing in parallel",
		consolidating: "consolidating",
		done: "done",
		failed: "failed",
	};
	const phase = theme.fg("accent", phaseLabel[details.phase]);
	const a = statusIcon(theme, details.reviewerA.status);
	const b = statusIcon(theme, details.reviewerB.status);
	const c = statusIcon(theme, details.consolidator.status);
	return `${theme.fg("toolTitle", theme.bold("dual_finalcheck"))} ${phase} — A ${a} • B ${b} • C ${c}`;
}

// --- main extension --------------------------------------------------------

export default function dualFinalcheck(pi: ExtensionAPI) {
	const childOutput = process.env[CHILD_OUTPUT_ENV];
	const childMode = process.env[CHILD_MODE_ENV] as "review" | "consolidate" | undefined;

	// --- child mode: register only the restricted writer tool --------------
	if (childOutput) {
		pi.registerTool({
			name: WRITER_TOOL,
			label: "Write Finalcheck Findings",
			description: `Write the finalcheck workflow output to the assigned file: ${childOutput}. This is the only permitted write in dual-finalcheck child runs.`,
			promptSnippet: "Write the final review or consolidation markdown to the assigned dual-finalcheck output file",
			promptGuidelines: [`Use ${WRITER_TOOL} exactly once when the final dual-finalcheck markdown is ready.`],
			parameters: Type.Object({
				content: Type.String({ description: "Complete markdown content to write to the assigned findings file" }),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const target = isAbsolute(childOutput) ? childOutput : resolve(ctx.cwd, childOutput);
				const content = params.content.endsWith("\n") ? params.content : `${params.content}\n`;
				await withFileMutationQueue(target, async () => {
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, content, "utf8");
				});
				return {
					content: [{ type: "text", text: `Wrote ${target}` }],
					details: { path: target, bytes: Buffer.byteLength(content, "utf8") },
					terminate: true,
				};
			},
		});

		const setChildTools = () => {
			const allTools = new Set(pi.getAllTools().map((tool) => tool.name));
			const desired =
				childMode === "consolidate"
					? ["read", WRITER_TOOL]
					: ["read", "bash", "grep", "find", "ls", "mcp", WRITER_TOOL];
			pi.setActiveTools(desired.filter((name) => name === WRITER_TOOL || allTools.has(name)));
		};

		pi.on("session_start", setChildTools);
		pi.on("before_agent_start", (event) => {
			setChildTools();
			return {
				systemPrompt: `${event.systemPrompt}\n\nDual-finalcheck child safety policy: do not edit source files; use only ${WRITER_TOOL} for the assigned findings file (${childOutput}); do not run tests, lint, type-checks, builds, git fetch, or git rebase.`,
			};
		});
		return;
	}

	// --- parent mode: register the dual_finalcheck tool + /command --------

	pi.registerTool({
		name: "dual_finalcheck",
		label: "Dual Finalcheck",
		description:
			"Run the finalcheck skill in parallel with two reviewer models, then ask a consolidator model to merge the findings. Writes findingsA.md, findingsB.md, and findingsC.md. Does not run git fetch/rebase.",
		promptSnippet: "Run finalcheck in parallel with two reviewer models and consolidate findings",
		promptGuidelines: [
			"Use dual_finalcheck when the user asks for a dual or parallel finalcheck, or types /dual-finalcheck. Invoke it immediately without asking clarifying questions.",
		],
		parameters: Type.Object({
			outDir: Type.Optional(
				Type.String({
					description:
						"Directory for findingsA.md, findingsB.md, findingsC.md. Defaults to the current working directory.",
				}),
			),
			base: Type.Optional(
				Type.String({
					description:
						"Git base ref to diff against. The reviewed range is merge-base(HEAD, base)..HEAD. Accepts a branch name, tag, or commit SHA. Default: main.",
				}),
			),
			anthropic: Type.Optional(
				Type.String({
					description:
						"Reviewer A model as provider/id, optionally with :thinkingLevel. Default: anthropic/claude-opus-4-7",
				}),
			),
			gpt: Type.Optional(
				Type.String({
					description:
						"Reviewer B model as provider/id, optionally with :thinkingLevel. Default: openai-codex/gpt-5.5",
				}),
			),
			fallbackB: Type.Optional(
				Type.String({
					description:
						"Fallback model for reviewer B as provider/id, optionally with :thinkingLevel. Used automatically if the primary B model fails. Default: anthropic/claude-opus-4-6:xhigh. Pass empty string to disable.",
				}),
			),
			consolidator: Type.Optional(
				Type.String({
					description:
						"Consolidator C model as provider/id, optionally with :thinkingLevel. Defaults to the Anthropic reviewer model.",
				}),
			),
			resume: Type.Optional(
				Type.Boolean({
					description:
						"If true (default), skip reviewers whose findings file already exists and is non-empty. Set false to force a fresh run.",
				}),
			),
			debug: Type.Optional(
				Type.Boolean({
					description:
						"Write the raw JSON event stream from each child to <outDir>/.dual-finalcheck-{A,B,C}.jsonl for inspection. Default: true.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const specA = parseModelSpec(params.anthropic, { ref: DEFAULT_ANTHROPIC });
			const specB = parseModelSpec(params.gpt, { ref: DEFAULT_GPT });
			const defaultFallbackB: ModelSpec = { ref: { provider: "anthropic", model: "claude-opus-4-6" }, thinking: "xhigh" };
			const fallbackBRaw = params.fallbackB;
			const fallbackBSpec: ModelSpec | undefined =
				fallbackBRaw === "" ? undefined : parseModelSpec(fallbackBRaw, defaultFallbackB);
			const specC = parseModelSpec(params.consolidator, specA);
			const resume = params.resume !== false;
			const debug = params.debug !== false;
			const base = params.base && params.base.trim() ? params.base.trim() : "main";
			const outDir = params.outDir
				? isAbsolute(params.outDir)
					? params.outDir
					: resolve(ctx.cwd, params.outDir)
				: ctx.cwd;
			const findingsAPath = resolve(outDir, "findingsA.md");
			const findingsBPath = resolve(outDir, "findingsB.md");
			const findingsCPath = resolve(outDir, "findingsC.md");

			// Pre-validate models / auth (consolidator validated even when same as A; deduped)
			const seen = new Set<string>();
			const specsToCheck: ModelSpec[] = [specA, specB, specC];
			if (fallbackBSpec) specsToCheck.push(fallbackBSpec);
			for (const spec of specsToCheck) {
				const key = modelKey(spec.ref);
				if (seen.has(key)) continue;
				seen.add(key);
				const model = ctx.modelRegistry.find(spec.ref.provider, spec.ref.model);
				if (!model) throw new Error(`Model not found: ${key}`);
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok || !auth.apiKey) {
					throw new Error(auth.ok ? `No API key for ${key}` : `${key}: ${auth.error}`);
				}
			}

			const finalcheckSkill = await readFinalcheckSkill(ctx.cwd);
			await mkdir(outDir, { recursive: true });

			const aExists = existsSync(findingsAPath) && (await readFile(findingsAPath, "utf8").catch(() => "")).trim().length > 0;
			const bExists = existsSync(findingsBPath) && (await readFile(findingsBPath, "utf8").catch(() => "")).trim().length > 0;
			const skipA = resume && aExists;
			const skipB = resume && bExists;

			// Clean up findings files we plan to (re)generate.
			const toDelete: string[] = [];
			if (!skipA) toDelete.push(findingsAPath);
			if (!skipB) toDelete.push(findingsBPath);
			toDelete.push(findingsCPath); // always regenerate C
			await Promise.all(toDelete.map((p) => rm(p, { force: true })));

			const debugLog = (label: string) =>
				debug ? resolve(outDir, `.dual-finalcheck-${label}.jsonl`) : undefined;

			const details: DualFinalcheckDetails = {
				phase: "preparing",
				baseSha: "",
				headSha: "",
				outDir,
				paths: { a: findingsAPath, b: findingsBPath, c: findingsCPath },
				reviewerA: newReviewerState("A", "reviewer", specA, findingsAPath),
				reviewerB: newReviewerState("B", "reviewer", specB, findingsBPath),
				consolidator: newReviewerState("C", "consolidator", specC, findingsCPath),
				finalcheckSkillPath: finalcheckSkill.path,
			};

			if (skipA) {
				details.reviewerA.status = "completed";
				details.reviewerA.skipped = true;
				details.reviewerA.fileWritten = true;
			}
			if (skipB) {
				details.reviewerB.status = "completed";
				details.reviewerB.skipped = true;
				details.reviewerB.fileWritten = true;
			}

			let lastUpdate = 0;
			const headerText = () =>
				[
					`dual_finalcheck phase=${details.phase} A=${details.reviewerA.status} B=${details.reviewerB.status} C=${details.consolidator.status}`,
					`Output:`,
					`  A: ${findingsAPath}`,
					`  B: ${findingsBPath}`,
					`  C: ${findingsCPath}`,
				].join("\n");
			const emitNow = () => {
				onUpdate?.({
					content: [{ type: "text", text: headerText() }],
					details: { ...details } as any,
				});
			};
			const emit = (force = false) => {
				const now = Date.now();
				if (!force && now - lastUpdate < UPDATE_THROTTLE_MS) return;
				lastUpdate = now;
				emitNow();
			};

			if (ctx.hasUI) {
				ctx.ui.notify(
					`dual_finalcheck → ${findingsAPath}, ${findingsBPath}, ${findingsCPath}`,
					"info",
				);
			}

			emit(true);

			const gitMeta = await collectGitMetadata(ctx.cwd, base, signal);
			details.baseSha = gitMeta.baseSha;
			details.headSha = gitMeta.headSha;
			details.phase = "reviewing";
			emit(true);

			const makeReviewPrompt = (label: "A" | "B", spec: ModelSpec, outputPath: string) =>
				buildReviewPrompt({
					label,
					modelLabel: formatSpec(spec),
					outputPath,
					git: gitMeta,
					finalcheckSkillPath: finalcheckSkill.path,
					finalcheckSkillContent: finalcheckSkill.content,
				});

			const tasks: Promise<void>[] = [];
			if (!skipA) {
				tasks.push(
					runChild({
						state: details.reviewerA,
						cwd: ctx.cwd,
						model: specA.ref,
						thinking: specA.thinking,
						mode: "review",
						prompt: makeReviewPrompt("A", specA, findingsAPath),
						signal,
						onProgress: () => emit(),
						debugLogPath: debugLog("A"),
					}),
				);
			}
			if (!skipB) {
				tasks.push(
					runChild({
						state: details.reviewerB,
						cwd: ctx.cwd,
						model: specB.ref,
						thinking: specB.thinking,
						mode: "review",
						prompt: makeReviewPrompt("B", specB, findingsBPath),
						signal,
						onProgress: () => emit(),
						debugLogPath: debugLog("B"),
					}),
				);
			}
			if (tasks.length > 0) await Promise.all(tasks);
			emit(true);

			// Internal retry: if reviewer B failed and we have a fallback, run B again with the fallback.
			// Reviewer A is not retried — its prior output is preserved.
			if (
				details.reviewerB.status !== "completed" &&
				!signal?.aborted &&
				fallbackBSpec &&
				details.reviewerB.previousAttempts.length === 0
			) {
				resetReviewerForRetry(details.reviewerB, fallbackBSpec);
				emit(true);
				await runChild({
					state: details.reviewerB,
					cwd: ctx.cwd,
					model: fallbackBSpec.ref,
					thinking: fallbackBSpec.thinking,
					mode: "review",
					prompt: makeReviewPrompt("B", fallbackBSpec, findingsBPath),
					signal,
					onProgress: () => emit(),
					debugLogPath: debug ? resolve(outDir, `.dual-finalcheck-B-retry.jsonl`) : undefined,
				});
				emit(true);
			}

			if (details.reviewerA.status !== "completed" || details.reviewerB.status !== "completed") {
				details.phase = "failed";
				details.error = `Reviewer phase failed: A=${details.reviewerA.status}, B=${details.reviewerB.status}`;
				emit(true);
				return {
					content: [
						{
							type: "text",
							text: `${details.error}\nA file: ${findingsAPath}${existsSync(findingsAPath) ? " (written)" : " (missing)"}\nB file: ${findingsBPath}${existsSync(findingsBPath) ? " (written)" : " (missing)"}\nSee tool details (ctrl+O) for per-reviewer error info.`,
						},
					],
					details,
					isError: true,
				};
			}

			for (const [path, label] of [
				[findingsAPath, "Reviewer A"],
				[findingsBPath, "Reviewer B"],
			] as const) {
				if (!existsSync(path)) {
					details.phase = "failed";
					details.error = `${label} did not create ${path}`;
					emit(true);
					return {
						content: [{ type: "text", text: details.error }],
						details,
						isError: true,
					};
				}
			}

			details.phase = "consolidating";
			emit(true);

			const consolidationPrompt = buildConsolidationPrompt({
				modelLabel: formatSpec(specC),
				findingsAPath,
				findingsBPath,
				outputPath: findingsCPath,
				git: gitMeta,
			});
			await runChild({
				state: details.consolidator,
				cwd: ctx.cwd,
				model: specC.ref,
				thinking: specC.thinking,
				mode: "consolidate",
				prompt: consolidationPrompt,
				signal,
				onProgress: () => emit(),
				debugLogPath: debugLog("C"),
			});
			emit(true);

			if (details.consolidator.status !== "completed" || !existsSync(findingsCPath)) {
				details.phase = "failed";
				details.error = `Consolidator failed: status=${details.consolidator.status}`;
				emit(true);
				return {
					content: [{ type: "text", text: details.error }],
					details,
					isError: true,
				};
			}

			details.phase = "done";
			emit(true);

			const notes: string[] = [];
			if (details.reviewerA.skipped) notes.push("A: resumed from existing file (not re-run)");
			if (details.reviewerB.skipped) notes.push("B: resumed from existing file (not re-run)");
			if (details.reviewerB.previousAttempts.length > 0) {
				const prev = details.reviewerB.previousAttempts[0];
				notes.push(`B: retried after ${prev.model} ${prev.status} (${prev.stopReason ?? "no stopReason"})`);
			}

			const summary = [
				`Dual finalcheck complete.`,
				`Base: ${gitMeta.baseSha}`,
				`Head: ${gitMeta.headSha}`,
				`A: ${findingsAPath} (${describeReviewerModel(details.reviewerA)})`,
				`B: ${findingsBPath} (${describeReviewerModel(details.reviewerB)})`,
				`C: ${findingsCPath} (${describeReviewerModel(details.consolidator)})`,
				...(notes.length > 0 ? ["", "Notes:", ...notes.map((n) => `  - ${n}`)] : []),
			].join("\n");

			return {
				content: [{ type: "text", text: summary }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const a = args?.anthropic || modelKey(DEFAULT_ANTHROPIC);
			const b = args?.gpt || modelKey(DEFAULT_GPT);
			const fallbackB = args?.fallbackB === "" ? "(disabled)" : args?.fallbackB || "anthropic/claude-opus-4-6:xhigh";
			const c = args?.consolidator || a;
			const outDir = args?.outDir || "(cwd)";
			const base = args?.base || "main";
			let text = theme.fg("toolTitle", theme.bold("dual_finalcheck"));
			text += `\n  A: ${theme.fg("accent", a)}`;
			text += `\n  B: ${theme.fg("accent", b)} ${theme.fg("dim", `(fallback: ${fallbackB})`)}`;
			text += `\n  C: ${theme.fg("accent", c)}`;
			text += `\n  base: ${theme.fg("accent", base)}`;
			text += `\n  out: ${theme.fg("dim", outDir)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const details = (result.details ?? {}) as Partial<DualFinalcheckDetails>;
			const reviewerA = details.reviewerA ?? newReviewerState("A", "reviewer", { ref: DEFAULT_ANTHROPIC }, "");
			const reviewerB = details.reviewerB ?? newReviewerState("B", "reviewer", { ref: DEFAULT_GPT }, "");
			const consolidator = details.consolidator ?? newReviewerState("C", "consolidator", { ref: DEFAULT_ANTHROPIC }, "");
			const phase: DualFinalcheckDetails["phase"] = details.phase ?? "preparing";
			const cwd = context.cwd;
			const mdTheme = getMarkdownTheme();

			const fullDetails: DualFinalcheckDetails = {
				phase,
				baseSha: details.baseSha ?? "",
				headSha: details.headSha ?? "",
				outDir: details.outDir ?? cwd,
				paths: details.paths ?? { a: "", b: "", c: "" },
				reviewerA,
				reviewerB,
				consolidator,
				error: details.error,
				finalcheckSkillPath: details.finalcheckSkillPath,
			};

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(summarizePhase(theme, fullDetails), 0, 0));
				if (fullDetails.baseSha) {
					container.addChild(
						new Text(
							theme.fg("dim", `base=${fullDetails.baseSha}  head=${fullDetails.headSha}`),
							0,
							0,
						),
					);
				}
				if (fullDetails.error) {
					container.addChild(new Text(theme.fg("error", fullDetails.error), 0, 0));
				}

				for (const reviewer of [reviewerA, reviewerB, consolidator]) {
					container.addChild(new Spacer(1));
					renderReviewerExpanded(container, reviewer, theme, cwd, mdTheme);
				}
				return container;
			}

			// Collapsed view
			const lines: string[] = [];
			lines.push(summarizePhase(theme, fullDetails));
			if (fullDetails.baseSha) {
				lines.push(theme.fg("dim", `  base=${fullDetails.baseSha}  head=${fullDetails.headSha}`));
			}
			if (fullDetails.error) lines.push("  " + theme.fg("error", fullDetails.error));

			lines.push("");
			lines.push(renderReviewerCollapsed(reviewerA, theme, cwd));
			lines.push("");
			lines.push(renderReviewerCollapsed(reviewerB, theme, cwd));
			lines.push("");
			lines.push(renderReviewerCollapsed(consolidator, theme, cwd));

			if (!isPartial) lines.push("\n" + theme.fg("muted", "(Ctrl+O to expand for full transcripts and reasoning)"));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("dual-finalcheck", {
		description: "Run finalcheck in parallel with Anthropic Opus and GPT, then consolidate findings",
		handler: async (args, _ctx) => {
			const parsed = parseCommandArgs(args);
			const message = buildToolInvocationMessage(parsed);
			pi.sendUserMessage(message);
		},
	});
}

// --- /dual-finalcheck command helpers --------------------------------------

interface CommandArgs {
	outDir?: string;
	base?: string;
	anthropic?: string;
	gpt?: string;
	fallbackB?: string;
	consolidator?: string;
	resume?: boolean;
	debug?: boolean;
	noFallback?: boolean;
}

function parseCommandArgs(raw: string): CommandArgs {
	const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, "")) ?? [];
	const out: CommandArgs = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const readValue = (name: string) => {
			const value = tokens[++i];
			if (!value) throw new Error(`${name} requires a value`);
			return value;
		};
		if (token === "--out-dir") out.outDir = readValue(token);
		else if (token.startsWith("--out-dir=")) out.outDir = token.slice("--out-dir=".length);
		else if (token === "--base") out.base = readValue(token);
		else if (token.startsWith("--base=")) out.base = token.slice("--base=".length);
		else if (token === "--anthropic") out.anthropic = readValue(token);
		else if (token.startsWith("--anthropic=")) out.anthropic = token.slice("--anthropic=".length);
		else if (token === "--gpt") out.gpt = readValue(token);
		else if (token.startsWith("--gpt=")) out.gpt = token.slice("--gpt=".length);
		else if (token === "--fallback-b") out.fallbackB = readValue(token);
		else if (token.startsWith("--fallback-b=")) out.fallbackB = token.slice("--fallback-b=".length);
		else if (token === "--no-fallback") out.noFallback = true;
		else if (token === "--consolidator") out.consolidator = readValue(token);
		else if (token.startsWith("--consolidator=")) out.consolidator = token.slice("--consolidator=".length);
		else if (token === "--no-resume") out.resume = false;
		else if (token === "--resume") out.resume = true;
		else if (token === "--debug") out.debug = true;
		else if (token === "--no-debug") out.debug = false;
		else throw new Error(`Unknown argument '${token}'`);
	}
	return out;
}

function buildToolInvocationMessage(parsed: CommandArgs): string {
	const argObj: Record<string, unknown> = {};
	if (parsed.outDir) argObj.outDir = parsed.outDir;
	if (parsed.base) argObj.base = parsed.base;
	if (parsed.anthropic) argObj.anthropic = parsed.anthropic;
	if (parsed.gpt) argObj.gpt = parsed.gpt;
	if (parsed.noFallback) argObj.fallbackB = "";
	else if (parsed.fallbackB) argObj.fallbackB = parsed.fallbackB;
	if (parsed.consolidator) argObj.consolidator = parsed.consolidator;
	if (parsed.resume === false) argObj.resume = false;
	if (parsed.debug === false) argObj.debug = false;
	else if (parsed.debug === true) argObj.debug = true;
	const argsJson = JSON.stringify(argObj);
	return [
		"/dual-finalcheck",
		"",
		"Invoke the dual_finalcheck tool now with these arguments and no others:",
		"```json",
		argsJson,
		"```",
		"Do not ask clarifying questions. Do not run other tools first. Just call dual_finalcheck.",
	].join("\n");
}

