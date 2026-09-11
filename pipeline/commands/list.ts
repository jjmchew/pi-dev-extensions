/** `/pipeline:list` — discovered pipelines, their source, and shadowing. */
import { discoverPipelines, pipelineDirs } from "../core/loader.ts";
import { say, type CmdCtx } from "./ctx.ts";

export async function listCommand(_args: string, ctx: CmdCtx): Promise<void> {
  const found = discoverPipelines(ctx.cwd);
  if (found.length === 0) {
    say(
      ctx,
      "no pipelines found. Searched:\n" + pipelineDirs(ctx.cwd).map((d) => `  ${d.dir}`).join("\n") +
        "\n  create one with /pipeline:new <name>",
      "warn",
    );
    return;
  }
  const width = Math.max(...found.map((f) => f.name.length));
  const lines = found.map((f) => {
    const marker = f.shadowedBy ? "  (shadowed)" : "";
    return `  ${f.name.padEnd(width)}  ${f.scope.padEnd(7)}  ${f.file}${marker}`;
  });
  say(ctx, `pipelines:\n${lines.join("\n")}`);
}
