# Synergon — Phase Reports

## Phase 8 — Extensions & Escape Hatches (+ live-eval harness)

**Implemented**

- **User-declared external tools (Part 94)** — `[[tools.external]]` in `.project-agent/config.toml` exposes a trusted CLI as a first-class tool. There is no special category: the declaration is compiled into the standard `ToolDefinition` shape (schema, permission, risk), so registry validation, budgets, the repetition guard, transcripts, and redaction apply unchanged. Deterministic argument contract: the runtime composes `command --key 'value'`, every value shell-quoted as a single literal argument — the model cannot inject shell syntax, only pass strings as strings. Validation is strict and resilient: names must match `^[a-z][a-z0-9_]{1,39}$` and never shadow builtins/session tools (registered last, so collisions are skips, not overwrites); param keys unique, types restricted to `string|number|boolean`; base command must be a single invocation (no `;`, `&&`, `||`, `|`, `&`, backticks, `$()`); execution runs under the same `/bin/sh` discipline as `run_shell` (process-group spawn, timeout tree-kill, output caps, secret redaction). Parse errors and skips surface as session notices; a bad declaration never breaks the session.
- **User-only blocker waivers (Part 95)** — the escape hatch Phase 7 promised: `/waive <blocker-id> [reason]` records a `blocker_waived` event. Waived blockers stop blocking the gate but stay visible (gate COMPLETE summary appends `N blocker(s) waived by user: b-1`; `/collab` shows `[waived]`). The model has **no** waiver tool — a waiver is a human decision, and the slash command is the only writer of the event.
- **Live-eval harness** — `evals/phase7-collaboration/` turns the Phase 7 live eval into a committed, repeatable artifact: `run.sh` stages a throwaway project whose task material *guarantees* the two previously unit-only behaviors (a dictated-PROPOSAL/BLOCKER worker; a reviewer delegated before its target change exists, forcing `WAITING`), drives a real provider session, then `audit.ts` asserts the invariant chain — proposal active → correction forces `needs_rework`; `worker_waiting` → `worker_started(resumed, reason:user_correction)`; objections debated exactly once; gate COMPLETE with no open blockers or undecided objections — **via the repo's own reducer**, not transcript grepping. `audit.ts --self-test <dir>` audits a synthetic log and then a mutated one, proving the auditor detects missing proposals/waiting/completion (an auditor that cannot fail is not an auditor).
- **TOML array-of-tables fix** — the Phase 8 work exposed a latent parser bug: `[[a.b.c]]` resolved its path from the *previous current table* instead of the root, silently nesting later entries inside earlier ones (`[[skill.checklist]]` entries landed inside a prior `[[skill]]` entry, invisible to `validateSkill`). Fixed to root-relative resolution with last-array-entry semantics; regression test locks sibling-in-array behavior.

**Tested** — 18 new tests in `test/extensions.test.ts`: quoting of injection payloads; manifest parsing (valid declaration, name/reserved/duplicate rejection, chaining/piping/interpolation rejection, param-type rejection); config load and missing-config; compiled-tool execution with named flags and output capture; injection attempt stays a literal argument; schema rejection of unknown/missing args; timeout tree-kill; collision-safe registration; blocker_waived reduction; waived blockers COMPLETE-with-visibility while open blockers stay BLOCKED; double-waive idempotence; and the TOML sibling-entries regression.

**Verified** — `npx tsc --noEmit` clean (evals included); full suite 106/106 passing (88 pre-existing + 18 new). The live Phase 7 eval ran against `deepseek-v4.1` (runs recorded in the Phase 7 report); the harness now exists to repeat it on demand — `bash evals/phase7-collaboration/run.sh` with a key at `/tmp/.syn_eval_key` (mode 600), artifacts cleaned on PASS, kept on FAIL.

