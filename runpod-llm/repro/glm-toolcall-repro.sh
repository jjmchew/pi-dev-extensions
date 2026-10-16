#!/usr/bin/env bash
# Reproduces GLM tool calls coming back as plain text instead of `tool_calls`.
# Uses raw curl against the OpenAI-compatible endpoint. Redacts the API key.
# Usage: ./glm-toolcall-repro.sh [model] [control-model]
set -uo pipefail

MODEL="${1:-zai-org/GLM-5.3}"
CONTROL_MODEL="${2:-moonshotai/Kimi-K3}"
CFG="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/models.json"
BASE_URL="${RUNPOD_BASE_URL:-$(jq -r '.providers["runpod-llm"].baseUrl' "$CFG")}"
API_KEY="${RUNPOD_LITELLM_API_KEY:-$(jq -r '.providers["runpod-llm"].apiKey' "$CFG")}"
BASE_URL="${BASE_URL%/}"

DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/glm-toolcall-report-$STAMP.md"
TMP="$(mktemp -d "$DIR/.tmp.XXXX")"
trap 'rm -rf "$TMP"' EXIT

redact() { sed -e "s|$API_KEY|<REDACTED>|g" -e 's|Bearer [A-Za-z0-9._-]*|Bearer <REDACTED>|g'; }
log() { printf '%s\n' "$*" >>"$OUT"; }

TOOLS='[{
  "type": "function",
  "function": {
    "name": "bash",
    "description": "Execute a bash command and return stdout/stderr.",
    "parameters": {
      "type": "object",
      "properties": { "command": { "type": "string", "description": "The shell command to run" } },
      "required": ["command"]
    }
  }
}]'
SYS='You are a coding assistant. Use the provided tools to act. Do not describe tool calls in text; invoke them.'
USER_MSG='List the files in the current directory. Use the bash tool.'

# body <model> <tool_choice|none> <stream:true|false>
body() {
  local model="$1" choice="$2" stream="$3"
  jq -n --arg m "$model" --arg sys "$SYS" --arg u "$USER_MSG" --argjson tools "$TOOLS" \
        --arg choice "$choice" --argjson stream "$stream" '
    {model: $m, max_tokens: 2048, temperature: 0, stream: $stream,
     messages: [{role:"system", content:$sys}, {role:"user", content:$u}]}
    + (if $choice == "none" then {} else {tools: $tools} end)
    + (if $choice == "auto" or $choice == "required" then {tool_choice: $choice}
       elif $choice == "named" then {tool_choice: {type:"function", function:{name:"bash"}}}
       else {} end)'
}

