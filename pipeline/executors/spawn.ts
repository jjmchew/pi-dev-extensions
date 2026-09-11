/**
 * Shared child-process plumbing for executors.
 *
 * Children are started in their own process group (`detached: true`) so that
 * aborting kills the whole tree — a `/bin/sh -c "a | b"` pipeline would
 * otherwise leave orphans. POSIX only; Windows is not supported.
 */
import { spawn, type ChildProcess } from "node:child_process";

export type SpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  abortGraceMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /**
   * When `"pipe"`, the child's stdin is a writable stream reachable via the
   * handle returned by `spawnChild`. `runChild` keeps the default `"ignore"`.
   */
  stdin?: "ignore" | "pipe";
};

export type SpawnResult = {
  exitCode: number;
  signalName?: string;
  aborted: boolean;
  spawnError?: string;
};

export type ChildHandle = {
  /** Resolves when the child exits (mirrors `runChild`'s return). */
  result: Promise<SpawnResult>;
  /** Write a raw string to the child's stdin. No-op if stdin is not piped. */
  write(data: string): boolean;
  /** Close the child's stdin. */
  closeStdin(): void;
  /** Kill the whole process group. */
  kill(sig?: NodeJS.Signals): void;
  /** OS process id, useful for logging. */
  pid?: number;
};

export function runChild(command: string, args: string[], opts: SpawnOptions): Promise<SpawnResult> {
  return spawnChild(command, args, opts).result;
}

export function spawnChild(command: string, args: string[], opts: SpawnOptions): ChildHandle {
  const stdinMode = opts.stdin ?? "ignore";
  let proc: ChildProcess;
  let spawnFailure: string | undefined;
  try {
    proc = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: [stdinMode, "pipe", "pipe"],
    });
  } catch (err) {
    spawnFailure = (err as Error).message;
    return {
      result: Promise.resolve({ exitCode: 127, aborted: false, spawnError: spawnFailure }),
      write: () => false,
      closeStdin: () => {},
      kill: () => {},
    };
  }

  let aborted = false;
  let spawnError: string | undefined;
  let settled = false;

  const killTree = (sig: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, sig);
      else proc.kill(sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };

  const onAbort = () => {
    aborted = true;
    killTree("SIGTERM");
    const t = setTimeout(() => {
      if (!settled) killTree("SIGKILL");
    }, opts.abortGraceMs ?? 2000);
    t.unref?.();
  };

  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  proc.stdout?.on("data", (d: Buffer) => opts.onStdout?.(d.toString()));
  proc.stderr?.on("data", (d: Buffer) => opts.onStderr?.(d.toString()));
  proc.on("error", (err) => {
    spawnError = err.message;
  });

  // Swallow EPIPE if a downstream close races with our write.
  proc.stdin?.on("error", () => {});

  const result = new Promise<SpawnResult>((resolveRun) => {
    proc.on("close", (code, signalName) => {
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      resolveRun({
        exitCode: code ?? (signalName ? 1 : spawnError ? 127 : 0),
        signalName: signalName ?? undefined,
        aborted,
        spawnError,
      });
    });
  });

  return {
    result,
    pid: proc.pid,
    write(data: string) {
      if (!proc.stdin || proc.stdin.destroyed) return false;
      return proc.stdin.write(data);
    },
    closeStdin() {
      try {
        proc.stdin?.end();
      } catch {
        /* already ended */
      }
    },
    kill(sig: NodeJS.Signals = "SIGTERM") {
      killTree(sig);
    },
  };
}

/** Keeps the last `max` bytes of a growing string (used for output tails). */
export class Tail {
  private buf = "";
  constructor(private readonly max: number) {}

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.max) this.buf = this.buf.slice(this.buf.length - this.max);
  }

  get value(): string {
    return this.buf;
  }
}

/** Splits a byte stream into complete lines, buffering the partial tail. */
export class LineSplitter {
  private buf = "";
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) this.onLine(line);
  }

  flush(): void {
    if (this.buf.length > 0) {
      const rest = this.buf;
      this.buf = "";
      this.onLine(rest);
    }
  }
}