**Failed / learned** — the first execute test used `node -e --script '…'` and failed with `node: -e requires an argument`: the named-flag contract appends `--script <value>` as separate arguments, which is correct for getopt-style CLIs but wrong for `node -e`'s positional consumption — the test was rewritten against the actual contract (`printf %s=%s --text 'hello world'`). The chaining gap (`;`/`|` accepted in the base command) was caught by writing the test *before* confirming the implementation; a stricter validator followed. The TOML bug was found because the external-tools loader consumed `params` from the parsed tree directly — the skills path had been silently tolerant.

**Remaining** — per-tool risk/permission overrides in the manifest, external tools in worker allowlists, waiver expiry/audit review, evaluation of external-tool transcript noise in long sessions.

**Architecture changes** — the registry now has a second, user-controlled source of tools with the same shape and guarantees; waivers add the first user-only event kind (no model-facing writer); the TOML parser's array-of-tables semantics are now actually TOML-shaped, which future `[[…]]` consumers (skills on disk, external tools) depend on.

## Phase 7 — Collaboration

**Implemented**

- Proposals and blockers as first-class worker output (Parts 13, 91): the parser extracts `PROPOSAL:`/`BLOCKER:` sections, each header occurrence starting a new item; `formatReportForManager` renders them for the Manager; reconciliation appends `proposal`/`blocker` events (ids `p-N`/`b-N`, numbered independently) and persists them to memory so future sessions retrieve them.
- TeamState gained a proposals map with lifecycle `active | invalidated | superseded | needs_rework`. A `user_correction` forces every active proposal to `needs_rework` and supersedes active decisions — the reasoning built on pre-correction state cannot silently survive (Part 92). `proposal_invalidated` and `blocker_resolved` are reducer-handled.
- Blocker resolution flows only through decisions: the new `decision` tool (registered in the session alongside delegate/continue_worker) records a `decision` event and resolves any open blocker whose id appears in the statement (word-boundary match, idempotent — a second decision naming the same blocker resolves nothing).
- Objection debate (Part 93): `evaluateObjection` classifies a worker objection against a correction deterministically — *upheld* when the correction addresses the objection's subject, *needs_decision* when it flags a concrete risk (regression, data loss, security, races, migrations…), *dismissed* when it restates mere preference. Corrections trigger the debate once per prior objection (`debatedObjections` set), and surviving objections produce a transcript notice the Manager must act on: record a decision or escalate to the user — never silently proceed.
- Correction propagation (Part 92): `propagateCorrection` resumes every waiting worker with a `USER CORRECTION` re-brief (`worker_started(resumed:true, reason:user_correction)`), so stale waiting reports are re-evaluated instead of trusted; wired into `/correct`.
- Parallel-write discipline (Part 91, defense in depth): while any worker runs, `write_file`/`edit_file` are stripped from the Manager's registry and restored when the last delegation releases — refcounted, with re-deferral of re-registrations mid-window. Role allowlists stay the primary wall; the strip protects the single-writer rule during parallel investigation.
- Completion gate integration: open blockers and objections whose debate verdict is `needs_decision` force the gate to **BLOCKED** with an actionable summary (`open blocker b-1: <reason> — resolve via the decision tool`, `objection obj-2 awaits a decision: <statement>`). A recorded decision that names the artifact (`resolves b-1`, `resolves obj-2`) clears it and re-opens the path to COMPLETE — the Manager cannot finish a task past an unresolved disagreement.
- Debate verdicts are events: `objection_debated` attaches `{verdict, rationale}` to the objection (by id; statement-matched for legacy no-id objections), `objection_resolved` marks it settled. Objections carry `obj-N` ids from reconciliation; decisions resolve objections by id or, for legacy objections, by statement containment.
- Visibility: `/status` gained a `collab` line (proposals active/needs-rework, blockers open, objections unresolved); new `/collab` slash command lists them with ids, debate verdicts, and raisers; Manager system prompt gained a COLLABORATION section (integrate-then-edit, needs_rework semantics, objection handling, gate-blocking id references).

