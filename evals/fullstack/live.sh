#!/usr/bin/env bash
# COMPREHENSIVE live eval: one real-provider session that must research,
# build a small full-stack app, run the server, live-test the API, verify,
# and reach the Completion Gate — exercising research, build, tool use,
# verification, and collaboration plumbing as one pipeline.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR=/tmp/syn-fullstack
LOG=$DIR-session.log
TRACE=$DIR-trace.log

if [ ! -f /tmp/.syn_eval_key ]; then
  echo "missing /tmp/.syn_eval_key"; exit 1
fi
export SYN_EVAL_KEY=$(cat /tmp/.syn_eval_key)

rm -rf "$DIR" "$LOG" "$TRACE"
mkdir -p "$DIR/.project-agent"

cat > "$DIR/.project-agent/config.toml" <<EOF
[model]
provider = "openai-compatible"
name = "deepseek-v4.1"
base_url = "https://vyceai.com/v1"
api_key_env = "SYN_EVAL_KEY"

[runtime]
autonomy = "autonomous"
max_total_tokens = 800000
max_tool_calls = 120
max_worker_spawns = 2
max_parallel_workers = 1

[[mcp.servers]]
name = "tick"
command = "node"
args = ["$DIR/.project-agent/mcp-tick.cjs"]
timeout_seconds = 15
EOF

# MCP time server: gives the model an out-of-band timestamp capability.
cat > "$DIR/.project-agent/mcp-tick.cjs" <<'EOF'
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", serverInfo: { name: "tick", version: "1" } } });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "time_now", description: "Returns the current server time and a random nonce", inputSchema: { type: "object", properties: {} } },
    ] } });
  } else if (msg.method === "tools/call") {
    const nonce = Math.random().toString(36).slice(2, 10);
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `time=${new Date().toISOString()} nonce=${nonce}` }] } });
  }
});
EOF

cd "$DIR"
FIFO=$DIR-in.fifo
mkfifo "$FIFO"

node --experimental-strip-types --no-warnings "$ROOT/src/index.ts" chat \
  < "$FIFO" > "$LOG" 2>&1 &
CHILD=$!
exec 3> "$FIFO"

send() {
  echo "send @$(date +%T): ${1:0:80}" >> "$TRACE"
  printf '%s\n' "$1" >&3
}

completed_count() {
  awk '/(completed|incomplete|cancelled|blocked) in [0-9]/{c++} END{print c+0}' "$LOG" 2>/dev/null
}
wait_turn() {
  local before="$1" n=0
  while [ $n -lt 300 ]; do
    [ "$(completed_count)" -gt "$before" ] && return 0
    n=$((n+1)); sleep 1
  done
  echo "WARN: turn timeout after 300s" >> "$TRACE"
  return 0
}

# ── Stage 1: MCP plumbing visible at boot ──
sleep 4
grep -q "mcp server 'tick'" "$LOG" \
  && echo "MARKER: 01 mcp boot OK" >> "$TRACE" \
  || echo "MARKER: 01 mcp boot MISSING" >> "$TRACE"

# ── Stage 2: RESEARCH — use web tools + mcp, record findings ──
B=$(completed_count)
send 'First, research: use web_search for "REST API design best practices status codes", then read_url on one promising result, and also call the mcp_tick_time_now tool once. Then write a short docs/RESEARCH.md capturing 3 best practices you found with the source URL, the current date from the tick tool, and what you verified vs could not. Reply DONE when the file exists.'
wait_turn "$B"
[ -f "$DIR/docs/RESEARCH.md" ] && grep -qiE "http|status" "$DIR/docs/RESEARCH.md" \
  && echo "MARKER: 02 research artifact OK" >> "$TRACE" \
  || echo "MARKER: 02 research artifact MISSING" >> "$TRACE"
grep -qE "nonce=[a-z0-9]+" "$LOG" \
  && echo "MARKER: 03 mcp tool round-trip OK" >> "$TRACE" \
  || echo "MARKER: 03 mcp tool round-trip MISSING" >> "$TRACE"
grep -q "tool_started\",\"data\":{\"name\":\"web_search\"" "$LOG" 2>/dev/null || grep -q 'web_search' "$LOG" \
  && echo "MARKER: 04 web_search used OK" >> "$TRACE" \
  || echo "MARKER: 04 web_search used MISSING" >> "$TRACE"
grep -q "tool_started\",\"data\":{\"name\":\"read_url" "$LOG" 2>/dev/null || grep -q "read_url" "$LOG" \
  && echo "MARKER: 05 read_url used OK" >> "$TRACE" \
  || echo "MARKER: 05 read_url used MISSING" >> "$TRACE"

# ── Stage 3: BUILD — full-stack app: server + client page ──
B=$(completed_count)
send 'Now build the app: (1) server.js — a zero-dependency Node HTTP REST API for notes: GET /api/notes returns JSON list, POST /api/notes with JSON {text} adds one and returns it with an id, GET / serves a client page. (2) public/index.html — a minimal client with a form that POSTs a note via fetch and lists notes. (3) test/app.test.js — node:test tests that start the server on an ephemeral port, POST a note, then GET /api/notes and assert the note round-trips. Run the tests until they pass.'
wait_turn "$B"
[ -f "$DIR/server.js" ] && [ -f "$DIR/public/index.html" ] \
  && echo "MARKER: 06 app artifacts OK" >> "$TRACE" \
  || echo "MARKER: 06 app artifacts MISSING" >> "$TRACE"
