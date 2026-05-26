/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 *
 * Existing rules are kept separate from rules imported from safety_rules.md so
 * future rules can be appended to ADDITIONAL_SAFETY_RULES without changing the
 * gate logic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PermissionRule = {
  id: string;
  reason: string;
  pattern: RegExp;
};

// Existing rules from the original permission-gate.ts extension.
const EXISTING_PERMISSION_RULES: PermissionRule[] = [
  {
    id: "existing.rm-recursive",
    reason: "Recursive removal can delete large parts of the filesystem.",
    pattern: /\brm\s+(?:-[\w-]*r[\w-]*f|-[\w-]*f[\w-]*r|--recursive)\b/i,
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
    pattern: /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|fish)\b/i,
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

const PERMISSION_RULES = [...EXISTING_PERMISSION_RULES, ...ADDITIONAL_SAFETY_RULES];

function matchedRule(command: string): PermissionRule | undefined {
  return PERMISSION_RULES.find((rule) => rule.pattern.test(command));
}

export default function(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    const input = event.input as { command?: unknown };
    const command = String(input.command ?? "");
    const rule = matchedRule(command);

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
