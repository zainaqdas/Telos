# Spec Compliance Matrix

Audit date: 2026-09-26 · tree `2a3698c` · 151 unit tests · 6 scenario evals · 4 live harnesses

Legend: ✅ implemented + tested · 🌐 live-verified against a real provider · ⚠️ partial (gap stated) · 📄 doctrinal / informational (no code surface)

| Part | Title | Status | Evidence / Gap |
|---|---|---|---|
| 1–5 | Vision, goals, non-goals, language, stack | ✅ | TypeScript/Node, zero runtime deps (package.json has only devDeps); docs/ARCHITECTURE.md |
| 6–7 | Responsibilities, persistent Manager | ✅ | src/manager/loop.ts (persistent across turns, busy/cancel semantics) |
| 8 | Worker roles (explorer/researcher/reviewer/qa) | ✅ | src/workers/roles.ts; 10 worker tests; live-verified in phase7 harness |
| 9 | Worker lifecycle (WAITING, continue) | ✅ | WAITING regex, cycle cap, continue_worker; live: reviewer WAITING → resumed |
| 10 | Task-local worker memory | ✅ | worker sessions task-scoped, findings enter shared stream via orchestrator |
| 11 | No agent theater | ✅ | stream printer prints deltas only; gate refuses prose completion |
| 12 | Objections first-class | ✅ | objection events, debate (upheld/dismissed/needs_decision), objection_resolved; live |
| 13 | Event-sourced team state | ✅ | src/events/{log,state}.ts, pure reducer; state-store tests assert fold ≡ replay |
| 14 | Corrections high-priority | ✅ | user_correction: invalidates reqs/proposals/decisions, reopens terminal tasks, resumes workers; live |
| 15 | Single-writer rule | ✅ | refcounted write-tool strip while workers run (orchestrator) |
| 16–20 | Completion Gate: requirements, evidence, rule | ✅ | src/gate/gate.ts; unverified-write + change-request + zero-test green rules; live 13/13 |
| 21–23 | Budgets (tokens/tools/wall/workers), runtime-enforced | ✅ | src/runtime/usage.ts; mid-turn overshoot re-check; scenario P78 |
| 24 | Cost accounting | ✅ | provider-reported costUsd or declared [model.pricing] estimate, else null; /status + budget bar |
| 25 | Circuit breakers | ✅ | provider stream retries with backoff + timeout watchdog |
| 26–27 | Repetition Guard + state fingerprint | ✅ | src/runtime/repetition.ts; block-after-2, changed-state re-allow; scenario P76 |
| 28–32 | Memory + failure learning, trust hierarchy | ✅ | src/memory/{store,pipeline}.ts; JSONL stores, dedupe, trust-ordered capped retrieval |
| 33–38 | Skill engine: routing, lifecycle, checklists, constraints, audit | ✅ | src/skills/*; deterministic tiers, gate-enforced checklists, blocking constraints |
| 39–41 | Context engine: repo profile, instructions | ✅ | src/context/profile.ts; AGENTS/CLAUDE/PROJECT/README excerpts, char budget |
| 42 | Repository search | ✅ | search_text/find_files tools |
| 43–44 | Unified registry, toolset | ✅ | src/tools/registry.ts; fs/shell/git/web/browser tools, schema validation |
| 45 | Safe editing | ✅ | edit_file exact-match, replace count semantics, size guards |
| 46 | Shell execution | ✅ | timeout, output caps, redaction, detached process-tree kill |
| 47 | Real process cancellation | ✅ | process-tree kill; orphan tests; per-run cancellation semantics (post-latch fix) |
| 48 | Autonomy modes | ✅ | config.runtime.autonomy, destructive refusal independent of mode |
| 49–50 | Web + browser | ✅ | web_search (DuckDuckGo Lite, keyless), read_url; zero-dep CDP browser tools; graceful no-Chrome degrade; live |
| 51 | Image input | ✅ | /image, vision-gated by provider capabilities; live IMAGE_RECEIVED round-trip |
| 52–54 | Provider abstraction, BYOK | ✅ 🌐 | openai-compatible live; **⚠️ anthropic is mock-verified only (no live key)**; BYOK env-only keys |
| 55 | MCP via registry | ✅ 🌐 | JSON-RPC 2.0 stdio, zero deps; E2E + live harness (real subprocess); no MCP logic in Manager |
| 56–59 | Review/QA/decisions/blockers | ✅ | decision ledger, blocker ids, waiver TTL; live collaboration harness |
| 60 | Terminal UX | ✅ | raw-mode line editor, budget bar, streaming printer |
| 61 | Core slash commands | ⚠️ | 16 of 14+ implemented; **missing: /model set-form (view-only, no argument handling)** — /help /models /provider /skills /memory /status /diff /undo /retry /compact /new /clear /exit all present |
| 62 | User control (interrupt/cancel/correct/stop workers…) | ⚠️ | interrupt/cancel/correct/retry/inspect(/status /diff /collab)/waive all present; **gap: no dedicated stop-workers command — Ctrl+C cancels the whole run including workers, but individual workers cannot be stopped selectively** |
| 63–65 | Source of truth, runtime over prompt | ✅ | deterministic enforcement throughout (budgets, gate, guard, constraints) |
| 66 | Structured observability | ⚠️ | event log carries task/event ids, tool names, timings (t), usage, errors; **gaps: no tool-call-id field on events, no per-turn log line surfacing provider/model/cost/budget in one structured record** (cost+model are visible in /status instead) |
| 67 | Session history | ✅ | JSONL event logs per task under .project-agent/events/, replayable by the reducer |
| 68 | Context compaction | ✅ | /compact + automatic threshold; reducer-built digest preserves corrections/blockers/objections |
| 69–70 | Project file layout, configuration | ✅ | .project-agent/{config.toml,events,memory,skills}; TOML subset parser |
| 71 | Global + project skills, precedence | ✅ | builtin → ~/.synergon/skills → project; project wins; documented |
| 72–79 | Evaluation philosophy + mandatory scenarios | ✅ 🌐 | evals/scenarios (P74 correction, P76 repetition, P77 gate, P78 budget, P79 cancellation) + 4 live harnesses (collaboration/commands/web/MCP) |
| 80–83 | Acceptance tasks (tiny/research/complex/skill) | ⚠️ | covered by unit + scenario equivalents (skill-acceptance = gate BLOCKED test exists); **no dedicated live eval dir replicating Parts 80–83 verbatim prompts** |
| 84–96 | Phase roadmap 0–11 | ✅ 🌐 | all phases implemented; docs/PHASES.md reports; measure-first doctrine honored (bench before opt) |
| 97–100 | Engineering rules (no overbuild, deterministic enforcement…) | ✅ | zero runtime deps held; optimization only after measurement; enforcement in code not prompts |
| 101 | True MVP definition | ✅ | every MVP element present and individually tested |
| 102–103 | Final instruction, start here | 📄 | process guidance, no code surface |

## Honest gap list (small, but real)

1. **Anthropic native provider is mock-verified only** — needs a real `ANTHROPIC_API_KEY` run to upgrade to 🌐.
2. **`/model` is view-only** — Part 61 lists it as a core command; switching models mid-session isn't implemented.
3. **No selective stop-workers** — Part 62's user-control list is otherwise complete; stopping an individual worker means cancelling the whole run.
4. **Observability thin spots** (Part 66) — no tool-call-id on events; provider/model/cost/budget surface in /status rather than one structured per-turn record.
5. **Acceptance tasks 80–83 not replicated verbatim live** — their *behaviors* are all covered (worker routing, research evidence, gate BLOCKED on unverified skill checklist), but not as dedicated verbatim-prompt live evals.

Nothing on this list is architectural; items 2–4 are small feature completions, item 1 needs a key, item 5 needs harness time.
