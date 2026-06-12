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
 * Walkthroughs
 * ============
 *
 * Companion to `dual-finalcheck`. Takes a consolidated findings file
 * (default: `findingsC.md`) and, for each C-numbered finding, fans out one
 * sub-agent that produces an annotated code walkthrough illustrating the
 * issue.
 *
 *   findingsC.md > C1  →  C1-walkthrough.md
 *   findingsC.md > C2  →  C2-walkthrough.md
 *   ...
 *
 * --------------------------------------------------------------------------
 * Output files (relative to --out-dir, default = current working directory)
 * --------------------------------------------------------------------------
 *
 *   C<N>-walkthrough.md         Annotated walkthrough for finding C<N>
 *
 * Debug mode (on by default; disable with --no-debug):
 *
 *   .walkthrough-C<N>.jsonl     Raw JSON event stream from the C<N> sub-agent
 *
 * Inspect a debug log with e.g.
 *   jq -c 'select(.type=="message_end")' .walkthrough-C1.jsonl
 *
 * --------------------------------------------------------------------------
 * Command: /walkthroughs
 * --------------------------------------------------------------------------
 *
 * Thin shim that nudges the active LLM to call the `walkthroughs` tool.
 *
 * Usage:
 *   /walkthroughs                                run with defaults
 *   /walkthroughs --out-dir .pi/finalcheck       look for findingsC.md and write walkthroughs there
 *   /walkthroughs --findings findingsC.md        explicit findings file path
 *   /walkthroughs --model anthropic/claude-opus-4-7:high
 *   /walkthroughs --concurrency 4                run up to N children in parallel (default 3)
 *   /walkthroughs --only C1,C3,C5                only run these findings
 *   /walkthroughs --no-resume                    re-run even if C<N>-walkthrough.md already exists
 *   /walkthroughs --no-debug                     do not write .walkthrough-C<N>.jsonl files
 *
 * Model spec format: `provider/id` or `provider/id:thinkingLevel`, where
 * thinkingLevel is one of: off | minimal | low | medium | high | xhigh.
 *
 * --------------------------------------------------------------------------
 * Child process integration
 * --------------------------------------------------------------------------
 *
 * Each finding runs in its own `pi --mode json -p --no-session` subprocess so
 * its context is isolated. The same extension is loaded inside that
 * subprocess; it detects child mode via the PI_WALKTHROUGH_OUTPUT environment
 * variable and:
 *
 *   - Registers only the restricted `write_walkthrough` tool, which writes to
 *     the assigned C<N>-walkthrough.md and nothing else.
 *   - Scopes the active toolset to read + bash + grep + find + ls + mcp +
 *     writer.
 *   - Appends a hard safety policy to the system prompt: no source edits,
 *     no tests/lint/builds, no git fetch/rebase, single writer call.
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

type ChildStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

interface ChildState {
  id: string; // e.g. "C1"
  model: string;
  thinkingLevel?: ThinkingLevel;
  outputPath: string;
  jsonlPath?: string;
  status: ChildStatus;
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
}

interface WalkthroughsDetails {
  phase: "preparing" | "setup" | "running" | "done" | "failed";
  findingsPath: string;
  outDir: string;
  model: string;
  concurrency: number;
  children: ChildState[];
  error?: string;
  parseWarnings: string[];
  mcpReadiness?: McpReadiness;
}

interface McpReadiness {
  ok: boolean;
  mcpToolAvailable: boolean;
  agentDir: string;
  configuredServers: string[];
  context: { configured: boolean; cached: boolean; toolCount: number };
  linear: {
    configured: boolean;
    hasAccessToken: boolean;
    expiresAt?: number;
    hasRefreshToken: boolean;
    tokenLikelyValid: boolean;
  };
  errors: string[];
  warnings: string[];
}

const DEFAULT_MODEL: ModelRef = { provider: "anthropic", model: "claude-opus-4-7" };
const DEFAULT_THINKING: ThinkingLevel = "xhigh";
const DEFAULT_CONCURRENCY = 3;
const WRITER_TOOL = "write_walkthrough";
const CHILD_OUTPUT_ENV = "PI_WALKTHROUGH_OUTPUT";
const CHILD_FINDING_ENV = "PI_WALKTHROUGH_FINDING";

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

