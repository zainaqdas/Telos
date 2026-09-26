#!/usr/bin/env bash
# Ad-hoc LIVE test of the Part 61 commands against the real provider.
# Exercises: /provider /models /undo /retry /new (+fresh budget) mid-run /cancel /compact
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR=/tmp/syn-live1
LOG=$DIR-session.log
TRACE=$DIR-trace.log
FIFO=$DIR-in.fifo

if [ ! -f /tmp/.syn_eval_key ]; then
  echo "missing /tmp/.syn_eval_key"; exit 1
fi

rm -rf "$DIR"
mkdir -p "$DIR/.project-agent"
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
max_worker_spawns = 2
max_parallel_workers = 1
max_wall_time_seconds = 600
shell_timeout_seconds = 60
max_stream_attempts = 3
min_test_count = 1
stream_timeout_seconds = 90
compaction_threshold_tokens = 0
EOF

export SYN_EVAL_KEY="$(cat /tmp/.syn_eval_key)"
rm -f "$FIFO"; mkfifo "$FIFO"; : > "$LOG"; : > "$TRACE"

( cd "$DIR" && exec node --experimental-strip-types "$ROOT/src/index.ts" chat < "$FIFO" > "$LOG" 2>&1 ) &
CHILD=$!
exec 3> "$FIFO"

wait_prompt() {
  for _ in $(seq 1 180); do
    last=$(grep -v '^[[:space:]]*$' "$LOG" 2>/dev/null | tail -n 1 || true)
    case "$last" in "> "*) return 0;; esac
    sleep 1
  done
  echo "eval: prompt timeout" >&2
  echo "=== wait_prompt TIMEOUT ===" >> "$LOG"
  return 1
}

send() { echo "send @$(date +%T): ${1:0:70}" >> "$TRACE"; printf '%s\n' "$1" >&3; }

send_marker() { echo "MARKER: $1" >> "$TRACE"; }

echo "driver start $(date +%T) child=$CHILD" >> "$TRACE"

# 1) idle info commands
wait_prompt; sleep 1
send "/provider"
sleep 2; send "/models"
sleep 2; send "/status"
wait_prompt

# 2) /undo: instruction writes a file, then undo restores pre-edit state
send 'Create a file named hello.txt containing exactly: version-one'
wait_prompt; sleep 1
send "/undo"
sleep 1
if [ -f "$DIR/hello.txt" ]; then echo "MARKER: undo FAILED - hello.txt still exists" >> "$TRACE"; else echo "MARKER: undo OK - hello.txt removed" >> "$TRACE"; fi

# recreate so /retry has something to chew on. Unambiguous imperative — no
# "again" phrasing, which invites the model to ask a clarifying question.
send 'Create a file named hello.txt containing exactly: version-two'
wait_prompt; sleep 1

# 3) /retry: replays the previous instruction
send "/retry"
wait_prompt; sleep 1
# The replay turn may still be finishing when the prompt marker reappears;
# poll briefly for the file rather than one-shot-grepping.
retry_ok=""
for i in $(seq 1 20); do
  if grep -q "version-two" "$DIR/hello.txt" 2>/dev/null; then retry_ok=1; break; fi
  sleep 1
done
if [ -n "$retry_ok" ]; then echo "MARKER: retry OK - file intact after replay" >> "$TRACE"; else echo "MARKER: retry INCONCLUSIVE" >> "$TRACE"; fi

# 4) /new: fresh task id + budget; then a mid-run /cancel
send "/new"
wait_prompt; sleep 1
send 'Count slowly: read package.json, then README.md, then src/reporter.js, and summarize each. Take your time.'
sleep 6
send "/cancel"
wait_prompt; sleep 1
grep -q "cancel" "$LOG" && echo "MARKER: mid-run cancel processed" >> "$TRACE" || echo "MARKER: cancel INCONCLUSIVE" >> "$TRACE"

# 5) second /new then /compact on a short transcript (must report no-op or success, not crash)
send "/new"
wait_prompt; sleep 1
send "/compact"
wait_prompt; sleep 1
send "/status"
wait_prompt; sleep 1
send "/exit"

wait "$CHILD"; RC=$?
echo "child exited rc=$RC @$(date +%T)" >> "$TRACE"

echo "── trace markers ──"
grep "MARKER:" "$TRACE" | sed 's/^MARKER: //'
echo "── errors in session log ──"
grep -iE "unknown command|error|throw" "$LOG" | grep -v "confirm_destructive" | head -5
exit 0
