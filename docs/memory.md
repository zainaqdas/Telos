# Synergon Memory — Stores, Trust, and Lesson Promotion

Memory is **plain JSONL on disk** under `.project-agent/memory/`. No vector database, no embeddings, no daemon. The model never writes memory directly — records enter through runtime pipelines (user corrections, executed tool results) so that hallucination cannot become durable knowledge.

## The stores

| File | Kind | What lands there |
|---|---|---|
| `user-rules.jsonl` | `user_rule` | Durable directives captured from user corrections ("Do not use Tailwind.") |
| `facts.jsonl` | `fact` | Verified observations about the repository |
| `lessons.jsonl` | `lesson` | Verified lessons promoted from recurring failures |
| `decisions.jsonl` | `decision` | Significant engineering decisions with reasons |
| `failures.jsonl` | `failure` | Every meaningful tool failure, with cause + correction |
| `rejected.jsonl` | `rejected_approach` | Approaches the user or evidence has ruled out |

Inspect them with `/memory` in a session.

## Record shape

```json
{
  "type": "lesson",
  "key": "run_shell:npm run dev",
  "statement": "Before running `npm run dev`, terminate the process bound to the port…",
  "cause": "The port was already occupied…",
  "correction": "Find and reuse or terminate the existing process…",
  "verification": "Observed 2 times: the same port_in_use failure recurred…",
  "source": "failure_pipeline",
  "verified": true,
  "t": 1790360406484,
  "hits": 1
}
```

- `key` — natural dedup key per store (`tool:target` for failures/lessons, the approach name for rejections)
- `hits` — reinforcement count; incremented when the same key is seen again
- `verified` — only `true` for records derived from executed evidence; failures start `false` and lessons are born verified (they summarize observed recurrence, not model claims)

## Trust hierarchy

Retrieval ranks by trust first (Part 32):

```
user_rule  (0)  ← top; overrides everything below
fact       (1)
lesson     (2)
decision   (3)
failure    (4)
rejected_approach (5)
```

Within a trust level, scoring prefers more topic-word overlap, then more reinforcement, then recency. Results are **hard-capped** (default 6) — the archive is never dumped into the model's context.

## How lessons form

```
tool call fails
   ↓
classify (deterministic: port_in_use, module_missing, path_missing,
          network, test_failure, compile_error, …)
   ↓
root cause + correction recorded as a FAILURE (verified: false)
   ↓
same failure recurs (same tool:target key)
   ↓
promote → VERIFIED LESSON (hits ≥ 2)
   ↓
next instruction on that topic → lesson injected into context
```

A single occurrence never becomes a lesson. Lessons state what was observed, why it happened, what to do instead, and how the lesson was verified. Live-validated: an EADDRINUSE failure in session A + session B produced a lesson that session C received before its first tool call — and the model checked the port instead of blind-retrying.

## Rejected approaches

A correction like "Do not use Tailwind. Use plain CSS." writes both a user rule and a rejected approach with `reason` and optional `revisit_if`. Two runtime enforcements attach:

1. **Injection** — future instructions about that topic see `REJECTED: <approach> … Do not resurrect without new justification.`
2. **Stale-rejection scan** — after every `edit_file`/`write_file`, the written file is scanned for rejected-approach keys. A hit reports `RUNTIME SCAN: rejected approach(s) … detected` to the model and records a failed `rejection-clean` **requirement** that the Completion Gate enforces. A later clean scan of the same file resolves it. Verified live: a model that re-added Tailwind-style classes despite injected memory was caught by the scan and the gate.

## False-green guard

An exit-0 test run that reports **fewer than `runtime.min_test_count` tests** (default 1) is not verification: `tests-pass` is invalidated instead of satisfied, so the gate cannot be satisfied by an empty suite or a wrong glob. Set `min_test_count = 0` in `.project-agent/config.toml` to disable for repos with intentionally empty suites.

## What memory is not

- Not a second event log — `.project-agent/events/` remains the sole authority for task state
- Not model-writable — no code path lets the model add records directly
- Not global by default — stores live per-project; `~/.synergon/` is reserved for future global skills/config
