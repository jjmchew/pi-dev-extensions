/**
 * Tiny registries for the three modularity seams: parsers, step executors and
 * reporters. Exported as module-level functions so third-party extensions can
 * `import` this file and register their own kinds.
 *
 * Duplicate registration fails loudly — silently shadowing a step kind would
 * make pipelines behave differently depending on extension load order.
 */
import type { PipelineParser, Reporter, StepExecutor } from "./types.ts";

const parsers = new Map<string, PipelineParser>();
const executors = new Map<string, StepExecutor<any>>();
const reporterFactories = new Map<string, ReporterFactory>();

export type ReporterFactory = (opts: any) => Reporter | undefined;

// ─── parsers ──────────────────────────────────────────────────────────────

export function registerParser(parser: PipelineParser, opts: { replace?: boolean } = {}): void {
  const ext = parser.ext.replace(/^\./, "");
  if (!opts.replace && parsers.has(ext)) {
    throw new Error(`pipeline: parser for ".${ext}" is already registered`);
  }
  parsers.set(ext, parser);
}

export function getParser(ext: string): PipelineParser | undefined {
  return parsers.get(ext.replace(/^\./, ""));
}

export function listParsers(): PipelineParser[] {
  return [...parsers.values()];
}

export function listParserExts(): string[] {
  return [...parsers.keys()];
}

// ─── executors ────────────────────────────────────────────────────────────

export function registerExecutor(executor: StepExecutor<any>, opts: { replace?: boolean } = {}): void {
  if (!opts.replace && executors.has(executor.kind)) {
    throw new Error(`pipeline: executor for kind "${executor.kind}" is already registered`);
  }
  executors.set(executor.kind, executor);
}

export function getExecutor(kind: string): StepExecutor<any> | undefined {
  return executors.get(kind);
}

export function listExecutorKinds(): string[] {
  return [...executors.keys()];
}

// ─── reporters ────────────────────────────────────────────────────────────

export function registerReporterFactory(name: string, factory: ReporterFactory, opts: { replace?: boolean } = {}): void {
  if (!opts.replace && reporterFactories.has(name)) {
    throw new Error(`pipeline: reporter "${name}" is already registered`);
  }
  reporterFactories.set(name, factory);
}

export function getReporterFactory(name: string): ReporterFactory | undefined {
  return reporterFactories.get(name);
}

export function listReporterNames(): string[] {
  return [...reporterFactories.keys()];
}

/** Test helper: wipe every registry. */
export function __resetRegistries(): void {
  parsers.clear();
  executors.clear();
  reporterFactories.clear();
}
