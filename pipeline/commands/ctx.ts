/**
 * The slice of pi's ExtensionContext the pipeline commands actually use.
 *
 * Declared structurally (rather than imported from the host package) so the
 * command modules stay unit-testable with a plain mock object.
 */
export type CmdCtx = {
  cwd: string;
  hasUI?: boolean;
  mode?: string;
  signal?: AbortSignal;
  ui: {
    notify?: (message: string, level?: "info" | "warn" | "error" | "success") => void;
    setWidget?: (id: string, lines: string[] | undefined) => void;
    editor?: (...args: any[]) => Promise<string | undefined>;
  };
  sessionManager?: { getSessionFile?: () => string | undefined };
};

/** Print to the user: notification in a UI, stdout otherwise. */
export function say(ctx: CmdCtx, message: string, level: "info" | "warn" | "error" | "success" = "info"): void {
  if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(message, level);
  else process.stdout.write(`${message}\n`);
}

/** Tiny flag parser: returns positional text plus recognised --flags. */
export function parseArgs(
  input: string,
  flagNames: string[],
): { positional: string; flags: Record<string, string | boolean> } {
  const tokens = tokenizeArgs(input);
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = (eq === -1 ? tok.slice(2) : tok.slice(2, eq)).trim();
      if (!flagNames.includes(name)) {
        rest.push(tok);
        continue;
      }
      if (eq !== -1) {
        flags[name] = tok.slice(eq + 1);
      } else {
        const next = tokens[i + 1];
        if (next && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }
    rest.push(tok);
  }
  return { positional: rest.join(" "), flags };
}

export function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
