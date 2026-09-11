import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { executeRun } from "../core/execute.ts";
import { gcRuns } from "../core/gc.ts";
import { Redactor, filterEnv } from "../core/redact.ts";
import { appendIndexLine } from "../core/runsDir.ts";
import { registerExecutor } from "../core/registry.ts";
import { shellExecutor } from "../executors/shell.ts";
import { setupRegistries } from "./helpers.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

beforeEach(() => {
  setupRegistries();
  registerExecutor(shellExecutor);
  process.env.PI_AGENT_DIR = tmp("pipeline-agent-");
});

function project(yaml: string): string {
  const dir = tmp("pipeline-proj-");
  const pdir = join(dir, ".pi", "pipelines");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(pdir, "p.yaml"), yaml);
  return dir;
}

describe("redaction", () => {
  it("replaces known secret shapes and counts them", () => {
    const r = new Redactor();
    const { text, counts } = r.redact("key=sk-abcdefghijklmnopqrstuvwx and AKIAIOSFODNN7EXAMPLE\n");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(text).toContain("«redacted:openai-key»");
    expect(text).toContain("«redacted:aws-access-key»");
    expect(counts["openai-key"]).toBe(1);
    expect(counts["aws-access-key"]).toBe(1);
  });

  it("supports extra user patterns and ignores broken ones", () => {
    const r = new Redactor([
      { kind: "custom", pattern: "hunter2" },
      { kind: "broken", pattern: "([" },
    ]);
    expect(r.redact("pw=hunter2").text).toBe("pw=«redacted:custom»");
  });

  it("filters env down to the allowlist", () => {
    expect(filterEnv({ PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x", HOME: "/home/j" })).toEqual({
      PATH: "/bin",
      HOME: "/home/j",
    });
  });
});

describe("FileReporter disk layout", () => {
  it("writes the full run record", async () => {
    const runsDir = tmp("pipeline-runs-");
    const cwd = project(
      `name: disk\nsequence:\n  - shell: echo hello\n    id: greet\n    outputVar: greeting\n  - shell: "echo oops >&2; exit 1"\n    id: boom\n  - shell: echo never\n    id: never\n`,
    );

    const result = await executeRun({ name: "p", cwd, runsDirFlag: runsDir });
    expect(result.status).toBe("failed");
    const runDir = result.runDir!;

    // manifest is atomic: run.json exists, run.partial.json is gone
    expect(existsSync(join(runDir, "run.json"))).toBe(true);
    expect(existsSync(join(runDir, "run.partial.json"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
    expect(manifest.schema).toBe("pipeline.v1");
    expect(manifest.pipeline).toBe("disk");
    expect(manifest.totals.steps).toEqual({ total: 3, ok: 1, failed: 1, skipped: 1 });
    expect(manifest.steps.map((s: any) => [s.id, s.ok, s.skipped ?? false])).toEqual([
      ["greet", true, false],
      ["boom", false, false],
      ["never", true, true],
    ]);
    expect(manifest.steps[0].path).toBe("root.sequence[0].shell");
    // env is allowlisted, never a full dump
    expect(Object.keys(manifest.env).every((k) => !k.includes("SECRET"))).toBe(true);
    expect(manifest.env.RUN_ID).toBe(result.runId);

    // frozen plan
    expect(JSON.parse(readFileSync(join(runDir, "plan.json"), "utf8")).name).toBe("disk");

    // event log carries the wire event names verbatim
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ type: "run_start", pipeline: "disk" });
    expect(events.at(-1)).toMatchObject({ type: "run_end", status: "failed" });
    expect(events.every((e) => typeof e.t === "string")).toBe(true);

    // per-step files
    expect(readFileSync(join(runDir, "steps", "greet", "stdout.log"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(runDir, "steps", "boom", "stderr.log"), "utf8")).toBe("oops\n");
    const stepJson = JSON.parse(readFileSync(join(runDir, "steps", "greet", "step.json"), "utf8"));
    expect(stepJson).toMatchObject({ id: "greet", kind: "shell", ok: true, exitCode: 0 });
    expect(stepJson.artifacts).toContain("greet.stdout.tail");
    expect(stepJson.artifacts).toContain("greet.greeting");

    // content-addressed artifacts: identical content is stored once
    const ref = JSON.parse(readFileSync(join(runDir, "artifacts", "refs", "greet.greeting.json"), "utf8"));
    expect(ref).toMatchObject({ mime: "text/plain", bytes: 6 });
    const shardDir = join(runDir, "artifacts", "sha256", ref.sha256.slice(0, 2));
    expect(readdirSync(shardDir)).toEqual([ref.sha256]);
    const tailRef = JSON.parse(readFileSync(join(runDir, "artifacts", "refs", "greet.stdout.tail.json"), "utf8"));
    expect(tailRef.sha256).toBe(ref.sha256); // same bytes → same blob

    // index.jsonl
    const index = readFileSync(join(runsDir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({ runId: result.runId, pipeline: "disk", status: "failed", cwd });
  });

  it("redacts secrets in logs but records the count", async () => {
    const runsDir = tmp("pipeline-runs-");
    const cwd = project(`sequence:\n  - shell: echo token=sk-abcdefghijklmnopqrstuvwx\n    id: leak\n`);
    const result = await executeRun({ name: "p", cwd, runsDirFlag: runsDir });
    const log = readFileSync(join(result.runDir!, "steps", "leak", "stdout.log"), "utf8");
    expect(log).toContain("«redacted:openai-key»");
    expect(log).not.toContain("sk-abcdefghij");
    const stepJson = JSON.parse(readFileSync(join(result.runDir!, "steps", "leak", "step.json"), "utf8"));
    expect(stepJson.redactions["openai-key"]).toBe(1);
    // the `log` chunks embedded in events.jsonl are redacted as well
    const logLines = readFileSync(join(result.runDir!, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === "log");
    expect(logLines).toHaveLength(1);
    expect(logLines[0].chunk).toContain("«redacted:openai-key»");
    // …but step results are deliberately NOT redacted: they feed ${steps.*}
    // interpolation and eval export (see the spec's PII section).
    expect(JSON.parse(readFileSync(join(result.runDir!, "events.jsonl"), "utf8").split("\n")[3]!).details.output).toContain(
      "sk-abcdefghij",
    );
  });

  it("leaves a readable run.partial.json while a run is in flight", async () => {
    const runsDir = tmp("pipeline-runs-");
    const cwd = project(`sequence:\n  - shell: sleep 5\n    id: slow\n`);
    const controller = new AbortController();
    let partial: any;
    const done = executeRun({
      name: "p",
      cwd,
      runsDirFlag: runsDir,
      signal: controller.signal,
      onEvent: (evt) => {
        if (evt.type === "step_start") {
          const dirs = readdirSync(runsDir).filter((d) => !d.startsWith("."));
          partial = JSON.parse(readFileSync(join(runsDir, dirs[0]!, "run.partial.json"), "utf8"));
          controller.abort();
        }
      },
    });
    const result = await done;
    expect(partial).toMatchObject({ schema: "pipeline.v1", status: "partial" });
    expect(result.status).toBe("aborted");
  });
});

describe("index append", () => {
  it("serialises concurrent appends into whole lines", () => {
    const runsDir = tmp("pipeline-runs-");
    for (let i = 0; i < 25; i++) appendIndexLine(runsDir, { runId: `r${i}`, blob: "x".repeat(200) });
    const lines = readFileSync(join(runsDir, "index.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(25);
    expect(lines.every((l) => JSON.parse(l).blob.length === 200)).toBe(true);
  });
});

describe("gc", () => {
  it("keeps failures, drops surplus successes, and skips in-progress runs", () => {
    const runsDir = tmp("pipeline-runs-");
    const write = (id: string, manifest: any, partial = false) => {
      mkdirSync(join(runsDir, id), { recursive: true });
      writeFileSync(join(runsDir, id, partial ? "run.partial.json" : "run.json"), JSON.stringify(manifest));
    };
    const now = Date.now();
    write("old-ok", { status: "ok", endedAt: new Date(now - 90 * 864e5).toISOString() });
    write("old-failed", { status: "failed", endedAt: new Date(now - 90 * 864e5).toISOString() });
    write("fresh-ok", { status: "ok", endedAt: new Date(now).toISOString() });
    write("in-progress", { status: "partial" }, true);

    const res = gcRuns(runsDir, now);
    expect(res.deleted).toEqual(["old-ok"]);
    expect(res.skipped).toBe(1);
    expect(existsSync(join(runsDir, "old-failed"))).toBe(true);
    expect(existsSync(join(runsDir, "fresh-ok"))).toBe(true);
    expect(existsSync(join(runsDir, "in-progress"))).toBe(true);
  });
});
