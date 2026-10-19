/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 *
 * Existing rules are kept separate from rules imported from safety_rules.md so
 * future rules can be appended to ADDITIONAL_SAFETY_RULES without changing the
 * gate logic.
 *
 * Only model tool calls are gated; the user's own `!` commands are not.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type PermissionRule = {
  id: string;
  reason: string;
  pattern: RegExp;
  // Optional escape hatch: when it returns true the rule is skipped (no prompt).
  allowIf?: (command: string, cwd: string) => boolean;
  // "unquoted": match against the command with quoted strings blanked out, so
  // e.g. `grep "git push"` or a commit message mentioning it doesn't trigger.
  // Defaults to "raw" (full command text).
  matchOn?: "raw" | "unquoted";
};

// Quoted args passed to a shell wrapper are code, not data: keep their contents.
const SHELL_WRAPPER_BEFORE_QUOTE = /(?:\b(?:sh|bash|zsh|fish)\s+-\w*c\w*|\beval)\s*$/;

// Replace '...' and "..." with "" (except shell-wrapper args, which are recursed).
// With keepExpanding, double-quoted strings containing `$` or a backtick are kept
// verbatim, since the shell still expands them.
export function stripQuotedText(command: string, keepExpanding = false): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === "\\") {
      out += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < command.length && command[j] !== ch) {
        if (ch === '"' && command[j] === "\\") j++;
        j++;
      }
      const inner = command.slice(i + 1, j);
      if (SHELL_WRAPPER_BEFORE_QUOTE.test(out)) out += ` ${stripQuotedText(inner, keepExpanding)} `;
      else if (keepExpanding && ch === '"' && /[$`]/.test(inner)) out += command.slice(i, j + 1);
      else out += '""';
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoped recursive rm: auto-allow only when every target is provably strictly
// inside the cwd tree. Anything ambiguous falls back to prompting.
// ---------------------------------------------------------------------------

const RM_RECURSIVE_PATTERN = /\brm\b[^\n;&|]*?\s-(?:[a-z]*r[a-z]*|-recursive)\b/i;
// Expansion/subshell syntax we can't statically resolve.
const UNRESOLVABLE_SYNTAX = /[$`(){}]/;
const GLOB_CHARS = /[*?[]/;
const PROTECTED_BASENAMES = new Set([".git"]);

// Split into command segments (on unquoted ; & | newline), with quotes removed
// from tokens. Returns undefined if quoting is unbalanced.
export function tokenizeSegments(command: string): string[][] | undefined {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let inToken = false;
  const endToken = () => {
    if (inToken) tokens.push(cur);
    cur = "";
    inToken = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\") {
      if (command[i + 1] === "\n") { i++; continue; } // line continuation
      cur += command[i + 1] ?? "";
      inToken = true;
      i++;
    } else if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      if (close === -1) return undefined;
      cur += command.slice(i + 1, close);
      inToken = true;
      i = close;
    } else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n") {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else {
      cur += ch;
      inToken = true;
    }
  }
  endSegment();
  return segments;
}

function isStrictlyInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function isInsideOrSame(base: string, target: string): boolean {
  return path.relative(base, target) === "" || isStrictlyInside(base, target);
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

function rmTargetIsScoped(target: string, curCwd: string, root: string): boolean {
  let t = target;
  if (t === "~" || t.startsWith("~/")) t = homedir() + t.slice(1);
  else if (t.startsWith("~")) return false; // ~user

  // For globs, only the literal directory prefix is checked (and must be
  // strictly inside root, so `rm -rf *` at the root still prompts).
  if (GLOB_CHARS.test(t)) {
    const parts = t.split("/");
    const firstGlob = parts.findIndex((p) => GLOB_CHARS.test(p));
    t = parts.slice(0, firstGlob).join("/") || (t.startsWith("/") ? "/" : ".");
  }

  const abs = path.resolve(curCwd, t);
  if (!isStrictlyInside(root, abs)) return false;
  if (abs.split(path.sep).some((seg) => PROTECTED_BASENAMES.has(seg))) return false;

  // Symlink check: the real location must also be inside the real root.
  const realRoot = safeRealpath(root) ?? root;
  if (existsSync(abs)) {
    const real = safeRealpath(abs);
    return real !== undefined && isStrictlyInside(realRoot, real);
  }
  let parent = path.dirname(abs);
  while (!existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
  const realParent = safeRealpath(parent);
  return realParent !== undefined && isInsideOrSame(realRoot, realParent);
}

// `<<WORD`, `<<-'WORD'`, `<<"WORD"`, `<<\WORD` (not `<<<` here-strings).
const HEREDOC_OP = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][\w.-]*))/g;
// Commands that could execute a heredoc body (or piped stdin) as shell code.
const SHELL_CONSUMER = /(?:^|[\s;&|(/])(?:(?:ba|z|da|k|fi)?sh|eval|source|xargs)(?=[\s;&|)]|$)|(?:^|[;&|\n])\s*\.\s/;

