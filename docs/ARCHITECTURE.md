# Synergon Architecture — Evaluation After Phase 2

Per the master build instruction: Phases 0–2 are implemented, verified, and frozen. This document evaluates the architecture against real tasks before Phase 3 (Skill Engine) begins.

## Current Shape

```
CLI (src/index.ts)
  ↓
Session (src/session)          terminal-native UI, slash commands, Ctrl+C
  ↓
ManagerLoop (src/manager)      persistent builder: model turns + tool execution
  ├─→ ToolRegistry (src/tools)  declared permissions/risk, schema validation
  ├─→ Provider (src/providers)  one OpenAI-compatible streaming path
  ├─→ Guards (src/runtime)      BudgetEnforcer · RepetitionGuard · Cancellation
  ├─→ CompletionGate (src/gate) single completion authority
  └─→ Context Engine (src/context) repo profile under a character budget
  ↓
EventLog (JSONL) → reducer → TeamState   (authoritative, append-only)
```

## What the Phases Proved

1. **Runtime over prompt works.** Every guarantee that matters — budgets, cancellation, path confinement, secret redaction, repetition blocking, requirement invalidation, completion decisions — is enforced in code. The model is never trusted with an invariant.
2. **The Completion Gate changes model behavior structurally.** Because prose cannot satisfy the gate, the loop's only exit to COMPLETE is actual verified work. The two deterministic rules (unverified writes; change-request-without-work) close the two cheapest dishonest paths.
3. **Event sourcing paid off immediately.** The gate, `/status`, tests, and future workers all consume the same reduced state. No second source of truth appeared anywhere.
4. **Caching existed and nobody noticed.** The gate re-reduces the full event stream on evaluation. At current scale (a few hundred events) this is sub-millisecond. It stays — simplicity first — until measurements say otherwise (Part 96).
5. **Zero runtime dependencies held.** TOML, schema validation, SSE, diff, glob, and schema-safe checks are all small local implementations. Iteration speed stayed high; the provider test runs against a local HTTP server with no network.

## Measured Observations

- Tests: 36 passing, ~2s wall, including a real process-tree orphan test and a real CLI end-to-end run.
- Typecheck: strict, `noUncheckedIndexedAccess`, erasable-syntax-only, clean.
- Profile generation on the demo repo: well under the 2400-char budget.

## Seven Defining Properties — Status After Phase 2

| Property | Status |
|---|---|
| 1. Elastic staffing | Deferred by design (Phases 5–6); budget model already reserves worker limits |
| 2. Operational skills | Phase 3; registry + gate integration points already exist |
| 3. Failure learning | Hook exists (`lesson_candidate` events); promotion + retrieval lands in Phase 4 |
| 4. Repetition protection | **Working** — fingerprint-based guard refuses blind retries |
| 5. One Completion Gate | **Working** — single authority, deterministic rules |
| 6. User-correction propagation | **Working** — corrections recorded, pending requirements invalidated |
| 7. Hard BYOK budgets | **Working** — checked before every spend; keys redacted, never persisted |

## Known Risks / Debts (Deliberate)

- **Correction → worker notification** is a reducer fact today; actual worker notification needs workers (Phase 6). The event and state plumbing is ready.
- **`summary` truncation** in gate reports is cosmetic; requirement IDs are the stable interface.
- **Shell verification heuristics** (test/build/lint detection from output) are intentionally conservative; skill-defined verification commands will replace heuristics in Phase 3.
- **No `cwd` in `safePath` for shell** — shell cwd is confined but not symlink-resolved on every call; acceptable for Phase 1 semantics, revisit with worktrees (never in v1).

## Phase 3 Readiness

The Skill Engine can plug in without touching the Manager loop:

- Skills declare **requirements** → the Gate already consumes requirement events.
- Skills declare **constraints** → the registry already exposes permission/risk for pre-tool checks.
- Deterministic routing (triggers, file patterns, commands, framework evidence) consumes the Context Engine profile.
- The ambiguity classifier (small LLM call) has a provider abstraction waiting.

No Phase 3 work was started, per the stop instruction.
