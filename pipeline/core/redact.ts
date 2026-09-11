/**
 * Secret redaction for captured stdout/stderr, plus the env allowlist used in
 * `run.json`.
 *
 * Redaction is applied ONLY to `log` events (and therefore to stdout.log /
 * stderr.log and the log chunks embedded in events.jsonl). `trace.jsonl` and
 * `refs/finalOutput.json` are left verbatim so eval fidelity is preserved —
 * see `pipeline.redactTraces` in the spec's follow-ups.
 */

export type RedactPattern = { kind: string; re: RegExp };

const DEFAULT_PATTERNS: RedactPattern[] = [
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "aws-secret", re: /\b[A-Za-z0-9/+=]{40}\b(?=\s*$|["',\s])/g },
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9_\-]{16,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_\-]{16,}\b/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: "bearer-token", re: /\b[Bb]earer\s+[A-Za-z0-9._\-]{20,}\b/g },
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

export const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
  "PIPELINE_CWD",
  "REPO_ROOT",
  "GIT_BRANCH",
  "GIT_COMMIT",
  "RUN_ID",
];

export class Redactor {
  private patterns: RedactPattern[];

  constructor(extra?: Array<{ kind: string; pattern: string; flags?: string }>) {
    this.patterns = [...DEFAULT_PATTERNS];
    for (const p of extra ?? []) {
      try {
        this.patterns.push({ kind: p.kind, re: new RegExp(p.pattern, p.flags ?? "g") });
      } catch {
        // A bad user-supplied pattern must not take the run down.
      }
    }
  }

  redact(text: string): { text: string; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    let out = text;
    for (const { kind, re } of this.patterns) {
      re.lastIndex = 0;
      out = out.replace(re, () => {
        counts[kind] = (counts[kind] ?? 0) + 1;
        return `«redacted:${kind}»`;
      });
    }
    return { text: out, counts };
  }
}

export function filterEnv(env: Record<string, string>, allowlist = DEFAULT_ENV_ALLOWLIST): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    if (env[key] !== undefined) out[key] = env[key]!;
  }
  return out;
}

export function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}