# run <title> <model> <tool_choice> <stream>
N=0
run() {
  local title="$1" model="$2" choice="$3" stream="$4"
  N=$((N+1))
  local req="$TMP/req$N.json" hdr="$TMP/hdr$N.txt" res="$TMP/res$N.txt"
  body "$model" "$choice" "$stream" >"$req"

  local t0 t1 code
  t0=$(date +%s)
  code=$(curl -sS -o "$res" -D "$hdr" -w '%{http_code}' --max-time 300 \
    -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" \
    -X POST "$BASE_URL/chat/completions" --data @"$req" 2>"$TMP/err$N")
  t1=$(date +%s)

  log "## Test $N: $title"
  log ""
  log "- model: \`$model\` · tool_choice: \`$choice\` · stream: \`$stream\` · HTTP \`$code\` · $((t1-t0))s"

  if [[ "$stream" == "false" ]] && jq -e . "$res" >/dev/null 2>&1; then
    local summary
    summary=$(jq -r '
      .choices[0] as $c |
      "- finish_reason: `\($c.finish_reason)`",
      "- message.tool_calls: `\(($c.message.tool_calls // []) | length)` entries",
      "- message.content contains \"<tool_call>\": `\((($c.message.content // "") | test("<tool_call>")))`",
      "- message.reasoning_content present: `\(($c.message.reasoning_content // "") | length > 0)`"' "$res")
    log "$summary"
  elif [[ "$stream" == "true" ]]; then
    local tc_chunks content
    tc_chunks=$(grep -c '"tool_calls"' "$res" || true)
    content=$(grep '^data: {' "$res" | sed 's/^data: //' | jq -rj '.choices[0].delta.content // empty' 2>/dev/null)
    log "- SSE chunks containing \`tool_calls\`: \`$tc_chunks\`"
    log "- finish_reason(s): \`$(grep -o '"finish_reason":"[a-z_]*"' "$res" | sort -u | tr '\n' ' ')\`"
    log "- concatenated delta.content contains \"<tool_call>\": \`$([[ "$content" == *"<tool_call>"* ]] && echo true || echo false)\`"
  fi
  [[ -s "$TMP/err$N" ]] && log "- curl error: \`$(redact <"$TMP/err$N")\`"

  log ""
  log "<details><summary>Request</summary>"
  log ""
  log '```bash'
  log "curl -sS -X POST '$BASE_URL/chat/completions' \\"
  log "  -H 'Content-Type: application/json' -H 'Authorization: Bearer <REDACTED>' \\"
  log "  --data '$(jq -c . "$req" | sed "s/'/'\\\\''/g")'"
  log '```'
  log "</details>"
  log ""
  log "<details><summary>Response headers</summary>"
  log ""
  log '```'
  redact <"$hdr" | tr -d '\r' >>"$OUT"
  log '```'
  log "</details>"
  log ""
  log "<details open><summary>Response body</summary>"
  log ""
  log '```json'
  if [[ "$stream" == "false" ]]; then (jq . "$res" 2>/dev/null || cat "$res") | redact >>"$OUT"; else redact <"$res" >>"$OUT"; fi
  log '```'
  log "</details>"
  log ""
}

{
  echo "# Tool calling repro: \`$MODEL\`"
  echo ""
  echo "- Generated: $(date -u '+%Y-%m-%d %H:%M:%SZ')"
  echo "- Endpoint: \`$BASE_URL/chat/completions\` (OpenAI-compatible)"
  echo "- Control model: \`$CONTROL_MODEL\`"
  echo ""
  echo "## Issue"
  echo ""
  echo "When a request includes \`tools\`, \`$MODEL\` puts the tool call in \`message.content\` as plain text"
  echo "(\`<tool_call>...\`). It should be returned as structured \`message.tool_calls\` with \`finish_reason: \"tool_calls\"\`."
  echo "This suggests the inference server is missing tool-call parsing for this model (for vLLM:"
  echo "\`--enable-auto-tool-choice --tool-call-parser <glm parser>\`, plus a chat template that renders \`tools\`),"
  echo "or the proxy is dropping \`tools\`."
  echo ""
  echo "Expected: \`choices[0].message.tool_calls[0].function.name == \"bash\"\`, \`finish_reason == \"tool_calls\"\`."
  echo ""
} >"$OUT"

# Model listing
code=$(curl -sS -o "$TMP/models.json" -w '%{http_code}' --max-time 60 -H "Authorization: Bearer $API_KEY" "$BASE_URL/models")
log "## Test 0: GET /models"
log ""
log "- HTTP \`$code\` · \`$MODEL\` listed: \`$(jq --arg m "$MODEL" '[.data[]?.id] | index($m) != null' "$TMP/models.json" 2>/dev/null)\`"
log ""
log '```json'
(jq '[.data[]? | {id, owned_by}]' "$TMP/models.json" 2>/dev/null || cat "$TMP/models.json") | redact >>"$OUT"
log '```'
log ""

run "Baseline: no tools (server is healthy)"           "$MODEL"         none     false
run "tools + tool_choice=auto"                          "$MODEL"         auto     false
run "tools + tool_choice=required"                      "$MODEL"         required false
run "tools + tool_choice={function: bash}"              "$MODEL"         named    false
run "tools + tool_choice=auto, streaming"               "$MODEL"         auto     true
run "CONTROL: same request, different model"            "$CONTROL_MODEL" auto     false

echo "Report: $OUT"
