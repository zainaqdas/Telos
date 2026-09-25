# Synergon — Phase Reports

## Phase 5 — Manager Orchestration

**Implemented**

- `delegate` tool in the shared registry (no special channel): the Manager's model chooses role + question + context; the runtime enforces everything else (Part 90)
- Four roles as toolset-scoped, mission-framed specialists — explorer, researcher, reviewer, qa — with explicit output contracts (FINDING/EVIDENCE/RISK/OBJECTION/RECOMMENDATION/VERDICT/CONFIDENCE); roles, not personalities (Part 9)
- Workers run scoped `ManagerLoop` instances: filtered registry views (explorer/researcher/reviewer have zero write tools; qa adds `run_shell` only), no gate, no instruction recording, no per-worker memory injection or skill routing (their findings enter the shared stream via the orchestrator)
- Worker budgets enforced at spawn: `max_worker_spawns` and `max_parallel_workers` checked by the runtime before each delegation; refusals tell the Manager to integrate and proceed (Part 22)
- Bounded-parallel execution pool (`runParallel`) with lane count = min(configured parallel, queue)
- Reconciliation: worker findings → `finding` events, objections → `objection` events (first-class, Part 13); `delegation`/`worker_started`/`worker_completed` lifecycle events
- Manager remains the primary builder: no worker can mutate the workspace (verified by test: a QA worker attempting `edit_file` hits an unknown-tool wall and the file is unchanged) (Part 16)

**Tested** — report parser structure, role toolset policy, parallel delegation with two concurrent workers, budget refusal at the spawn cap, findings/objection reconciliation into reduced state, single-writer preservation under a misbehaving worker.

**Verified** — 64/64 tests, strict typecheck clean.

**Failed / learned** — the first scripted test provider re-yielded tool-call turns forever, hanging a worker loop (fixed by converging scripts to prose); a `require()` slipped into ESM test code. Both test-side. No architectural changes.

**Remaining** — staffing quality evaluation (Part 73) needs real-workload observation; worker→Manager clarification round-trips (a worker asking the Manager a question) deferred until Phase 7 collaboration; no worktrees (Part 16).

**Architecture changes** — `ManagerDeps.gate` became optional (worker loops run gateless by contract) and gained `workerPromptOverride` to replace the system prompt and suppress instruction events. The delegate tool participates in repetition guarding, budget accounting, and the transcript like any other tool.

## Phase 4 — Memory + Failure Learning

**Implemented**

- JSONL memory stores under `.project-agent/memory/` (facts, lessons, decisions, failures, rejected approaches, user rules) — no vector DB, no embeddings (Part 29)
- `MemoryStore`: append with natural-key dedup (repeats reinforce via hit counts), torn-line tolerant reads, trust-hierarchy-ordered retrieval (user_rule > fact > lesson > decision > failure > rejected), topic-gated scoring over statement/cause/correction/reason fields, hard result cap (Parts 30–32)
- Deterministic failure-learning pipeline: category → root-cause map (port in use, missing module, path, network, test failure, …) → failure record → **promotion to a verified lesson only on recurrence** (single occurrences stay failures) (Parts 27–28)
- Lesson shape: observation → cause → correction → verification — never a bare "command failed"
- Explicit rejected-approach memory with `revisit_if`; retrieval warns against silent resurrection (Part 31)
- User corrections captured as durable user rules and rejections (trust hierarchy top) (Parts 15, 32)
- Loop integration: capped memory injected into instructions by relevance; recurring failures emit `lesson_verified` events and a runtime notice; nothing model-stated is ever written as memory by the model itself
- `/memory` command listing rules, lessons, rejected approaches

**Tested** — dedup + cross-instance persistence, trust ordering and topic gating and caps, deterministic cause classification, promotion-on-recurrence (and non-promotion on first failure), rejection/rule retrieval, correction → rule+rejection capture through the loop, lesson promotion across two loop runs with `lesson_verified` event, memory injection into the transcript.

**Verified** — 58/58 tests, strict typecheck clean.

**Failed / learned** — the retrieval haystack initially omitted `reason`/`revisitIf`/`verification` fields, making rejection reasons unsearchable (test caught it). Dedup hit-marking required a file rewrite: implemented as append-to-temp + rename to keep writes atomic.

**Remaining** — retrieval-weight tuning from real workloads, lesson expiry/decay, context compaction integration (Part 68, later phase).

**Architecture changes** — none: memory is a side-store consumed at instruction boundaries; the event log remains the sole authority for task state. Lessons are promoted only from recurrence of *observed* failures, so hallucinated lessons cannot enter memory through this path.