function parseModelSpec(value: string | undefined, fallback: ModelSpec): ModelSpec {
  if (!value) return fallback;
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

function trimTail(s: string, limit: number): string {
  if (s.length <= limit) return s;
  return s.slice(s.length - limit);
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
        themeFg("accent", "walkthrough") +
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

// --- MCP readiness --------------------------------------------------------

/**
 * Soft, filesystem-based pre-flight check for the two MCPs that walkthrough
 * children are required to consult.
 *
 * What we look at (best-effort, never throws):
 *   1. `pi.getAllTools()` for the `mcp` proxy tool registered by
 *      `pi-mcp-adapter`. Without it there is no way for children to reach
 *      either MCP at all.
 *   2. `<agentDir>/mcp.json` plus any imports (e.g. `claude-code` → `~/.claude.json`)
 *      to confirm `context` and `linear` are configured as servers somewhere.
 *   3. `<agentDir>/mcp-cache.json` for `servers.context` with cached tools —
 *      treated as a strong signal that context is reachable and listable.
 *   4. `<agentDir>/mcp-oauth/linear/tokens.json` for an access token whose
 *      `expiresAt` is in the future OR a refresh token that the adapter can
 *      use to mint a new one on first call.
 *
 * The LLM-orchestrated setup step in the /walkthroughs command shim is the
 * primary path that actually connects + authenticates servers. This check is
 * a safety net that produces an actionable error if a child would have hit a
 * cold MCP at runtime.
 */
async function readJsonFile<T = any>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function collectConfiguredMcpServers(agentDir: string): Promise<string[]> {
  const out = new Set<string>();
  const cfg = await readJsonFile<any>(join(agentDir, "mcp.json"));
  if (cfg?.mcpServers && typeof cfg.mcpServers === "object") {
    for (const k of Object.keys(cfg.mcpServers)) out.add(k);
  }
  const imports = Array.isArray(cfg?.imports) ? cfg!.imports : [];
  for (const imp of imports) {
    // pi-mcp-adapter understands `"claude-code"` as an alias for ~/.claude.json.
    if (imp === "claude-code") {
      const claudeCfg = await readJsonFile<any>(join(homedir(), ".claude.json"));
      if (claudeCfg?.mcpServers && typeof claudeCfg.mcpServers === "object") {
        for (const k of Object.keys(claudeCfg.mcpServers)) out.add(k);
      }
    }
    // Other import shapes are not enumerated here; absence just means we can't
    // verify the configuration filesystem-side, which surfaces as a warning.
  }
  return [...out].sort();
}

async function checkMcpReadiness(allToolNames: Set<string>, agentDir: string): Promise<McpReadiness> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const mcpToolAvailable = allToolNames.has("mcp");
  if (!mcpToolAvailable) {
    errors.push(
      "The `mcp` proxy tool is not registered. Install/enable `pi-mcp-adapter` (settings.json `packages: [\"npm:pi-mcp-adapter\"]`) and reload.",
    );
  }

  const configured = await collectConfiguredMcpServers(agentDir);
  const contextConfigured = configured.includes("context");
  const linearConfigured = configured.includes("linear");
  if (!contextConfigured) {
    errors.push(
      "Context MCP server is not configured. Add a `context` entry to `~/.pi/agent/mcp.json` mcpServers (or to an imported config such as `~/.claude.json`).",
    );
  }
  if (!linearConfigured) {
    errors.push(
      "Linear MCP server is not configured. Add a `linear` entry to `~/.pi/agent/mcp.json` mcpServers (or to an imported config such as `~/.claude.json`).",
    );
  }

  // Context cache (presence => was at least listed once)
  const cache = await readJsonFile<any>(join(agentDir, "mcp-cache.json"));
  const ctxEntry = cache?.servers?.context;
  const ctxToolCount = Array.isArray(ctxEntry?.tools) ? ctxEntry.tools.length : 0;
  const contextCached = !!ctxEntry && ctxToolCount > 0;
  if (contextConfigured && !contextCached) {
    warnings.push(
      "Context MCP has no cached tools yet — the setup step needs to connect it before walkthroughs start.",
    );
  }

  // Linear OAuth token state. pi-mcp-adapter stores `expiresAt` as a Unix
  // timestamp in SECONDS (see mcp-auth.ts:20 in pi-mcp-adapter).
  const linearTokens = await readJsonFile<any>(
    join(agentDir, "mcp-oauth", "linear", "tokens.json"),
  );
  const inner = linearTokens?.tokens ?? {};
  const hasAccessToken = typeof inner.accessToken === "string" && inner.accessToken.length > 0;
  const expiresAtSec = typeof inner.expiresAt === "number" ? inner.expiresAt : undefined;
  const hasRefreshToken =
    typeof inner.refreshToken === "string" && inner.refreshToken.length > 0;
  const nowSec = Date.now() / 1000;
  const accessUnexpired = typeof expiresAtSec === "number" && expiresAtSec > nowSec + 60;
  const tokenLikelyValid = hasAccessToken && (accessUnexpired || hasRefreshToken);

  if (linearConfigured) {
    if (!hasAccessToken) {
      errors.push(
        "Linear MCP has no OAuth tokens on disk. From your active conversation run `mcp({ connect: \"linear\" })` and complete the OAuth flow, then retry /walkthroughs.",
      );
    } else if (!tokenLikelyValid) {
      errors.push(
        "Linear MCP access token is expired and no refresh token is present. From your active conversation run `mcp({ connect: \"linear\" })` to re-authenticate, then retry /walkthroughs.",
      );
    } else if (typeof expiresAtSec === "number" && !accessUnexpired) {
      warnings.push(
        "Linear MCP access token is expired but a refresh token is present; the adapter should refresh it on first call.",
      );
    }
  }

  const ok = errors.length === 0;
  return {
    ok,
    mcpToolAvailable,
    agentDir,
    configuredServers: configured,
    context: { configured: contextConfigured, cached: contextCached, toolCount: ctxToolCount },
    linear: {
      configured: linearConfigured,
      hasAccessToken,
      // Stored in seconds-since-epoch to match the on-disk format used by pi-mcp-adapter.
      expiresAt: expiresAtSec,
      hasRefreshToken,
      tokenLikelyValid,
    },
    errors,
    warnings,
  };
}

function renderMcpReadinessLines(theme: any, r: McpReadiness): string[] {
  const lines: string[] = [];
  const ctxOk = r.context.configured && r.context.cached;
  const linOk = r.linear.configured && r.linear.tokenLikelyValid;
  const ctxIcon = ctxOk ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const linIcon = linOk ? theme.fg("success", "✓") : theme.fg("error", "✗");
  lines.push(`${ctxIcon} ${theme.fg("toolTitle", "context MCP")}` +
    theme.fg("dim", `  configured=${r.context.configured}  cached=${r.context.cached}  tools=${r.context.toolCount}`));
  // r.linear.expiresAt is Unix seconds (see checkMcpReadiness comment); convert to ms for Date.
  const exp = r.linear.expiresAt
    ? new Date(r.linear.expiresAt * 1000).toISOString()
    : "(none)";
  lines.push(`${linIcon} ${theme.fg("toolTitle", "linear MCP")}` +
    theme.fg("dim", `  configured=${r.linear.configured}  accessToken=${r.linear.hasAccessToken}  refreshToken=${r.linear.hasRefreshToken}  expiresAt=${exp}`));
  for (const e of r.errors) lines.push("  " + theme.fg("error", `✗ ${e}`));
  for (const w of r.warnings) lines.push("  " + theme.fg("warning", `! ${w}`));
  return lines;
}

// --- finding parsing -------------------------------------------------------

/**
 * Parse a consolidated findings markdown file and return one entry per C<N>.
 * Each entry carries the verbatim slice of the file from that finding's
 * heading up to (but not including) the next finding heading (or the next
 * top-level `##` section, e.g. "## Verdict").
 *
 * Robustness:
 * - Prefers the body inside "## Consolidated Findings" if present; otherwise
 *   searches the whole document.
 * - Anchors on any heading line (`#{1,6}\s+`) whose first token references a
 *   `C\d+` identifier.
 * - As a fallback when no headings are found, anchors on `**C\d+**` or
 *   `C\d+:` at line start.
 */
interface ParsedFinding {
  id: string; // e.g. "C1"
  num: number; // 1
  heading: string; // the heading line
  body: string; // body text (does not include the heading line)
}

function parseFindingsMarkdown(md: string): { findings: ParsedFinding[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = md.split("\n");

  // Locate the "Consolidated Findings" section, if present.
  let startIdx = 0;
  let endIdx = lines.length;
  const consolidatedRe = /^##\s+(Consolidated\s+Findings|Findings)\b/i;
  const nextSectionRe = /^##\s+/;
  const consolidatedStart = lines.findIndex((l) => consolidatedRe.test(l));
  if (consolidatedStart >= 0) {
    startIdx = consolidatedStart + 1;
    const next = lines.slice(startIdx).findIndex((l) => nextSectionRe.test(l));
    endIdx = next >= 0 ? startIdx + next : lines.length;
  }

  const headingRe = /^(#{1,6})\s+.*?\bC(\d+)\b/;
  const inlineRe = /^(?:\*\*C(\d+)\*\*|C(\d+)[:.\s—–-])/;

  const anchors: { lineIdx: number; num: number; heading: string }[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const m = lines[i].match(headingRe);
    if (m) {
      anchors.push({ lineIdx: i, num: Number(m[2]), heading: lines[i] });
    }
  }
  if (anchors.length === 0) {
    // Fallback to inline patterns.
    for (let i = startIdx; i < endIdx; i++) {
      const m = lines[i].match(inlineRe);
      if (m) {
        const num = Number(m[1] ?? m[2]);
        if (!Number.isNaN(num)) anchors.push({ lineIdx: i, num, heading: lines[i] });
      }
    }
    if (anchors.length > 0) warnings.push("Using fallback finding-anchor pattern (no ### headings matched).");
  }

  if (anchors.length === 0) {
    warnings.push("No C<N> findings detected in input.");
    return { findings: [], warnings };
  }

  const findings: ParsedFinding[] = [];
  const seen = new Set<number>();
  for (let a = 0; a < anchors.length; a++) {
    const cur = anchors[a];
    const next = a + 1 < anchors.length ? anchors[a + 1].lineIdx : endIdx;
    if (seen.has(cur.num)) {
      warnings.push(`Duplicate finding id C${cur.num} at line ${cur.lineIdx + 1}; keeping first occurrence.`);
      continue;
    }
    seen.add(cur.num);
    const bodyLines = lines.slice(cur.lineIdx + 1, next);
    // Trim trailing blank lines.
    while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();
    findings.push({
      id: `C${cur.num}`,
      num: cur.num,
      heading: cur.heading,
      body: bodyLines.join("\n"),
    });
  }
  findings.sort((a, b) => a.num - b.num);
  return { findings, warnings };
}

// --- prompts ---------------------------------------------------------------

function buildWalkthroughPrompt(params: {
  finding: ParsedFinding;
  findingsPath: string;
  outputPath: string;
  modelLabel: string;
  cwd: string;
}): string {
  const { finding, findingsPath, outputPath, modelLabel, cwd } = params;
  const findingText = `${finding.heading}\n${finding.body}`.trim();
  return `You are producing an annotated code walkthrough for a single consolidated finalcheck finding.

Finding ID: ${finding.id}
Source findings file: ${findingsPath}
Assigned output file: ${outputPath}
Your assigned model: ${modelLabel}
Repository root (cwd): ${cwd}

Below is the verbatim text of finding ${finding.id} extracted from ${findingsPath}:

<finding id="${finding.id}">
${findingText}
</finding>

Your task:
1. Read the source files referenced by the finding to confirm understanding. Use grep/find/ls/language servers as needed to locate related code.
2. Use full path filenames and line numbers for all referenced code.
3. **Consult the context MCP** to gather architectural / specification / requirement context for the affected area. At minimum, search for related requirements (e.g. \`req:ORG-MEMB-*\`), learnings, and skills relevant to the files touched by the finding. The context MCP is reached via the \`mcp\` proxy tool: start with \`mcp({ server: "context" })\` to list tools, then call relevant ones (e.g. \`mcp({ tool: "query", args: "{...}" })\`, \`mcp({ tool: "find_skills", args: "{...}" })\`, \`mcp({ tool: "load_skill", args: "{...}" })\`). Cite the specific Context MCP entries you used.
4. **Consult the Linear MCP** to find existing/related tickets. Reach it via the \`mcp\` proxy tool: \`mcp({ server: "linear" })\` to list tools, then call relevant search/list tools (e.g. \`mcp({ tool: "list_issues", args: "{...}" })\` or a search tool if present) using keywords drawn from the finding — affected file paths, feature flag keys, ticket IDs already referenced in the finding (e.g. \`ORG-14\`, \`ORG-128\`), and product/service names. Capture the matching ticket identifiers, statuses, and one-line summaries.
5. If Linear MCP returns an authentication error, stop and report it in the walkthrough's \`## Related Linear tickets\` section rather than guessing; the walkthrough should still be produced.
6. Produce an annotated code walkthrough that makes the issue concrete and obvious to a reader who has not seen the finding before. Use Context MCP findings to ground the problem definition and the Linear ticket landscape to scope the solution proposal.
7. Do NOT edit any source files. Do NOT run tests, lint, type-check, builds, formatters, git fetch, or git rebase.
8. Use only the read, bash (read-only commands), grep, find, ls, lsp tools, and the mcp gateway tool to investigate.
9. When the walkthrough is ready, call ${WRITER_TOOL} exactly once with the full markdown content. That writer is the only allowed write action.

Required markdown structure for ${outputPath}:

# ${finding.id} — Walkthrough

## Issue
(1–3 sentences restating the issue in your own words.)

## Walkthrough

For each relevant location, include a subsection. Order them in execution / call order so a reader can trace the bug. Cite file paths and line ranges precisely, e.g. \`model/src/org/invite/organizationInviteCreate.ts:35-67\`.

### <file>:<lineStart>-<lineEnd> — short label
\`\`\`<language>
<copied code excerpt, faithful to the file, with brief inline annotation
comments using "// ⚠️ ..." or "// 👉 ..." to mark the exact problem lines>
\`\`\`
1–3 sentences explaining what this excerpt shows and why it matters for the finding.

(Repeat for each relevant location. Aim for 2–5 excerpts; keep each excerpt focused — usually 5–30 lines.)

## Why it matters
(2–4 sentences on user-visible impact and blast radius. Reuse the finding's "Impact" but ground it in the code shown above. Strengthen with Context MCP requirements / learnings where they sharpen the rationale.)

## Architectural context (Context MCP)
List the specific Context MCP entries you consulted and what each told you. Format each as:
- \`<kind>:<id-or-name>\` — 1-line summary and how it relates to this finding.

If, after searching, no relevant context was found, write exactly "None found. Searched: <comma-separated query terms used>.".

## Related Linear tickets
List Linear tickets relevant to this finding. Format each as:
- \`<TICKET-ID>\` (<status>) — title. Relationship to this finding (e.g. "tracks the fold-on-accept work mentioned in the finding", "would be the natural home for the fix", "shipped the regression").

If, after searching, no related tickets were found, write exactly "None found. Searched: <comma-separated query terms used>.".

If the Linear MCP returned an authentication or connection error, instead write: "Linear MCP unavailable: <short reason>." and continue.

## Suggested fix sketch
(Optional but encouraged: a short, concrete sketch of the fix — pseudo-diff or 3–8 line code snippet showing the change. Do not actually edit any file; this is just illustrative. Where a related Linear ticket is the natural home for the fix, reference it.)

## Sources
- Finding ${finding.id} in ${findingsPath}
- (Any other files referenced in the walkthrough above, plus the Context MCP entries and Linear tickets cited above.)
`;
}

// --- child streaming -------------------------------------------------------

function newChildState(id: string, spec: ModelSpec, outputPath: string, jsonlPath?: string): ChildState {
  return {
    id,
    model: modelKey(spec.ref),
    thinkingLevel: spec.thinking,
    outputPath,
    jsonlPath,
    status: "pending",
    toolCalls: [],
    assistantTexts: [],
    thinkingTexts: [],
    liveText: "",
    liveThinking: "",
    finalText: "",
    fileWritten: false,
    stderrTail: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  };
}

function handleStreamEvent(state: ChildState, event: any): void {
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
        thinkingParts.push(part.thinking);
      }
    }
    if (thinkingParts.length > 0) {
      const combined = thinkingParts.join("\n\n").trim();
      if (combined && state.thinkingTexts[state.thinkingTexts.length - 1] !== combined) {
        state.thinkingTexts.push(combined);
      }
    } else if (state.liveThinking.trim()) {
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

async function runChild(params: {
  state: ChildState;
  findingId: string;
  cwd: string;
  model: ModelRef;
  thinking?: ThinkingLevel;
  prompt: string;
  signal?: AbortSignal;
  onProgress: () => void;
}): Promise<void> {
  const modelArg = params.thinking ? `${modelKey(params.model)}:${params.thinking}` : modelKey(params.model);
  const args = ["--mode", "json", "-p", "--no-session", "--model", modelArg, params.prompt];
  const invocation = getPiInvocation(args);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [CHILD_OUTPUT_ENV]: params.state.outputPath,
    [CHILD_FINDING_ENV]: params.findingId,
  };

  let debugStream: import("node:fs").WriteStream | undefined;
  if (params.state.jsonlPath) {
    try {
      await mkdir(dirname(params.state.jsonlPath), { recursive: true });
      const fs = await import("node:fs");
      debugStream = fs.createWriteStream(params.state.jsonlPath, { flags: "w" });
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

// --- concurrency helper ----------------------------------------------------

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const lanes = Math.max(1, Math.min(concurrency, queue.length));
  const runners: Promise<void>[] = [];
  for (let i = 0; i < lanes; i++) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) return;
          await worker(next);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

// --- rendering -------------------------------------------------------------

function statusIcon(theme: any, status: ChildStatus): string {
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
    case "skipped":
      return theme.fg("dim", "↷");
  }
}

function lastLines(text: string, n: number): string {
  if (!text) return "";
  const lines = text.split("\n");
  return lines.slice(-n).join("\n");
}

function describeChildModel(child: ChildState): string {
  return child.thinkingLevel ? `${child.model}:${child.thinkingLevel}` : child.model;
}

function collectReasoningText(child: ChildState): string {
  const pieces: string[] = [];
  for (const t of child.thinkingTexts) {
    if (t && t.trim()) pieces.push(t.trim());
  }
  if (child.liveThinking.trim()) pieces.push(child.liveThinking.trim());
  return pieces.join("\n\n");
}

function renderChildCollapsed(child: ChildState, theme: any): string {
  const lines: string[] = [];
  const skippedTag = child.status === "skipped" ? ` ${theme.fg("dim", "(resumed from existing file)")}` : "";
  const header =
    statusIcon(theme, child.status) +
    " " +
    theme.fg("toolTitle", theme.bold(child.id)) +
    " " +
    theme.fg("muted", `(${describeChildModel(child)})`) +
    skippedTag;
  lines.push(header);
  lines.push("  " + theme.fg("dim", `→ ${child.outputPath}`));

  const toolsToShow = child.toolCalls.slice(-COLLAPSED_TOOL_LIMIT);
  const skipped = child.toolCalls.length - toolsToShow.length;
  if (skipped > 0) lines.push("  " + theme.fg("muted", `... ${skipped} earlier tool calls`));
  for (const tc of toolsToShow) {
    lines.push("  " + theme.fg("muted", "→ ") + formatToolCall(tc, theme.fg.bind(theme)));
  }

  const reasoning = collectReasoningText(child);
  if (reasoning) {
    const snippet = lastLines(reasoning, 3);
    lines.push("  " + theme.fg("muted", "reasoning: ") + theme.fg("dim", theme.italic(snippet)));
  }

  if (child.status === "running" && child.liveText.trim()) {
    const snippet = lastLines(child.liveText.trim(), 3);
    lines.push("  " + theme.fg("toolOutput", snippet));
  }

  if (child.status === "completed" && child.finalText.trim()) {
    const snippet = lastLines(child.finalText.trim(), COLLAPSED_TEXT_LINES);
    lines.push("  " + theme.fg("toolOutput", snippet));
  }

  if (child.status === "failed" || child.status === "cancelled") {
    const detail =
      child.errorMessage ||
      (child.stopReason ? `stopReason: ${child.stopReason}` : undefined) ||
      (child.stderrTail ? child.stderrTail.trim().split("\n").slice(-3).join("\n") : undefined) ||
      `exit ${child.exitCode ?? "?"}`;
    lines.push("  " + theme.fg("error", detail));
  }

  const usage = formatUsageStats(child.usage);
  if (usage) lines.push("  " + theme.fg("dim", usage));

  return lines.join("\n");
}

function renderChildExpanded(container: Container, child: ChildState, theme: any, mdTheme: any): void {
  const skippedTag = child.status === "skipped" ? ` ${theme.fg("dim", "(resumed from existing file)")}` : "";
  const header =
    statusIcon(theme, child.status) +
    " " +
    theme.fg("toolTitle", theme.bold(child.id)) +
    " " +
    theme.fg("muted", `(${describeChildModel(child)})`) +
    skippedTag;
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Text(theme.fg("dim", `output: ${child.outputPath}`), 0, 0));
  if (child.jsonlPath) {
    container.addChild(new Text(theme.fg("dim", `jsonl:  ${child.jsonlPath}`), 0, 0));
  }

  if (child.toolCalls.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── tool calls ───"), 0, 0));
    for (const tc of child.toolCalls) {
      container.addChild(
        new Text("  " + theme.fg("muted", "→ ") + formatToolCall(tc, theme.fg.bind(theme)), 0, 0),
      );
    }
  }

  const reasoning = collectReasoningText(child);
  if (reasoning) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── reasoning ───"), 0, 0));
    container.addChild(new Text(theme.fg("dim", theme.italic(reasoning)), 0, 0));
  }

  if (child.status === "running" && child.liveText.trim()) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── live output ───"), 0, 0));
    container.addChild(new Text(theme.fg("toolOutput", child.liveText.trim()), 0, 0));
  }

  if (child.finalText.trim()) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── final assistant output ───"), 0, 0));
    container.addChild(new Markdown(child.finalText.trim(), 0, 0, mdTheme));
  }

  if (child.status === "failed" || child.status === "cancelled") {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── failure ───"), 0, 0));
    if (child.stopReason) container.addChild(new Text(theme.fg("error", `stopReason: ${child.stopReason}`), 0, 0));
    if (child.errorMessage) container.addChild(new Text(theme.fg("error", `error: ${child.errorMessage}`), 0, 0));
    if (child.stderrTail.trim()) {
      container.addChild(new Text(theme.fg("error", `stderr:\n${child.stderrTail.trim()}`), 0, 0));
    }
    container.addChild(new Text(theme.fg("error", `exit code: ${child.exitCode ?? "?"}`), 0, 0));
  }

  const usage = formatUsageStats(child.usage);
  if (usage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
}

