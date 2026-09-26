# Phase 7 live-eval harness (collaboration)

Repeats the Phase 7 live evaluation on demand against a real provider.
Live runs cost tokens and need an API key — this is not part of `npm test`.

## What it guarantees

Unit tests cannot force a real model to emit `PROPOSAL:` lines or to answer
`WAITING:`. The staged project's task material does:

- A **qa worker** is delegated with a question that dictates the exact report
  lines (including `PROPOSAL:` and `BLOCKER:`), so reconciliation produces
  first-class `proposal` / `blocker` events.
- A **reviewer worker** is delegated *before* the change it must review exists,
  with instructions to answer with a bare `WAITING:` line, so `worker_waiting`
  occurs; the subsequent `/correct` resumes it
  (`worker_started(resumed, reason: user_correction)`).
- The correction forbids the proposal's approach (Redis), which must flip the
  proposal to `needs_rework` in derived state.
- A blocker (credentials that do not exist) must be cleared by a recorded
  decision before the gate can rule COMPLETE.

## Run

```bash
# 1. Put the provider key in place (mode 600); the harness shreds nothing —
#    it reads the key and exports it only into the session process.
install -m 600 /dev/null /tmp/.syn_eval_key
printf '%s' 'sk-…' > /tmp/.syn_eval_key

# 2. Run (stages /tmp/syn-p7h, drives the session, audits the event log).
bash evals/phase7-collaboration/run.sh
```

- On **PASS** the stage dir, log, trace, and FIFO are removed
  (`SYN_EVAL_KEEP=1` to keep them for inspection).
- On **FAIL** everything is kept for autopsy and the exit code is non-zero.

## What the auditor asserts (`audit.ts`)

Assertions run against the repo's own pure reducer (`reduce`) and gate —
a PASS means the live event log derives into a state satisfying every
collaboration invariant, not that strings appeared in a transcript:

1. `proposal` exists; **active before the correction**, `needs_rework`/`invalidated` after it.
2. `worker_waiting` occurred and the correction resumed that worker.
3. Every prior objection was debated exactly once (`objection_debated`).
4. The task reached `task_completed` (gate COMPLETE) with no open blockers
   and no undecided objections at completion.

### Auditor self-test (no provider, no cost)

```bash
node --experimental-strip-types evals/phase7-collaboration/audit.ts --self-test /tmp/syn-audit
```

Audits a synthetic log (all checks must PASS), then a mutated log with the
proposal, `worker_waiting`, and `task_completed` events removed (checks must
FAIL). An auditor that cannot detect a broken log is not an auditor.

## Configuration

Model/provider and budgets come from the staged `.project-agent/config.toml`;
`TELOS_MAX_TOOL_CALLS` / `TELOS_MAX_TOKENS` env overrides give headroom
so the eval measures behavior, not budget arithmetic.
