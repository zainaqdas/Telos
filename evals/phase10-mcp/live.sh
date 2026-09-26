#!/usr/bin/env bash
# LIVE MCP eval: a real MCP server subprocess declared in config.toml, driven
# by the real provider (deepseek-v4.1 via vyceai). Verifies Part 55 live:
# startup notice → model chooses the mcp_ tool → tool_call round-trip through
# the real loop → result reaches the model → budget counts it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR=/tmp/syn-mcp-live
LOG=$DIR-session.log
TRACE=$DIR-trace.log

if [ ! -f /tmp/.syn_eval_key ]; then
  echo "missing /tmp/.syn_eval_key"; exit 1
fi
export SYN_EVAL_KEY=$(cat /tmp/.syn_eval_key)

rm -rf "$DIR" "$LOG" "$TRACE"
mkdir -p "$DIR/.project-agent"

# Real MCP server subprocess: tools/time_now returns a timestamp the model
# could not otherwise know (proves the result came through the tool).
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

cat > "$DIR/.project-agent/config.toml" <<EOF
[model]
provider = "openai-compatible"
name = "deepseek-v4.1"
base_url = "https://vyceai.com/v1"
api_key_env = "SYN_EVAL_KEY"

[runtime]
autonomy = "autonomous"
max_total_tokens = 400000
max_tool_calls = 90
max_worker_spawns = 0
max_parallel_workers = 0

[[mcp.servers]]
name = "tick"
command = "node"
args = ["$DIR/.project-agent/mcp-tick.cjs"]
timeout_seconds = 15
EOF

# FIFO driver (harness lessons: cd into the stage so the session finds
# .project-agent/config.toml; pipefail-safe waits; no unbracketed pkill)
cd "$DIR"
FIFO=$DIR-in.fifo
mkfifo "$FIFO"

node --experimental-strip-types --no-warnings "$ROOT/src/index.ts" chat \
  < "$FIFO" > "$LOG" 2>&1 &
CHILD=$!
exec 3> "$FIFO"   # keep the FIFO open for the whole session

send() {
  echo "send @$(date +%T): ${1:0:70}" >> "$TRACE"
  printf '%s\n' "$1" >&3
}

wait_prompt() {
  local n=0
  while [ $n -lt 240 ]; do
    if tail -n 3 "$LOG" 2>/dev/null | grep -q '^> $'; then return 0; fi
    n=$((n+1)); sleep 1
  done
  echo "WARN: wait_prompt timed out after 240s" >> "$TRACE"
  return 0
}

# Wait for a TURN to finish: count completion markers before the send and
# poll until the count grows (the idle '> ' prompt appears at boot, so a
# stale prompt match would race the actual turn).
completed_count() {
  awk '/(completed|incomplete|cancelled) in [0-9]/{c++} END{print c+0}' "$LOG" 2>/dev/null
}
wait_turn() {
  local before="$1" n=0
  while [ $n -lt 180 ]; do
    [ "$(completed_count)" -gt "$before" ] && return 0
    n=$((n+1)); sleep 1
  done
  echo "WARN: turn timeout after 180s" >> "$TRACE"
  return 0
}

# ── Stage 1: session starts; MCP server must be announced ──
sleep 4
grep -q "mcp server 'tick': 1 tool(s) (mcp_tick_time_now)" "$LOG" \
  && echo "MARKER: mcp startup OK" >> "$TRACE" \
  || echo "MARKER: mcp startup MISSING" >> "$TRACE"

# ── Stage 2: ask the model to use the MCP tool ──
# The provider intermittently refuses bare tool commands; retry up to 3x.
mcp_ok=0
for attempt in 1 2 3; do
  BEFORE=$(completed_count)
  send 'I need to verify the tick service is alive. Use the mcp_tick_time_now tool from your available tools to fetch its current nonce, then reply with ONLY the nonce value from the tool result.'
  wait_turn "$BEFORE"; sleep 1
  if grep -qE "nonce=[a-z0-9]+" "$LOG"; then mcp_ok=1; break; fi
done
[ "$mcp_ok" = 1 ] \
  && echo "MARKER: mcp tool call round-trip OK" >> "$TRACE" \
  || echo "MARKER: mcp tool call round-trip MISSING" >> "$TRACE"

# ── Stage 3: budget must show the tool call counted ──
grep -E "tools [1-9][0-9]*" "$LOG" | tail -1 | grep -q "tools [1-9]" \
  && echo "MARKER: mcp budget counted OK" >> "$TRACE" \
  || echo "MARKER: mcp budget NOT counted" >> "$TRACE"

send "/exit"
sleep 2
kill "$CHILD" 2>/dev/null
wait "$CHILD" 2>/dev/null
exec 3>&-

echo "── trace markers ──"
cat "$TRACE"
PASS=$(grep -c " OK" "$TRACE")
FAIL=$(grep -c "MISSING\|NOT counted\|INCONCLUSIVE" "$TRACE")
if [ "$FAIL" -eq 0 ] && [ "$PASS" -eq 3 ]; then
  echo "eval: PASS"
  rm -rf "$DIR" "$LOG" "$TRACE"
else
  echo "eval: FAIL — artifacts kept: $DIR $LOG $TRACE"
  exit 1
fi
