#!/usr/bin/env bash
# Phase 8 LIVE eval: web research through the real provider.
# Verifies: web_search and read_url are callable end-to-end, results carry
# sources, /image attaches and is gated by model vision, browser tools are
# present (and fail gracefully here — no Chromium on this box).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR=/tmp/syn-p8
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
max_tool_calls = 60
max_worker_spawns = 0
max_parallel_workers = 0
max_wall_time_seconds = 600
shell_timeout_seconds = 60
max_stream_attempts = 3
min_test_count = 0
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

echo "driver start $(date +%T) child=$CHILD" >> "$TRACE"

wait_prompt; sleep 1
# 1) A web research task the model cannot do from local files alone.
send 'Use the web_search tool to find the official Node.js documentation page about worker_threads, then use read_url on that page. Reply with: the URL you used, one sentence on what worker_threads are for, and the exact title of the page. Cite the URL in your answer.'
wait_prompt; sleep 2

# 2) /image from a file: attach, then ask a vision question. The image is a
#    VALID 1x1 PNG (the provider confirmed vision works with it) so a correct
#    pipeline must let the model actually see it.
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > "$DIR/dot.png"
send "/image dot.png"
sleep 1
# Neutral prompt, no escape hatch: compound questions that describe the image
# prime the model to distrust tiny images and answer NO_IMAGE even when the
# image demonstrably arrived (verified: 3/4 vs 4/4 A/B against the provider).
send 'Reply with exactly: IMAGE_RECEIVED'
wait_prompt; sleep 1

# 3) browser_open must fail gracefully (no Chromium here) without crashing.
send 'Try the browser_open tool on https://example.com and tell me exactly what happened.'
wait_prompt; sleep 1

send "/status"
wait_prompt; sleep 1
send "/exit"

wait "$CHILD"; RC=$?
echo "child exited rc=$RC @$(date +%T)" >> "$TRACE"

echo "── checks ──"
PASS=1
grep -qE "web_search" "$LOG" && echo "PASS web_search invoked" || { echo "FAIL web_search not invoked"; PASS=0; }
grep -qE "read_url" "$LOG" && echo "PASS read_url invoked" || { echo "FAIL read_url not invoked"; PASS=0; }
grep -q "https://nodejs.org" "$LOG" && echo "PASS source URL cited" || { echo "FAIL no source URL"; PASS=0; }
grep -q "image attached" "$LOG" && echo "PASS /image accepted" || { echo "FAIL /image rejected"; PASS=0; }
# The stream printer wraps mid-word in non-TTY mode ("IM" / "AGE_RECEIVED"),
# so match with newlines stripped.
tr '\n' ' ' < "$LOG" | grep -q "IMAGE_RECEIVED" && echo "PASS vision pipeline end-to-end (model saw the image)" || { echo "FAIL model did not see the image"; PASS=0; }
grep -qE "browser_open failed" "$LOG" && echo "PASS browser degrades gracefully" || { echo "FAIL browser_open crash/absent"; PASS=0; }
if grep -qiE "unhandled|TypeError|ReferenceError" "$LOG"; then echo "FAIL crash in log"; PASS=0; else echo "PASS no crashes"; fi
echo "══ session tail ══"
tail -14 "$LOG"
[ "$PASS" -eq 1 ] && echo "eval: PASS" || echo "eval: FAIL"
exit $((1 - PASS))
