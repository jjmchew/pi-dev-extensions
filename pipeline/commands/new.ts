/**
 * `/pipeline:new <name>` — scaffold a commented pipeline into
 * `<cwd>/.pi/pipelines/<name>.yaml`, and `/pipeline:edit <name>` — open an
 * existing one.
 *
 * Deliberately minimal (the spec leaves richer scaffolding TBD).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { PIPELINES_SUBDIR, resolvePipelineFile } from "../core/loader.ts";
import { say, type CmdCtx } from "./ctx.ts";

export function template(name: string): string {
  return `# yaml-language-server: $schema=../../../.pi/agent/extensions/pipeline/schema/pipeline.schema.json
name: ${name}
description: describe what this pipeline does

# The root must be exactly one composer: \`sequence:\` or \`parallel:\`.
sequence:
  - shell: echo "hello from ${name}"
    id: hello           # explicit ids are required to reference a step later

  # - parallel:
  #     - shell: yarn lint
  #       id: lint
  #     - shell: yarn test:unit
  #       id: tests
  #       continueOnError: true

  # - llm:
  #     skill: code-review
  #   id: review
  #   outputVar: reviewText
  #   when: success(hello)

  # - shell:
  #     cmd: echo
  #     args: ["\${steps.review.vars.reviewText}"]
  #   when: always()
`;
}

export async function newCommand(args: string, ctx: CmdCtx): Promise<void> {
  const name = (args ?? "").trim().split(/\s+/)[0];
  if (!name) {
    say(ctx, "usage: /pipeline:new <name>", "warn");
    return;
  }
  const dir = join(ctx.cwd, PIPELINES_SUBDIR);
  const file = join(dir, `${name}.yaml`);
  if (existsSync(file)) {
    say(ctx, `pipeline "${name}" already exists at ${file}`, "warn");
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, template(name));
  say(ctx, `created ${file}`, "success");
}

export async function editCommand(args: string, ctx: CmdCtx): Promise<void> {
  const name = (args ?? "").trim().split(/\s+/)[0];
  if (!name) {
    say(ctx, "usage: /pipeline:edit <name>", "warn");
    return;
  }
  const file = resolvePipelineFile(name, ctx.cwd);
  if (!file) {
    say(ctx, `pipeline "${name}" not found — create it with /pipeline:new ${name}`, "error");
    return;
  }

  // Prefer pi's in-TUI editor; fall back to $EDITOR.
  if (ctx.hasUI && ctx.ui?.editor) {
    const current = readFileSync(file, "utf8");
    const edited = await ctx.ui.editor({ title: `edit ${file}`, initialText: current, extension: "yaml" });
    if (edited !== undefined && edited !== current) {
      writeFileSync(file, edited);
      say(ctx, `saved ${file}`, "success");
    }
    return;
  }

  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) {
    say(ctx, `no $EDITOR set — the pipeline lives at ${file}`, "warn");
    return;
  }
  await new Promise<void>((resolveEdit) => {
    const proc = spawn(editor, [file], { stdio: "inherit" });
    proc.on("close", () => resolveEdit());
    proc.on("error", () => resolveEdit());
  });
}
