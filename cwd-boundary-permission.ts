/**
 * CWD Boundary Permission Extension
 *
 * Requests user permission before allowing built-in write/edit tools to modify
 * files outside of pi's current working directory (ctx.cwd) and its
 * subdirectories.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function isInsideOrSame(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function nearestExistingPath(targetPath: string): string | undefined {
  let current = targetPath;

  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }

  return current;
}

function resolvesOutsideCwd(inputPath: string, cwd: string): { outside: boolean; absolutePath: string; cwd: string } {
  const absoluteCwd = path.resolve(cwd);
  const absolutePath = path.resolve(absoluteCwd, inputPath);

  // Lexical check catches obvious paths such as ../file or /tmp/file.
  if (!isInsideOrSame(absoluteCwd, absolutePath)) {
    return { outside: true, absolutePath, cwd: absoluteCwd };
  }

  // Realpath check catches writes through existing symlinks inside cwd that
  // point outside the project tree, while still allowing new files under cwd.
  try {
    const realCwd = realpathSync(absoluteCwd);
    const existing = nearestExistingPath(absolutePath);
    if (!existing) return { outside: false, absolutePath, cwd: absoluteCwd };

    const realExisting = realpathSync(existing);
    if (!isInsideOrSame(realCwd, realExisting)) {
      return { outside: true, absolutePath, cwd: absoluteCwd };
    }
  } catch {
    // If realpath fails, keep the lexical decision rather than blocking normal work.
  }

  return { outside: false, absolutePath, cwd: absoluteCwd };
}

export default function(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

    const inputPath = event.input.path as string | undefined;
    if (!inputPath) return undefined;

    const check = resolvesOutsideCwd(inputPath, ctx.cwd);
    if (!check.outside) return undefined;

    const message = `${event.toolName} wants to modify a file outside the current directory.\n\nCurrent directory:\n  ${check.cwd}\n\nTarget path:\n  ${check.absolutePath}\n\nAllow this operation?`;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Blocked ${event.toolName} outside current directory: ${check.absolutePath} (no UI for confirmation)`,
      };
    }

    const allowed = await ctx.ui.confirm("Allow file modification outside cwd?", message);
    if (!allowed) {
      return { block: true, reason: `User denied ${event.toolName} outside current directory: ${check.absolutePath}` };
    }

    return undefined;
  });
}