function summarizePhase(theme: any, details: WalkthroughsDetails): string {
  const phaseLabel: Record<WalkthroughsDetails["phase"], string> = {
    preparing: "preparing",
    setup: "setup (MCP check)",
    running: `running (${details.concurrency} at a time)`,
    done: "done",
    failed: "failed",
  };
  const phase = theme.fg("accent", phaseLabel[details.phase]);
  const counts = details.children.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<ChildStatus, number>,
  );
  const summary = [
    counts.completed ? theme.fg("success", `✓${counts.completed}`) : undefined,
    counts.running ? theme.fg("warning", `⏳${counts.running}`) : undefined,
    counts.pending ? theme.fg("muted", `·${counts.pending}`) : undefined,
    counts.skipped ? theme.fg("dim", `↷${counts.skipped}`) : undefined,
    counts.failed ? theme.fg("error", `✗${counts.failed}`) : undefined,
    counts.cancelled ? theme.fg("warning", `◐${counts.cancelled}`) : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `${theme.fg("toolTitle", theme.bold("walkthroughs"))} ${phase} — ${summary || theme.fg("muted", "no findings")}`;
}

// --- main extension --------------------------------------------------------

export default function walkthroughs(pi: ExtensionAPI) {
  const childOutput = process.env[CHILD_OUTPUT_ENV];
  const childFinding = process.env[CHILD_FINDING_ENV];

  // --- child mode: register only the restricted writer tool --------------
  if (childOutput) {
    pi.registerTool({
      name: WRITER_TOOL,
      label: "Write Walkthrough",
      description: `Write the annotated walkthrough markdown to the assigned file: ${childOutput}. This is the only permitted write in walkthroughs child runs.`,
      promptSnippet: `Write the final walkthrough markdown for finding ${childFinding ?? ""} to the assigned output file`,
      promptGuidelines: [`Use ${WRITER_TOOL} exactly once when the walkthrough markdown is ready.`],
      parameters: Type.Object({
        content: Type.String({ description: "Complete markdown content to write to the assigned walkthrough file" }),
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
      const desired = ["read", "bash", "grep", "find", "ls", "mcp", WRITER_TOOL];
      pi.setActiveTools(desired.filter((name) => name === WRITER_TOOL || allTools.has(name)));
    };

    pi.on("session_start", setChildTools);
    pi.on("before_agent_start", (event) => {
      setChildTools();
      return {
        systemPrompt: `${event.systemPrompt}\n\nWalkthroughs child safety policy: do not edit source files; use only ${WRITER_TOOL} for the assigned walkthrough file (${childOutput}); do not run tests, lint, type-checks, builds, git fetch, or git rebase.`,
      };
    });
    return;
  }

  // --- parent mode: register the walkthroughs tool + /command -----------

  pi.registerTool({
    name: "walkthroughs",
    label: "Walkthroughs",
    description:
      "For each consolidated finding (C1, C2, ...) in findingsC.md, spawn a sub-agent that produces an annotated code walkthrough at C<N>-walkthrough.md. Requires the context MCP and linear MCP to be connected/authenticated; the tool re-checks readiness and refuses to run otherwise.",
    promptSnippet: "Generate one annotated walkthrough per consolidated finalcheck finding",
    promptGuidelines: [
      "Use walkthroughs when the user asks for per-finding walkthroughs (e.g. /walkthroughs). Before invoking, ensure both the context MCP and the linear MCP are connected and authenticated (call `mcp({ connect: \"context\" })` and `mcp({ connect: \"linear\" })` if needed). Then invoke walkthroughs without asking clarifying questions.",
    ],
    parameters: Type.Object({
      outDir: Type.Optional(
        Type.String({
          description:
            "Directory containing findingsC.md and where C<N>-walkthrough.md will be written. Defaults to the current working directory.",
        }),
      ),
      findings: Type.Optional(
        Type.String({
          description:
            "Path to the consolidated findings markdown. Defaults to <outDir>/findingsC.md.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model spec as provider/id, optionally with :thinkingLevel. Default: anthropic/claude-opus-4-7:xhigh",
        }),
      ),
      concurrency: Type.Optional(
        Type.Number({
          description: "Maximum number of walkthrough sub-agents to run in parallel. Default: 3",
        }),
      ),
      only: Type.Optional(
        Type.String({
          description:
            "Comma-separated list of finding IDs to run (e.g. 'C1,C3,C5'). When omitted, all findings are run.",
        }),
      ),
      resume: Type.Optional(
        Type.Boolean({
          description:
            "If true (default), skip findings whose C<N>-walkthrough.md already exists and is non-empty. Set false to force a fresh run.",
        }),
      ),
      debug: Type.Optional(
        Type.Boolean({
          description:
            "Write the raw JSON event stream from each child to <outDir>/.walkthrough-C<N>.jsonl for inspection. Default: true.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spec = parseModelSpec(params.model, { ref: DEFAULT_MODEL, thinking: DEFAULT_THINKING });
      const concurrency = Math.max(1, Math.floor(params.concurrency ?? DEFAULT_CONCURRENCY));
      const resume = params.resume !== false;
      const debug = params.debug !== false;
      const outDir = params.outDir
        ? isAbsolute(params.outDir)
          ? params.outDir
          : resolve(ctx.cwd, params.outDir)
        : ctx.cwd;
      const findingsPath = params.findings
        ? isAbsolute(params.findings)
          ? params.findings
          : resolve(ctx.cwd, params.findings)
        : join(outDir, "findingsC.md");

      // Validate model + auth.
      const model = ctx.modelRegistry.find(spec.ref.provider, spec.ref.model);
      if (!model) throw new Error(`Model not found: ${modelKey(spec.ref)}`);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? `No API key for ${modelKey(spec.ref)}` : `${modelKey(spec.ref)}: ${auth.error}`);
      }

      if (!existsSync(findingsPath)) {
        throw new Error(`Findings file not found: ${findingsPath}`);
      }

      // --- MCP readiness pre-flight ---
      // Children MUST be able to reach both context and linear MCPs. The
      // LLM-orchestrated setup step in the /walkthroughs command shim handles
      // the live connect/auth; this is a final safety net.
      const allToolNames = new Set(pi.getAllTools().map((t) => t.name));
      const agentDirPath = getAgentDir();
      const mcpReadiness = await checkMcpReadiness(allToolNames, agentDirPath);
      if (!mcpReadiness.ok) {
        const lines: string[] = [];
        lines.push("MCP setup is not ready. Walkthroughs require context MCP + linear MCP to be loaded and authenticated.");
        lines.push("");
        for (const e of mcpReadiness.errors) lines.push(`  ✗ ${e}`);
        if (mcpReadiness.warnings.length) {
          lines.push("");
          for (const w of mcpReadiness.warnings) lines.push(`  ! ${w}`);
        }
        lines.push("");
        lines.push("Resolution path:");
        lines.push("  1. From this conversation, run: mcp({ connect: \"context\" })");
        lines.push("  2. From this conversation, run: mcp({ connect: \"linear\" }) and complete the OAuth flow if prompted.");
        lines.push("  3. Re-run /walkthroughs.");
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            phase: "failed",
            findingsPath,
            outDir,
            model: formatSpec(spec),
            concurrency,
            children: [],
            parseWarnings: [],
            mcpReadiness,
            error: "MCP setup not ready",
          } as WalkthroughsDetails,
          isError: true,
        };
      }

      const findingsText = await readFile(findingsPath, "utf8");
      const { findings, warnings } = parseFindingsMarkdown(findingsText);
      if (findings.length === 0) {
        throw new Error(`No C-numbered findings parsed from ${findingsPath}.${warnings.length ? ` Warnings: ${warnings.join("; ")}` : ""}`);
      }

      // Filter by --only if provided.
      let filtered = findings;
      if (params.only && params.only.trim()) {
        const requested = new Set(
          params.only
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter((s) => s.length > 0),
        );
        filtered = findings.filter((f) => requested.has(f.id.toUpperCase()));
        const missing = [...requested].filter((id) => !findings.some((f) => f.id.toUpperCase() === id));
        if (missing.length) {
          warnings.push(`--only requested ids not present in findings: ${missing.join(", ")}`);
        }
        if (filtered.length === 0) {
          throw new Error(`No findings matched --only=${params.only}. Present: ${findings.map((f) => f.id).join(", ")}`);
        }
      }

      await mkdir(outDir, { recursive: true });

      // Build child states + decide which to skip vs. delete + (re)run.
      const children: ChildState[] = [];
      for (const f of filtered) {
        const outputPath = join(outDir, `${f.id}-walkthrough.md`);
        const jsonlPath = debug ? join(outDir, `.walkthrough-${f.id}.jsonl`) : undefined;
        const child = newChildState(f.id, spec, outputPath, jsonlPath);
        const existing =
          existsSync(outputPath) && (await readFile(outputPath, "utf8").catch(() => "")).trim().length > 0;
        if (resume && existing) {
          child.status = "skipped";
          child.fileWritten = true;
        } else {
          await rm(outputPath, { force: true });
        }
        children.push(child);
      }

      const details: WalkthroughsDetails = {
        phase: "setup",
        findingsPath,
        outDir,
        model: formatSpec(spec),
        concurrency,
        children,
        parseWarnings: warnings,
        mcpReadiness,
      };

      let lastUpdate = 0;
      const headerText = () =>
        [
          `walkthroughs phase=${details.phase} model=${details.model} concurrency=${details.concurrency}`,
          `findings: ${findingsPath}`,
          `output dir: ${outDir}`,
          `findings to process: ${children.map((c) => `${c.id}(${c.status})`).join(", ")}`,
        ].join("\n");
      const emitNow = () => {
        onUpdate?.({
          content: [{ type: "text", text: headerText() }],
          details: { ...details, children: children.map((c) => ({ ...c })) } as any,
        });
      };
      const emit = (force = false) => {
        const now = Date.now();
        if (!force && now - lastUpdate < UPDATE_THROTTLE_MS) return;
        lastUpdate = now;
        emitNow();
      };

      if (ctx.hasUI) {
        const targets = children.map((c) => c.outputPath).join(", ");
        ctx.ui.notify(`walkthroughs → ${targets}`, "info");
      }

      emit(true);
      details.phase = "running";
      emit(true);

      // Run children in a pool. Skipped children are no-ops.
      const findingsById = new Map(filtered.map((f) => [f.id, f]));
      await runPool(children, concurrency, async (child) => {
        if (child.status === "skipped") return;
        const finding = findingsById.get(child.id);
        if (!finding) {
          child.status = "failed";
          child.errorMessage = `Internal error: lost finding ${child.id} before dispatch.`;
          emit(true);
          return;
        }
        const prompt = buildWalkthroughPrompt({
          finding,
          findingsPath,
          outputPath: child.outputPath,
          modelLabel: formatSpec(spec),
          cwd: ctx.cwd,
        });
        await runChild({
          state: child,
          findingId: child.id,
          cwd: ctx.cwd,
          model: spec.ref,
          thinking: spec.thinking,
          prompt,
          signal,
          onProgress: () => emit(),
        });
      });

      const hasFailure = children.some((c) => c.status === "failed" || c.status === "cancelled");
      details.phase = hasFailure ? "failed" : "done";
      emit(true);

      const completed = children.filter((c) => c.status === "completed");
      const skipped = children.filter((c) => c.status === "skipped");
      const failed = children.filter((c) => c.status === "failed");
      const cancelled = children.filter((c) => c.status === "cancelled");

      const summaryLines: string[] = [];
      summaryLines.push(hasFailure ? "Walkthroughs completed with errors." : "Walkthroughs complete.");
      summaryLines.push(`Findings file: ${findingsPath}`);
      summaryLines.push(`Output dir: ${outDir}`);
      summaryLines.push(`Model: ${formatSpec(spec)}  Concurrency: ${concurrency}`);
      summaryLines.push("");
      for (const c of children) {
        summaryLines.push(`  ${c.id}: ${c.status}  →  ${c.outputPath}`);
      }
      if (warnings.length) {
        summaryLines.push("");
        summaryLines.push("Parse warnings:");
        for (const w of warnings) summaryLines.push(`  - ${w}`);
      }
      if (failed.length || cancelled.length) {
        summaryLines.push("");
        summaryLines.push("See tool details (Ctrl+O) for per-finding error info.");
      }

      return {
        content: [{ type: "text", text: summaryLines.join("\n") }],
        details,
        isError: hasFailure,
      };
    },

    renderCall(args, theme, _context) {
      const model = args?.model || `${modelKey(DEFAULT_MODEL)}:${DEFAULT_THINKING}`;
      const outDir = args?.outDir || "(cwd)";
      const findings = args?.findings || `${outDir}/findingsC.md`;
      const concurrency = args?.concurrency ?? DEFAULT_CONCURRENCY;
      const only = args?.only ? ` only=${args.only}` : "";
      let text = theme.fg("toolTitle", theme.bold("walkthroughs"));
      text += `\n  model: ${theme.fg("accent", model)}`;
      text += `\n  findings: ${theme.fg("dim", findings)}`;
      text += `\n  out: ${theme.fg("dim", outDir)}  concurrency: ${concurrency}${only}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const details = (result.details ?? {}) as Partial<WalkthroughsDetails>;
      const children = details.children ?? [];
      const phase: WalkthroughsDetails["phase"] = details.phase ?? "preparing";
      const mdTheme = getMarkdownTheme();

      const fullDetails: WalkthroughsDetails = {
        phase,
        findingsPath: details.findingsPath ?? "",
        outDir: details.outDir ?? "",
        model: details.model ?? "",
        concurrency: details.concurrency ?? DEFAULT_CONCURRENCY,
        children,
        error: details.error,
        parseWarnings: details.parseWarnings ?? [],
        mcpReadiness: details.mcpReadiness,
      };

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(summarizePhase(theme, fullDetails), 0, 0));
        container.addChild(
          new Text(theme.fg("dim", `findings: ${fullDetails.findingsPath}`), 0, 0),
        );
        container.addChild(
          new Text(
            theme.fg("dim", `model: ${fullDetails.model}  concurrency: ${fullDetails.concurrency}`),
            0,
            0,
          ),
        );
        if (fullDetails.error) {
          container.addChild(new Text(theme.fg("error", fullDetails.error), 0, 0));
        }
        if (fullDetails.parseWarnings.length) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("warning", "Parse warnings:"), 0, 0));
          for (const w of fullDetails.parseWarnings) {
            container.addChild(new Text(theme.fg("warning", `  - ${w}`), 0, 0));
          }
        }

        if (fullDetails.mcpReadiness) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── MCP readiness ───"), 0, 0));
          for (const ln of renderMcpReadinessLines(theme, fullDetails.mcpReadiness)) {
            container.addChild(new Text(ln, 0, 0));
          }
        }

        for (const child of children) {
          container.addChild(new Spacer(1));
          renderChildExpanded(container, child, theme, mdTheme);
        }
        return container;
      }

      // Collapsed view.
      const lines: string[] = [];
      lines.push(summarizePhase(theme, fullDetails));
      if (fullDetails.findingsPath) {
        lines.push(theme.fg("dim", `  findings: ${fullDetails.findingsPath}`));
      }
      if (fullDetails.mcpReadiness) {
        for (const ln of renderMcpReadinessLines(theme, fullDetails.mcpReadiness)) {
          lines.push("  " + ln);
        }
      }
      if (fullDetails.error) lines.push("  " + theme.fg("error", fullDetails.error));
      lines.push("");

      for (const child of children) {
        lines.push(renderChildCollapsed(child, theme));
        lines.push("");
      }

      if (!isPartial) lines.push(theme.fg("muted", "(Ctrl+O to expand for full transcripts and reasoning)"));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("walkthroughs", {
    description:
      "For each consolidated finding in findingsC.md, generate an annotated code walkthrough via a sub-agent.",
    handler: async (args, _ctx) => {
      const parsed = parseCommandArgs(args);
      const message = buildToolInvocationMessage(parsed);
      pi.sendUserMessage(message);
    },
  });
}

// --- /walkthroughs command helpers -----------------------------------------

interface CommandArgs {
  outDir?: string;
  findings?: string;
  model?: string;
  concurrency?: number;
  only?: string;
  resume?: boolean;
  debug?: boolean;
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
    else if (token === "--findings") out.findings = readValue(token);
    else if (token.startsWith("--findings=")) out.findings = token.slice("--findings=".length);
    else if (token === "--model") out.model = readValue(token);
    else if (token.startsWith("--model=")) out.model = token.slice("--model=".length);
    else if (token === "--concurrency") out.concurrency = Number(readValue(token));
    else if (token.startsWith("--concurrency=")) out.concurrency = Number(token.slice("--concurrency=".length));
    else if (token === "--only") out.only = readValue(token);
    else if (token.startsWith("--only=")) out.only = token.slice("--only=".length);
    else if (token === "--no-resume") out.resume = false;
    else if (token === "--resume") out.resume = true;
    else if (token === "--debug") out.debug = true;
    else if (token === "--no-debug") out.debug = false;
    else throw new Error(`Unknown argument '${token}'`);
  }
  if (out.concurrency !== undefined && (!Number.isFinite(out.concurrency) || out.concurrency < 1)) {
    throw new Error(`--concurrency must be a positive integer (got '${out.concurrency}')`);
  }
  return out;
}

function buildToolInvocationMessage(parsed: CommandArgs): string {
  const argObj: Record<string, unknown> = {};
  if (parsed.outDir) argObj.outDir = parsed.outDir;
  if (parsed.findings) argObj.findings = parsed.findings;
  if (parsed.model) argObj.model = parsed.model;
  if (parsed.concurrency !== undefined) argObj.concurrency = parsed.concurrency;
  if (parsed.only) argObj.only = parsed.only;
  if (parsed.resume === false) argObj.resume = false;
  if (parsed.debug === false) argObj.debug = false;
  else if (parsed.debug === true) argObj.debug = true;
  const argsJson = JSON.stringify(argObj);
  return [
    "/walkthroughs",
    "",
    "Two-step workflow. Do them in order, do not skip step 1, do not ask clarifying questions.",
    "",
    "Step 1 — MCP setup (required before kicking off walkthroughs):",
    "  a. Call `mcp({ server: \"context\" })` to confirm the context MCP is connected and lists tools.",
    "     If the response indicates the server is not connected, call `mcp({ connect: \"context\" })`.",
    "  b. Call `mcp({ server: \"linear\" })` to confirm the linear MCP is connected and lists tools.",
    "     If the response indicates `needs-auth` or that the server is not connected, call",
    "     `mcp({ connect: \"linear\" })` and walk the user through the OAuth flow if prompted.",
    "  c. Only proceed to step 2 once both servers list at least one tool. If either MCP cannot be",
    "     brought up, STOP and report the blocker; do not call the walkthroughs tool.",
    "",
    "Step 2 — Invoke the walkthroughs tool with these arguments and no others:",
    "```json",
    argsJson,
    "```",
    "The walkthroughs tool re-checks MCP readiness on the filesystem and will refuse to run if step 1",
    "was not actually completed; you must complete step 1 first.",
  ].join("\n");
}