## Phase 3 — Skill Engine

**Implemented**

- Skill schema (validated, normalized): metadata, triggers, framework/file/command evidence, checklists, constraints with severity (`advisory | required | blocking`) — validation rejects constraints referencing unknown checklist items (Parts 34, 37–38)
- Loader with precedence: builtin → global (`~/.synergon/skills/*.toml`) → project (`.project-agent/skills/*.toml`); malformed skills degrade to warnings, never block the session (Part 71)
- Two built-in skills: `test-first-bugfix` (reproduce → fix → verify, with a blocking no-blind-edit constraint) and `db-migration-safety`
- Deterministic-first routing: explicit name > trigger > file-pattern > framework > command evidence, threshold-gated, capped at 3 activations; ambiguity-classifier hook present and unused (Part 35)
- Activation emits `skill_activated` + checklist `requirement_added` events — the Completion Gate enforces skill checklists exactly like user requirements; activation is idempotent per task (Part 37)
- Constraint enforcement in the Manager loop, before tool execution: blocking constraints REFUSE the call until the guarding requirement is satisfied; the model receives the refusal and must change course (Part 38)
- Deterministic requirement discharge: a red test run satisfies `*-reproduce`, a workspace edit satisfies `*-fix`, a green run satisfies `*-verify` — always from executed tool evidence, never model prose
- Gate skill audit: pending skill requirements are listed in the report and prevent COMPLETE (Part 39)
- `/skills` command; skill routing feeds the transcript via runtime notices

**Tested** — schema validation (including constraint-without-checklist-item), three-tier precedence override, routing tiers (explicit/trigger+command hits, unrelated miss), activation idempotency, blocking constraint refusing a premature edit through the real Manager loop, constraint discharge by runtime evidence, gate audit blocking premature completion.

**Verified** — full suite green (50 tests), strict typecheck clean.

**Failed / learned** — the TOML subset lacked array-of-tables (`[[skill]]`) support, so every skill file silently failed to parse (caught by the precedence test); skill files now parse. Deeper find: spawned shells inherited `NODE_TEST_CONTEXT` when Synergon itself ran under `node --test`, making an inner `node --test` exit 0 without executing assertions — a false-green that would have broken verification everywhere. The shell tool now strips test-runner env markers from children. Also: verification classification now examines the command string itself (a bare `node --test` never prints the word "test").

**Remaining** — ambiguity classifier activation (needs a real workload), skill-defined verification commands to replace shell heuristics, evaluation harness for skill recall/precision (Parts 72–74).

**Architecture changes** — skill checklists are requirements; skill constraints are pre-tool runtime checks; both flow through existing event/gate machinery with no new authorities. `TomlValue` extended for array-of-tables.

## Phase 0 — Foundation + Runtime Safety

**Implemented**

- TypeScript + Node CLI (`synergon`), zero runtime dependencies; native type-stripping instead of a build step
- Layered configuration: defaults → `.project-agent/config.toml` (minimal TOML parser) → `SYNERGON_*` env vars
- Event-sourced core: append-only JSONL `EventLog` → pure reducer → derived `TeamState` (Part 14)
- Provider abstraction with explicit capabilities; one OpenAI-compatible streaming provider path (SSE, tool-call assembly, usage, abort) (Parts 52–53)
- Hard budgets: tokens, tool calls, worker spawns, parallel workers, wall clock — checked by the runtime before every spend (Parts 22–23)
- Real cancellation: abort propagation + process-tree termination (POSIX group kill / Windows taskkill /T) (Parts 46–47)
- Circuit breakers: sliding-window conditions for failure storms, spawn storms, context explosion (Part 25)
- CLI entry: `chat` / `init` / `status` / `help` / `version`, clean exit codes

**Tested** — budget projection math, TOML parsing, config layering, event log append + torn-line recovery, reducer projections (requirements, correction invalidation, budget_exceeded), provider SSE parsing against a local HTTP server, and the mandatory no-orphan cancellation acceptance test (child + grandchild processes both terminated).

**Verified** — `synergon init/status/version/help` run end-to-end; env overrides reach the runtime; typecheck clean.

**Failed / learned** — `erasableSyntaxOnly` forbids parameter properties (rewrote several classes); a naive `current = current[k]` aliasing bug in the TOML section parser produced nested-table corruption; budget checks must use one injected clock, not a mix of injected and real time.

**Remaining** — worker subsystem (deliberately deferred), UI polish.

**Architecture changes** — none forced; reducer remained pure, log remained authoritative.

## Phase 1 — Single-Agent Runtime

**Implemented**