// Heredoc bodies are data (python/node scripts, file contents), not shell code,
// but their quotes/braces/`$` defeat the rm scope analysis. Returns `command`
// with bodies removed, or undefined when that isn't provably safe: a body that
// mentions a recursive rm, an unquoted-delimiter body with `$`/backtick
// expansion, a shell that could execute the body, or an unterminated heredoc.
export function stripHeredocBodies(command: string): string | undefined {
  if (!command.includes("<<")) return command;
  const lines = command.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    kept.push(line);
    for (const m of line.matchAll(HEREDOC_OP)) {
      const [, dash, single, double, backslash, bare] = m;
      const delim = single ?? double ?? bare;
      const quoted = single !== undefined || double !== undefined || backslash === "\\";
      const body: string[] = [];
      for (;;) {
        if (i >= lines.length) return undefined;
        const l = lines[i++];
        if ((dash ? l.replace(/^\t+/, "") : l) === delim) break;
        body.push(l);
      }
      const text = body.join("\n");
      if (RM_RECURSIVE_PATTERN.test(text)) return undefined;
      if (!quoted && /[$`]/.test(text)) return undefined;
    }
  }
  const stripped = kept.join("\n");
  return SHELL_CONSUMER.test(stripped) ? undefined : stripped;
}

// True when every recursive rm in `command` only targets paths strictly inside
// `cwd`. Tracks literal `cd <dir>`; bails on anything it can't resolve
// (vars, subshells, xargs/find -exec/bash -c wrappers, pushd, etc.).
export function isScopedRecursiveRm(rawCommand: string, cwd: string): boolean {
  const command = stripHeredocBodies(rawCommand);
  // Check shell-visible syntax only: literal quoted text (e.g. a `python3 -c "…"`
  // script) can't affect where rm points.
  if (!cwd || command === undefined || UNRESOLVABLE_SYNTAX.test(stripQuotedText(command, true))) {
    return false;
  }
  const segments = tokenizeSegments(command);
  if (!segments) return false;

  const root = path.resolve(cwd);
  let curCwd = root;
  let sawRm = false;

  for (const tokens of segments) {
    // Skip leading VAR=value assignments and `command` prefix.
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++;
    if (tokens[i] === "command") i++;
    const cmd = tokens[i];
    const args = tokens.slice(i + 1);

    if (cmd === "cd") {
      if (args.length !== 1 || args[0] === "-" || args[0].startsWith("~")) return false;
      curCwd = path.resolve(curCwd, args[0]);
      continue;
    }
    if (cmd === "pushd" || cmd === "popd") return false;

    if (!RM_RECURSIVE_PATTERN.test(tokens.join(" "))) continue;
    // The recursive rm appears here but isn't the command itself
    // (e.g. `xargs rm -rf`, `find -exec rm -rf`, `bash -c "rm -rf …"`).
    if (cmd !== "rm" && cmd !== "/bin/rm") return false;

    sawRm = true;
    const targets: string[] = [];
    let endOfOpts = false;
    for (const a of args) {
      if (!endOfOpts && a === "--") endOfOpts = true;
      else if (!endOfOpts && a.startsWith("-")) continue;
      else targets.push(a);
    }
    if (targets.length === 0) return false;
    if (!targets.every((t) => rmTargetIsScoped(t, curCwd, root))) return false;
  }
  return sawRm;
}

// Existing rules from the original permission-gate.ts extension.
const EXISTING_PERMISSION_RULES: PermissionRule[] = [
  {
    id: "existing.rm-recursive",
    reason: "Recursive removal can delete large parts of the filesystem.",
    // Matches any recursive rm (the destructive part), including split flags
    // (`rm -r -f`), combined flags (`rm -rf` / `-fr`), and `--recursive`.
    pattern: RM_RECURSIVE_PATTERN,
    allowIf: isScopedRecursiveRm,
  },
  {
    id: "existing.sudo",
    reason: "Privilege escalation can modify protected system files.",
    pattern: /\bsudo\b/i,
  },
  {
    id: "existing.chmod-chown-777",
    reason: "World-writable permissions or ownership changes can weaken security.",
    pattern: /\b(?:chmod|chown)\b[^\n;|&]*\b777\b/i,
  },
];

// Additional rules derived from safety_rules.md.
// Add new safety-policy rules here; the matching and prompt/block behavior below
// automatically includes every rule in this list.
const ADDITIONAL_SAFETY_RULES: PermissionRule[] = [
  {
    id: "safety.filesystem.find-delete",
    reason: "find -delete destructively removes matched files.",
    pattern: /\bfind\b[\s\S]*\s-delete\b/i,
  },
  {
    id: "safety.filesystem.shred",
    reason: "shred irreversibly overwrites file contents.",
    pattern: /\bshred\b/i,
  },
  {
    id: "safety.filesystem.mkfs",
    reason: "mkfs formats filesystems and can destroy data.",
    pattern: /\bmkfs(?:\.\w+)?\b/i,
  },
  {
    id: "safety.filesystem.dd-output",
    reason: "dd with an output target can overwrite disks or files.",
    pattern: /\bdd\b[\s\S]*\bof=/i,
  },
  {
    id: "safety.privilege.su-doas",
    reason: "Privilege escalation can modify protected system files.",
    pattern: /\b(?:su|doas)\b/i,
  },
  {
    id: "safety.permissions.world-writable",
    reason: "World-writable permissions weaken filesystem security.",
    pattern: /\bchmod\b[^\n;|&]*(?:\b777\b|-R\s+a\+w\b|a\+w\b)/i,
  },
  {
    id: "safety.ownership.recursive",
    reason: "Recursive ownership/group changes can break project or system permissions.",
    pattern: /\b(?:chown|chgrp)\b[^\n;|&]*\s-R\b/i,
  },
  {
    id: "safety.secrets.env-files",
    reason: "Reading .env files may expose secrets.",
    pattern: /\b(?:cat|less|more|head|tail)\b[^\n;|&]*\.env(?:\b|[./_-])/i,
  },
  {
    id: "safety.secrets.environment",
    reason: "Printing the environment may expose secrets.",
    pattern: /(?:^|[;&|]\s*)(?:printenv|env)(?:\s|$)/i,
  },
  {
    id: "safety.secrets.keychain-1password",
    reason: "Credential-store reads may expose secrets.",
    pattern: /\b(?:security\s+find-[\w-]+|op\s+read)\b/i,
  },
  {
    id: "safety.network.curl-pipe-shell",
    reason: "Piping downloaded content into a shell can execute untrusted code.",
    // Catches both `curl … | sh` and process substitution `sh <(curl …)`.
    pattern: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|fish)\b|\b(?:sh|bash|zsh|fish)\b[\s\S]*<\(\s*(?:curl|wget)\b/i,
  },
  {
    id: "safety.network.upload",
    reason: "Uploading files can exfiltrate local data.",
    pattern: /\bcurl\b[^\n;|&]*\s-F\b|\b(?:scp|rsync)\b[^\n;|&]*\b\w[\w.-]*@[^\s:]+:/i,
  },
  {
    id: "safety.process.kill-force",
    reason: "Force-killing processes can interrupt important work.",
    pattern: /\bkill\b[^\n;|&]*(?:-9|-KILL)\b|\bpkill\b/i,
  },
  {
    id: "safety.system.shutdown-reboot",
    reason: "Shutdown/reboot commands disrupt the host system.",
    pattern: /\b(?:shutdown|reboot)\b/i,
  },
  {
    id: "safety.system.launchctl-unload",
    reason: "Unloading launchctl services can disable system or user services.",
    pattern: /\blaunchctl\s+unload\b/i,
  },
  {
    id: "safety.package.global-mutation",
    reason: "Package installation mutates the user or system environment.",
    pattern: /\b(?:npm\s+install\s+-g|pip\s+install|brew\s+install|apt(?:-get)?\s+install)\b/i,
  },
];

// Git/GitHub write actions (formerly git-gate.ts, which hard-blocked them).
// push and PR/issue comment/review rules are intentionally disabled (commented out).
const commandBoundary = String.raw`(?:^|[\s;&|()])`;
const gitWithOptionalArgs = String.raw`git(?:\s+-\S+(?:\s+\S+)?)?`;
// Used only by the commented-out GitHub rules below.
const ghWithOptionalRepo = String.raw`gh(?:\s+--repo\s+\S+|\s+-R\s+\S+)?`;

const GIT_GITHUB_RULES: PermissionRule[] = [
  // {
  //   id: "git.push",
  //   reason: "git push publishes commits to a remote.",
  //   pattern: new RegExp(String.raw`${commandBoundary}${gitWithOptionalArgs}\s+push\b`, "i"),
  //   matchOn: "unquoted",
  // },
  {
    id: "git.reset",
    reason: "git reset can discard commits or uncommitted work.",
    pattern: new RegExp(String.raw`${commandBoundary}${gitWithOptionalArgs}\s+reset\b`, "i"),
    matchOn: "unquoted",
  },
  {
    id: "git.clean",
    reason: "git clean deletes untracked files.",
    pattern: new RegExp(String.raw`${commandBoundary}${gitWithOptionalArgs}\s+clean\b`, "i"),
    matchOn: "unquoted",
  },
  // {
  //   id: "github.pr-comment",
  //   reason: "gh pr comment posts a public PR comment.",
  //   pattern: new RegExp(String.raw`${commandBoundary}${ghWithOptionalRepo}\s+pr\s+comment\b`, "i"),
  //   matchOn: "unquoted",
  // },
  // {
  //   id: "github.issue-comment",
  //   reason: "gh issue comment posts a public issue/PR comment.",
  //   pattern: new RegExp(String.raw`${commandBoundary}${ghWithOptionalRepo}\s+issue\s+comment\b`, "i"),
  //   matchOn: "unquoted",
  // },
  // {
  //   id: "github.pr-review",
  //   reason: "gh pr review posts a public PR review.",
  //   pattern: new RegExp(String.raw`${commandBoundary}${ghWithOptionalRepo}\s+pr\s+review\b`, "i"),
  //   matchOn: "unquoted",
  // },
  // {
  //   id: "github.api-rest-comments",
  //   reason: "Writing PR/issue comments through gh api.",
  //   pattern: new RegExp(
  //     String.raw`${commandBoundary}${ghWithOptionalRepo}\s+api\b(?=[\s\S]*(?:POST|--method\s+(?:POST|PATCH|PUT)|-X\s*(?:POST|PATCH|PUT)))(?=[\s\S]*repos/[^\s]+/[^\s]+/(?:issues|pulls)/[^\s]+/comments)`,
  //     "i",
  //   ),
  // },
  // {
  //   id: "github.api-graphql-comments",
  //   reason: "Writing PR comments/reviews through GitHub GraphQL.",
  //   // Raw match: the mutation name usually lives inside a quoted query.
  //   pattern: new RegExp(
  //     String.raw`${commandBoundary}${ghWithOptionalRepo}\s+api\s+graphql\b(?=[\s\S]*(?:addComment|addPullRequestReview|addPullRequestReviewComment))`,
  //     "i",
  //   ),
  // },
  // {
  //   id: "github.curl-comments",
  //   reason: "Writing PR/issue comments through the GitHub API.",
  //   pattern: new RegExp(
  //     String.raw`${commandBoundary}curl\b(?=[\s\S]*(?:api\.github\.com|github\.com/api/v3))(?=[\s\S]*(?:-X\s*(?:POST|PATCH|PUT)|--request\s+(?:POST|PATCH|PUT)))(?=[\s\S]*/repos/[^\s]+/[^\s]+/(?:issues|pulls)/[^\s]+/comments)`,
  //     "i",
  //   ),
  // },
];

const PERMISSION_RULES = [...EXISTING_PERMISSION_RULES, ...ADDITIONAL_SAFETY_RULES, ...GIT_GITHUB_RULES];

// Exported for regression tests (see guardrails.test.ts).
// Without `cwd`, allowIf exemptions are not applied (strict mode).
export function matchedRule(command: string, cwd?: string): PermissionRule | undefined {
  const unquoted = stripQuotedText(command);
  return PERMISSION_RULES.find(
    (rule) =>
      rule.pattern.test(rule.matchOn === "unquoted" ? unquoted : command) &&
      !(cwd && rule.allowIf?.(command, cwd)),
  );
}

const SCRATCH_GUIDELINE =
  "Create temporary/scratch files and directories inside the current working directory tree " +
  "(e.g. ./.tmp/), never at the filesystem root or in system temp dirs (/tmp, $TMPDIR, mktemp defaults) " +
  "unless the user explicitly asks. Use literal relative paths for cleanup (e.g. `rm -rf ./.tmp/foo`): " +
  "recursive deletes strictly inside the cwd run without confirmation, while targets outside it, " +
  "variables, globs at the cwd root, or xargs/find -exec deletes require user approval.";

export default function(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const guidelines = event.systemPromptOptions.promptGuidelines;
    if (!guidelines.includes(SCRATCH_GUIDELINE)) guidelines.push(SCRATCH_GUIDELINE);
    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const input = event.input as { command?: unknown };
    const command = String(input.command ?? "");
    const rule = matchedRule(command, ctx.cwd);

    if (rule) {
      const message = `Rule: ${rule.id}\nReason: ${rule.reason}\nCommand: ${command}`;

      if (!ctx.hasUI) {
        // In non-interactive mode, block by default.
        return { block: true, reason: `Dangerous command blocked (no UI for confirmation). ${message}` };
      }

      const choice = await ctx.ui.select(`⚠️ Dangerous command:\n\n${message}\n\nAllow?`, ["Yes", "No"]);

      if (choice !== "Yes") {
        return { block: true, reason: `Blocked by user. ${message}` };
      }
    }

    return undefined;
  });
}
