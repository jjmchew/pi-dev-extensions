/**
 * Settings access.
 *
 * Reads the `pipeline` key out of `~/.pi/agent/settings.json`. Deliberately
 * file-based (rather than importing pi's settings module) so that core code
 * stays testable outside a pi process.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PipelineSettings } from "./types.ts";

export function agentDir(): string {
  return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

let cached: PipelineSettings | undefined;
let cachedFor: string | undefined;

export function pipelineSettings(refresh = false): PipelineSettings {
  const file = join(agentDir(), "settings.json");
  if (!refresh && cached && cachedFor === file) return cached;
  let value: PipelineSettings = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && raw.pipeline && typeof raw.pipeline === "object") {
      value = raw.pipeline as PipelineSettings;
    }
  } catch {
    // Missing or malformed settings — defaults are fine.
  }
  cached = value;
  cachedFor = file;
  return value;
}

export const DEFAULTS = {
  outputTailBytes: 4096,
  abortGraceMs: 2000,
  maxConcurrency: 8,
  retention: { keepLast: 200, keepDays: 30, keepFailures: true },
};
