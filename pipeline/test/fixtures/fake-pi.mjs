#!/usr/bin/env node
/**
 * Fake `pi --mode json` for tests: prints a canned NDJSON stream shaped like
 * the real one (docs/json.md), then exits.
 *
 * Env knobs:
 *   FAKE_PI_EXIT      exit code (default 0)
 *   FAKE_PI_TEXT      final assistant text (default "done")
 *   FAKE_PI_HANG=1    never exit (for abort tests)
 *   FAKE_PI_GARBAGE=1 emit a non-JSON line and a stderr line too
 *   FAKE_PI_ECHO_ARGV=1 print the received argv as a stderr line
 *   FAKE_PI_ERROR=1   final message carries a provider error (exit code stays 0)
 *   FAKE_PI_NO_TURNS=1 exit cleanly after agent_start without emitting message_end
 */
const args = process.argv.slice(2);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (process.env.FAKE_PI_ECHO_ARGV === "1") {
  process.stderr.write(`argv:${JSON.stringify(args)}\n`);
}

out({ type: "session", version: 3, id: "fake", cwd: process.cwd() });
out({ type: "agent_start" });

if (process.env.FAKE_PI_NO_TURNS === "1") {
  out({ type: "agent_end", messages: [] });
  process.exit(Number(process.env.FAKE_PI_EXIT ?? "0"));
}

if (process.env.FAKE_PI_GARBAGE === "1") {
  process.stdout.write("not json at all\n");
  process.stderr.write("a warning\n");
}

out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { output: "a.txt" }, isError: false });

if (process.env.FAKE_PI_ERROR === "1") {
  out({
    type: "message_end",
    message: {
      role: "assistant",
      model: "fake/model-1",
      stopReason: "error",
      errorMessage: "Connection error.",
      content: [],
      usage: { input: 0, output: 0, cost: { total: 0 } },
    },
  });
} else {
  out({
    type: "message_end",
    message: {
      role: "assistant",
      model: "fake/model-1",
      stopReason: "stop",
      content: [{ type: "text", text: process.env.FAKE_PI_TEXT ?? "done" }],
      usage: { input: 100, output: 20, cost: { total: 0.01 }, totalTokens: 120 },
    },
  });
}
out({ type: "agent_end", messages: [] });

if (process.env.FAKE_PI_HANG === "1") {
  setInterval(() => {}, 1000);
} else {
  process.exit(Number(process.env.FAKE_PI_EXIT ?? "0"));
}