[ -f "$DIR/test/app.test.js" ] \
  && echo "MARKER: 07 tests authored OK" >> "$TRACE" \
  || echo "MARKER: 07 tests authored MISSING" >> "$TRACE"
# Tests green: the runtime records test_result(ok:true) from the exit code —
# stronger than grepping display output, which truncates tool results.
EV=$(ls "$DIR"/.project-agent/events/*.jsonl 2>/dev/null | tail -1)
[ -n "$EV" ] && grep -q '"kind":"test_result","data":{"ok":true' "$EV" \
  && echo "MARKER: 08 tests ran green OK" >> "$TRACE" \
  || echo "MARKER: 08 tests ran green MISSING" >> "$TRACE"

# ── Stage 4: RUN + LIVE-TEST — start the server, curl the live API ──
B=$(completed_count)
send 'Now live-test: start the server in the background with run_shell (node server.js > server.log 2>&1 & echo $! > server.pid), wait a second, then run_shell: curl -s -X POST http://localhost:3000/api/notes -H "Content-Type: application/json" -d "{\"text\":\"live smoke\"}" and then curl -s http://localhost:3000/api/notes and show me the outputs. Also curl the client page http://localhost:3000/ and confirm it returns HTML. Do not stop the server yet.'
wait_turn "$B"
grep -q "live smoke" "$LOG" \
  && echo "MARKER: 09 live API round-trip OK" >> "$TRACE" \
  || echo "MARKER: 09 live API round-trip MISSING" >> "$TRACE"
grep -qE "<html|<!DOCTYPE|<form" "$DIR/public/index.html" 2>/dev/null \
  && echo "MARKER: 10 client page built OK" >> "$TRACE" \
  || echo "MARKER: 10 client page built MISSING" >> "$TRACE"

# ── Stage 5: VERIFY + FINISH — stop the server cleanly, complete via gate ──
B=$(completed_count)
send 'Finish: run the test suite once more, stop the background server using the pid in server.pid (kill $(cat server.pid)), confirm with curl that the server is now down (connection refused is expected), and summarize what was researched, built, and live-tested.'
wait_turn "$B"
grep -q "turn_summary" "$LOG" 2>/dev/null || true  # observability asserted from the event log below
grep -qE "connection refused|ECONNREFUSED|not running" "$LOG" \
  && echo "MARKER: 11 server stopped cleanly OK" >> "$TRACE" \
  || echo "MARKER: 11 server stopped cleanly MISSING (non-fatal)" >> "$TRACE"

send "/status"
sleep 2
send "/collab"
sleep 2
send "/exit"
sleep 2
kill "$CHILD" 2>/dev/null
wait "$CHILD" 2>/dev/null
exec 3>&-

# ── Event-log assertions (runtime-verified behavior) ──
EV=$(ls "$DIR"/.project-agent/events/*.jsonl 2>/dev/null | tail -1)
if [ -n "$EV" ]; then
  grep -q '"kind":"web_search"' "$EV" 2>/dev/null || grep -q '"name":"web_search"' "$EV" \
    && echo "MARKER: 12 eventlog web_search OK" >> "$TRACE" \
    || echo "MARKER: 12 eventlog web_search MISSING" >> "$TRACE"
  grep -q '"kind":"turn_summary"' "$EV" \
    && echo "MARKER: 13 eventlog turn_summary OK" >> "$TRACE" \
    || echo "MARKER: 13 eventlog turn_summary MISSING" >> "$TRACE"
  grep -q '"kind":"task_completed"' "$EV" \
    && echo "MARKER: 14 eventlog task_completed OK" >> "$TRACE" \
    || echo "MARKER: 14 eventlog task_completed MISSING" >> "$TRACE"
  grep -q '"gate_verdict":"COMPLETE"' "$EV" \
    && echo "MARKER: 15 gate COMPLETE OK" >> "$TRACE" \
    || echo "MARKER: 15 gate COMPLETE MISSING" >> "$TRACE"
else
  echo "MARKER: 12-15 eventlog MISSING (no event log)" >> "$TRACE"
fi

echo "── trace markers ──"
cat "$TRACE"
PASS=$(grep -c " OK" "$TRACE")
SOFT=$(grep -c "non-fatal" "$TRACE")
FAIL=$(grep -c "MISSING" "$TRACE")
FAIL=$((FAIL - SOFT))
echo "eval: ${PASS} OK, ${SOFT} soft, ${FAIL} hard failures"
if [ "$FAIL" -eq 0 ]; then
  echo "eval: PASS"
  rm -rf "$DIR" "$LOG" "$TRACE"
else
  echo "eval: FAIL — artifacts kept: $DIR $LOG $TRACE"
  exit 1
fi
