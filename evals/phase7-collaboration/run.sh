#!/usr/bin/env bash
# Phase 7 collaboration eval (LIVE — real provider, real cost).
#
# Stagecraft guarantees (the gaps unit tests cannot close):
#   * a completing qa worker whose dictated question forces PROPOSAL + BLOCKER
#     lines, so `proposal` and `blocker` events exist;
#   * a reviewer worker delegated BEFORE the change it must review exists, so
#     it must answer WAITING; the later /correct resumes it.
#
# Requires: /tmp/.syn_eval_key (mode 600) with the provider key.
# Artifacts: $DIR (stage), $DIR-session.log, $DIR-trace.log, $DIR-in.fifo.
# On PASS the stage dir is removed; on FAIL everything is kept for autopsy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${SYN_EVAL_DIR:-/tmp/syn-p7h}"
LOG="$DIR-session.log"
TRACE="$DIR-trace.log"
FIFO="$DIR-in.fifo"

if [ ! -f /tmp/.syn_eval_key ]; then
  echo "eval: missing /tmp/.syn_eval_key — create it (mode 600) with the provider key first"
  exit 1
fi

# ── Stage ─────────────────────────────────────────────────────────────────────
rm -rf "$DIR"
mkdir -p "$DIR/src" "$DIR/test" "$DIR/.project-agent"

cat > "$DIR/package.json" <<'EOF'
{
  "name": "syn-p7h-eval",
  "version": "1.0.0",
  "private": true,
  "scripts": { "test": "node --test" }
}
EOF

cat > "$DIR/API-NOTES.md" <<'EOF'
# API notes — courier webhook rate limits

The courier API allows at most 5 requests per second from one identity.
Exceeding it returns HTTP 429 and can suspend the integration for an hour.

We must decide how `notifyShipment` respects that limit. Choose exactly ONE:

  Option A — a shared token bucket backed by an external Redis limiter service
  Option B — per-process in-memory throttling with jittered retry (no services)
EOF

cat > "$DIR/SPEC.md" <<'EOF'
# Reporter contract under review

The batch reporter must send a progress report after each batch: every 3rd
line processed, it must call `sendReport(batch)` on the orchestrator handle.
This change is specified here and must be applied to `src/reporter.js`.
EOF

cat > "$DIR/src/notify.js" <<'EOF'
/**
 * Shipment notifications.
 * Rate limiting is specified in API-NOTES.md — to be decided.
 */
function notifyShipment(ids) {
  // TODO(rate-limit): respect the courier limit per API-NOTES.md.
  return { ok: true, throttled: 0, shipments: ids.length };
}
module.exports = { notifyShipment };
EOF

cat > "$DIR/src/reporter.js" <<'EOF'
/**
 * Batch reporter. Progress reporting contract lives in SPEC.md.
 * NOTE: sendReport is NOT wired up yet.
 */
function processBatch(lines, orchestrator) {
  let batch = [];
  for (const line of lines) {
    batch.push(line);
  }
  return batch.length;
}
module.exports = { processBatch };
EOF

cat > "$DIR/test/notify.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { notifyShipment } = require('../src/notify.js');

test('notifyShipment returns a confirmation', () => {
  const res = notifyShipment(['a', 'b']);
  assert.ok(res && typeof res.ok === 'boolean');
});
EOF

cat > "$DIR/test/rate-limit.test.js" <<'EOF'
const { test } = require('node:test');
const assert = require('node:assert');
const { notifyShipment } = require('../src/notify.js');

test('notifyShipment throttles bursts over the courier limit', () => {
  const res = notifyShipment(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.ok(res && typeof res.ok === 'boolean');
  assert.ok(typeof res.throttled === 'number' && res.throttled >= 0, 'must report a throttled count');
});
EOF

cat > "$DIR/.project-agent/config.toml" <<'EOF'
[model]
provider = "openai-compatible"
name = "deepseek-v4.1"
base_url = "https://vyceai.com/v1"
api_key_env = "SYN_EVAL_KEY"

[runtime]
autonomy = "autonomous"
max_total_tokens = 500000
max_tool_calls = 90
max_worker_spawns = 4
max_parallel_workers = 2
max_wall_time_seconds = 900
shell_timeout_seconds = 60
max_stream_attempts = 3
min_test_count = 1
stream_timeout_seconds = 90

[security]
confirm_destructive = true
block_secrets = true
EOF

# ── Drive ─────────────────────────────────────────────────────────────────────
export SYN_EVAL_KEY="$(cat /tmp/.syn_eval_key)"
# Headroom so the eval measures behavior, not budget arithmetic.
export SYNERGON_MAX_TOOL_CALLS=90
export SYNERGON_MAX_TOKENS=500000

rm -f "$FIFO"
mkfifo "$FIFO"
: > "$LOG"; : > "$TRACE"

( cd "$DIR" && exec node --experimental-strip-types "$ROOT/src/index.ts" chat < "$FIFO" > "$LOG" 2>&1 ) &
CHILD=$!
exec 3> "$FIFO"

wait_prompt() {
  for _ in $(seq 1 240); do
    last=$(grep -v '^[[:space:]]*$' "$LOG" 2>/dev/null | tail -n 1 || true)
    case "$last" in "> "*) return 0;; esac
    sleep 1
  done
  echo "eval: prompt timeout waiting for the agent" >&2
  echo "=== wait_prompt TIMEOUT ===" >> "$LOG"
  exit 1
}