**Tested** — 20 tests in `test/collaboration.test.ts`: parser PROPOSAL/BLOCKER extraction and round-trip rendering; proposals-only reply counts as structured (no spurious format retry); proposal/blocker reconciliation into events, state, and memory; correction → proposals `needs_rework` + decisions superseded; `proposal_invalidated`/`blocker_resolved` reduction; decision resolves exactly the named blocker (idempotent, `b-1` does not match `b-10`); decision-tool end-to-end; all three debate verdicts; once-per-objection debate with the verdict recorded as `objection_debated`; correction propagation into a waiting worker (re-brief + resume marker + completion); propagation no-op; write-strip observed mid-run from the provider and restored-and-functional afterwards; parallel delegations keep tools stripped until the last worker finishes; gate BLOCKED on an open blocker and unblocked by a decision; gate BLOCKED on a needs_decision objection and unblocked only by a resolving decision (dismissed objections never block); legacy no-id objection blocks the gate and resolves by statement; one decision clearing a blocker + objection together; gate stays COMPLETE with no collaboration state.

**Verified** — `npx tsc --noEmit` clean; full suite 88/88 passing (68 pre-existing + 20 new).

**Failed / learned** — the first parser refactor merged consecutive same-header sections into one item (two `BLOCKER:` lines parsed as one blocker — caught by asserting event data, not just counts); sharing one id counter across proposals/blockers/decisions shifted blocker ids and broke resolution-by-id (each artifact class numbers independently now); the first strip implementation restored tools when the *first* worker finished while others still ran (refcounting fixed it); reducer bug caught by keeping the skills map: an in-flight edit had dropped it from TeamState.

**Remaining** — cross-task proposal memory, debate over multiple concurrent objections, waiver path for blockers the user explicitly defers.

**Architecture changes** — blockers now have a single resolution path (decisions), corrections invalidate derived reasoning (proposals, decisions), not just requirements, and collaboration state is gate input: open blockers and undecided objections BLOCK completion. All three are reducer/gate-level invariants: the Manager cannot opt out.

## Phase 6 — Worker Polish (with stream-timeout hardening)

**Implemented**

- Provider stream inactivity timeout (prereq from the live delegation eval): watchdog aborts after `runtime.stream_timeout_seconds` (default 120, 0 disables) without data; SSE reads race the abort signal so silent sockets are interruptible; stalls surface as retryable errors with bounded retries (`maxStreamAttempts`, backoff) then clean failure; timers unref'd (Part 45/86)
- Multi-cycle workers (Part 10 lifecycle): a worker that ends with `WAITING: <need>` enters a persistent waiting state instead of terminating; `worker_waiting` events recorded
- `continue_worker` tool: resumes a waiting worker with a concrete update ("the fix is now applied — re-review"); the worker's task-local context persists across cycles (same session object, cycle counter, prior report); resumption emits `worker_started(resumed, cycle)`; completion cleans the session (Part 11)
- Unknown or stale `continue_worker` ids are refused with the list of currently waiting workers
- Report reconciliation now **persists to memory**: verified findings → `fact` store, objections → new `objection` store, both keyed by content for dedup and retrievable trust-ordered in future sessions (`PRIOR OBJECTION … evaluate whether it still applies`) — no raw event-log spelunking

**Tested** — mid-stream stall abort (retryable, first chunk preserved), pre-first-chunk stall, bounded retry exhaustion path (config-level), waiting→resume lifecycle including session cleanup and `resumed` events, unknown-id refusal with waiting list, memory persistence of findings/objections and their retrieval.

**Verified** — 68/68 tests, strict typecheck clean.

**Failed / learned** — racing a stream read against abort required the reader to consume the losing read's rejection, and the watchdog timer needed unref: two subtle ways a timeout fix itself hangs or holds the process. Both surfaced as test-harness hangs before ever running live.

**Remaining** — waiting-worker summary line in `/status`; cross-worker objection debate (Phase 7); staffing evaluation against real workloads.

**Architecture changes** — workers gained durable task-scoped sessions (`WorkerSession`) and a second tool (`continue_worker`); memory gained one store kind. No new completion authority.

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