- Unified Tool Registry: name/description/schema/permission/mutability/risk declared per tool; minimal deterministic JSON-schema validation (Part 43)
- Filesystem tools (`read_file`, `write_file`, `edit_file`, `list_directory`, `find_files`, `search_text`) with workspace confinement (symlink-aware), redaction, truncation; `edit_file` is targeted and refuses ambiguous matches (Parts 44–45)
- Shell tool: destructive-command refusal, timeouts, output caps, process-group spawn + tree kill on cancellation; Git tools (`git_status`, `git_diff`, `git_log`) (Part 46)
- Repetition Guard: normalize → compare attempts → fingerprint relevant state → classify NEW / SAFE_RETRY / CHANGED_RETRY / REPEATED_FAILURE / KNOWN_BAD_PATTERN; the runtime refuses, the model cannot argue (Parts 25–27)
- Persistent Manager loop: streaming tool-call turns, transcript assembly, single retry with backoff on retryable provider errors, per-spend budget checks (Part 86)
- Minimal Completion Gate as the single completion authority: runtime-derived requirements from test/build/lint results, invalidation on failure, user-correction propagation, plus two deterministic anti-honesty rules — unverified workspace writes and change-request-without-work are never COMPLETE (Parts 17–21)
- Interactive session: raw-mode terminal UI, streaming output, tool activity lines, budget bar, slash commands (`/help`, `/status`, `/diff`, `/cancel`, `/model`, `/exit`), two-stage Ctrl+C (cancel task → exit)

**Tested** — tool behavior including path escapes, ambiguous edits, parent-dir creation, search results; redaction of the BYOK key and credential-shaped strings; repetition-guard verdict transitions; loop round-trips against a scripted provider (tool result fed back to the model, gate COMPLETE via test evidence, gate INCOMPLETE on failing tests, hard tool-call budget stop with `budget_exceeded` event, usage accounting); end-to-end CLI run against a local mock provider.

**Verified** — single-agent runtime is useful without any workers (Phase 1 acceptance list: inspect → find → edit → test → fix → verify → diff → gate verdict).

**Failed / learned** — the gate initially granted COMPLETE with zero requirements; a read-only task can legitimately complete, but the same rule would bless prose-only answers to "fix the bug" — fixed with deterministic mutation/verification rules instead of prompt exhortation. A test also overwrote `package.json` mid-run (removed the offending line; the guard belongs in the test itself, not in hope). Tools must return failed `ToolResult`s, not throw, so the model can recover.

**Remaining** — skills, memory, workers, web/browser, multimodal.

**Architecture changes** — Completion Gate gained two runtime-derived rules (unverified writes, requested-but-absent work). This is deliberate: "never trust done" is enforceable in code and belongs there, not in the prompt.

## Phase 2 — Context Engine

**Implemented**

- `profileRepository`: capped incremental walk (depth ≤ 3, ≤ 4000 entries, ignore-aware)
- Language detection with per-language extension merging; framework detection from dependencies; package manager detection with evidence (lockfiles) and correct command runner (pnpm/yarn/bun/npm; cargo, go)
- Test/build/lint command discovery from `package.json` scripts or ecosystem defaults
- Git state including unborn-HEAD repositories (`rev-parse --is-inside-work-tree`)
- Instruction discovery: AGENTS.md / CLAUDE.md / PROJECT.md / README.md, top-priority first (Part 41)
- Key directories and entry points; all compiled into a factual profile under a hard character budget — no file contents dumped (Parts 40, 42)
- Session integration: profile injected into the system prompt each launch; `/profile` slash command

**Tested** — synthetic unfamiliar-repo fixture: stack, package manager, runner-correct test command, instruction discovery, budget compliance (large file never inlined), non-node ecosystems (Cargo, go.mod).

**Verified** — live CLI session against a fresh demo repo; profile output matches expectations; unfamiliar repo acceptance list (stack, package manager, tests, build, instructions, key files) satisfied without dumping the repository into context.

**Failed / learned** — `detectPackageManager` returned evidence-suffixed names (`pnpm (pnpm-lock.yaml)`) and a strict-equality runner check silently fell back to npm — discovered only because the test asserted the final command string, not the internal field. Same-language extensions were double-counted before merging.

**Remaining** — skills (Phase 3) and beyond, per roadmap stop point.

**Architecture changes** — none; the profile is a pure function of the workspace plus a budget, consumed by the Manager as context, which keeps the Context Engine swappable and testable.

## Evaluation Stop

Per the master build instruction, implementation stops here for architectural reassessment against real tasks before Phase 3 (Skill Engine). See `docs/ARCHITECTURE.md` for the evaluation summary.