send() {
  echo "send @$(date +%T): ${1:0:70}" >> "$TRACE"
  printf '%s\n' "$1" >&3
}

echo "driver start $(date +%T) child=$CHILD" >> "$TRACE"
wait_prompt; sleep 2
# 1) Reviewer first (change not yet applied -> must WAIT), then apply the fix.
send 'Work through SPEC.md. FIRST delegate a reviewer worker on this exact question: "Review src/reporter.js against the contract in SPEC.md. Read the file first. If the SPEC change (a sendReport call every 3rd line) is NOT yet implemented in src/reporter.js, your reply must be ONLY one line: WAITING: the reporter change is not applied yet — do not use any section headers. Otherwise reply with VERDICT, FINDING, EVIDENCE and CONFIDENCE lines." THEN apply the SPEC change to src/reporter.js yourself. Do not resolve the reviewer report in this turn.'
wait_prompt; sleep 2
# 2) QA worker with dictated PROPOSAL + BLOCKER lines (structured output guaranteed).
send 'Now delegate a qa worker on this exact question: "We must pick ONE rate-limiting approach for notifyShipment: (A) Redis-backed shared token bucket, or (B) per-process in-memory throttling with jittered retry. Read API-NOTES.md and src/notify.js and test/rate-limit.test.js. Your reply MUST contain, each on its own line: TESTED: what you inspected or ran; FINDING: the constraint from API-NOTES.md; EVIDENCE: file and line you based it on; PROPOSAL: adopt option A (Redis-backed shared token bucket) because the courier limit is per-identity and must be shared; BLOCKER: the courier sandbox credentials are not present in this repository or environment, so live rate behavior cannot be measured; RESULT: what you ran and its outcome; CONFIDENCE: medium." Do not implement rate limiting in this turn.'
wait_prompt; sleep 2
# 3) Correction: kills the Redis proposal (needs_rework) and resumes the waiting reviewer.
send '/correct Do NOT add Redis or any external service or dependency; notifyShipment must stay dependency-free with in-process throttling only (option B).'
wait_prompt; sleep 2
# 4) Resolve the credentials blocker (paraphrased — no runtime id), redo the
#    work red-first so the correction-invalidated tffb checklist re-satisfies.
send 'Continue: FIRST record a decision with statement "resolves the courier sandbox credentials blocker: credentials are permanently unavailable; rate limiting is validated by the unit simulation in test/rate-limit.test.js instead". THEN work test-first, in this exact order: (1) create test/repro.js that calls notifyShipment with 10 ids and asserts res.throttled > 0; (2) run node test/repro.js and note that it FAILS with throttled = 0 — that failure is the reproduction; (3) implement in-process throttling with jittered retry in src/notify.js per the correction (no Redis); (4) re-run node test/repro.js until it passes, then run npm test until all tests pass; (5) remove test/repro.js with rm. Follow these steps in order.'
wait_prompt; sleep 2
send '/collab'
send '/status'
send '/exit'

CHILD_RC=0
wait "$CHILD" || CHILD_RC=$?
echo "child exited status $CHILD_RC @$(date +%T)" >> "$TRACE"

# ── Audit ─────────────────────────────────────────────────────────────────────
AUDIT_RC=0
node --experimental-strip-types "$ROOT/evals/phase7-collaboration/audit.ts" "$DIR" || AUDIT_RC=$?

if [ "$AUDIT_RC" -eq 0 ]; then
  echo "eval: PASS"
  if [ "${SYN_EVAL_KEEP:-0}" != "1" ]; then
    rm -rf "$DIR" "$FIFO" "$LOG" "$TRACE"
    echo "eval: artifacts cleaned (SYN_EVAL_KEEP=1 to keep them)"
  fi
else
  echo "eval: FAIL — artifacts kept for autopsy: $DIR $LOG $TRACE"
fi
exit "$AUDIT_RC"
