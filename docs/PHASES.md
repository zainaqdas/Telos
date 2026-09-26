# Synergon — Phase Reports

## Phase 11 (spec Part 96) — Optimization: Measured, Then Done

**Doctrine first** — Part 96 says "Only after real usage … Measure before optimizing." So this phase shipped a **benchmark** before a single optimization: `evals/bench.ts` (`npm run bench`) drives the runtime's per-turn hot paths over a synthetic 2000-event task log and reports ms/op for event-log reads, gate evaluation, memory retrieval, skill routing, and transcript token accounting.

**What the numbers indicted** — baseline on a 2000-event session with 400 gate evaluations (the loop evaluates the gate after every tool result):

| Path | Baseline | After |
|---|---|---|
| `gate.evaluate()` (re-read + re-reduce whole JSONL per call) | **5.19 ms/call** · ~2.08 s per task | **0.063 ms/call** · ~25 ms per task (**82×**) |
| Memory retrieval (500-record store) | 0.54 ms/instruction | unchanged — already cache-backed, not a hotspot |
| Skill routing (5 skills) | 0.004 ms/instruction | unchanged — deterministic tiers are cheap |
| Transcript token accounting (100 msgs) | 0.004 ms | unchanged |

**Implemented**

- **`EventLog.onAppend`** — push notification after the durable write succeeds; listener exceptions are contained so a broken observer can never fail an append. Single-writer discipline (one `EventLog` instance per task, rebound via `attachEvents`/`stateStore.attach` on `/new`) makes the push model sound.
- **`StateStore`** (`src/events/state-store.ts`) — incremental derived state: the reducer's pure `apply` is now exported, and the store folds each event into the cached `TeamState` exactly once. `current()`/`events()` are O(1) views; `attach()` re-derives for a fresh task; `rebuild()` recovers from the log (the log stays the authority); `dispose()` releases the listener at shutdown.
- **Gate + loop rewiring** — `CompletionGate` accepts a `StateStore` (all 27 legacy function-source call sites in tests/evals keep working unchanged); the session and the Manager loop's internal state reads (`ensureRequirement`, `satisfySkillConstraints`, `checkSkillConstraints`) consume the store instead of re-reading the log.
- **Retrieval/prompt paths audited, not churned** — measurement showed memory query, skill routing, and token accounting are all sub-millisecond and already cache-backed; the system prompt is a fixed ~2 KB with a bounded repo profile. Per Part 96's own doctrine, these were left alone.

**Tested** — 5 new tests in `test/state-store.test.ts`: incremental fold ≡ full reduce asserted after *every* append in a 40-event stream (requirements, blockers, findings, instructions, budget counters, task status), `/new` rebind (old log can't leak in, fresh log folds), `rebuild()`/`dispose()` semantics (log is authority; disposed store stops folding), broken-listener containment, and gate verdict equivalence between store-backed and function-backed sources across a verdict-changing event sequence. `npx tsc --noEmit` clean; **151/151** unit tests; scenarios 6/6.

**Remaining** — same hot path inside worker sessions (workers still full-reduce; their logs are small and task-scoped), SSE/HTTP MCP transports, Anthropic live-key verification.

## Phase 10 (spec Part 55) — MCP via the Unified Tool Registry

**Implemented**

- **MCP stdio client** (`src/mcp/client.ts`): JSON-RPC 2.0 over a child process's stdio — the standard MCP local transport — with zero dependencies. Lifecycle: spawn → `initialize` handshake → `initialized` notification → `tools/list` → `tools/call` → stop. Every request is timeout-guarded; a server that dies rejects all in-flight calls (never hangs), and `stop()` SIGTERMs with a SIGKILL backstop. Newline-delimited framing with tolerance for stdout log noise.
- **Config** (`[[mcp.servers]]`): name (validated, unique), command (single line), args, optional env table (string→string), `timeout_seconds` (1..600, default 30), optional `worker_roles`. Errors are reported per-server as startup notices, never crashes. Policy stays user-owned exactly like external tools.
- **Registry compilation** (`src/mcp/tools.ts`): each MCP tool becomes a standard `ToolDefinition` named `mcp_<server>_<tool>` (sanitized, collision-impossible, never shadows existing tools) — same schema validation, repetition guard, budgets, and transcript treatment as builtins; **no MCP-specific logic anywhere in the Manager** (Part 55's core requirement). Calls that fail (server down, `isError`, timeout) return failed ToolResults — one bad server degrades, the session doesn't. Tools close over the live client; registrations return it for shutdown tracking.
- **Worker access**: `worker_roles` on a server lets those roles call its tools through the same scoped-registry path as external tools; default is manager-only.
- **Session wiring**: servers start once at session boot (notices `⚙ mcp server 'x': N tool(s)` or `unavailable: …`), and `closeMcpClients` runs in shutdown — MCP servers die with the session (same discipline as shell children and the browser).

**Tested** — 8 new tests in `test/mcp.test.ts` against a **real MCP server subprocess** (not a mock client): config parsing (valid/duplicate/bad-name/env-type/timeout-bounds/roles-validation/absent-section), handshake+list+call round-trip, registry compilation (prefixing, schema enforcement through `validateToolArgs`, `isError` → failed ToolResult), crash-at-start reported as failed registration, hung-call timeout enforcement (700ms deadline honored, not the 30s default), worker-role visibility. Plus a TOML regression: `[a.b]` after `[[a]]` targets the **last** array entry (this was a real parser gap — see below). A full-session E2E (mock provider + real MCP subprocess + real config.toml) verified the complete Part 55 path: tool advertised in the tools list → `mcp_files_read_file` tool_call dispatched → result round-tripped into the model transcript → tool-call budget incremented → clean shutdown.

**Failed / learned** — the first test run **hung the whole suite**: the registry test never stopped its client, so a live subprocess kept the node:test process alive (try-block `const`s also proved invisible to `finally`, hiding the client reference). Both fixed in the test; the product's own timeout/exit paths were already sound. The env-table test then exposed a **real TOML parser gap**: `[mcp.servers.env]` threw "conflicts with earlier value" because the `[section]` branch rejected intermediate arrays — TOML requires it to attach to the last `[[mcp.servers]]` entry. Fixed in `src/config/toml.ts` (mirrors the Phase 8 array-section fix) and locked with a regression test. Finally, an E2E lesson: MCP children snapshot `process.env` at spawn, so runtime `process.env` changes are invisible to already-running servers — test tooling must bake flags in at spawn time.

**Remaining** — spec Phase 11 / Part 96 optimization (gate re-reduction caching, retrieval/prompt tuning, `/compact` integration with workers), MCP resources/prompts (tools only for now, matching Part 55's scope), SSE/HTTP MCP transports for remote servers.

## Phase 11 (spec Phase 9) — BYOK + Additional Providers + Cost Accounting

**Implemented**

- **Native Anthropic provider** (Parts 52–53): the Messages API is genuinely not OpenAI-shaped, so it got its own implementation — system as a top-level parameter, tool results as `tool_result` blocks inside user turns, tool calls as `tool_use` content blocks assembled from `input_json_delta` streams, images as `source.base64` blocks, usage split across `message_start` (input/cache-read tokens) and `message_delta` (output tokens). Same `Provider` interface, same watchdog-abort/retryable-error discipline as the OpenAI path; adding it required zero Manager changes (Part 53 satisfied).
- **Cost accounting** (Parts 22–24): `[model.pricing]` in config declares USD-per-Mtok prices (input/output, optional cache-read); the BudgetEnforcer computes cost from actual token granularity (`inputTokens`/`outputTokens`/`cachedTokens` now tracked). Provider-reported `costUsd` is authoritative when present; declared pricing yields the estimate otherwise; **both absent → null, never invented**. Displayed in the budget bar and `/status`. The schema stays ready for future provider-reported costs exactly as Part 23 asked in Phase 0.
- **Live model discovery** (Part 52): `/models` queries the endpoint's `/models` route (OpenAI-shape and Anthropic-shape both supported) and falls back honestly to the curated catalog when the endpoint has none. Verified live: the vyceai endpoint returned its model list.
- **Worker model override** (Part 7 affinity): `worker_model = "…"` in `[model]` routes worker delegations to a cheaper model — elastic staffing becomes economical; the Manager keeps the flagship.
- Anthropic joined the provider catalog (`/provider` now shows it as available) and the BYOK default-key mapping (`ANTHROPIC_API_KEY`).

**Tested** — 8 new tests: Messages-API request encoding (system hoisting, tool_result/tool_use blocks, image source blocks, input_schema tools), SSE text+usage assembly (input 120 / cached 50 / output 7 → correct combined usage), tool_use delta assembly (`{"path":"."}` reassembled from two deltas), factory returns the native path, cost estimate null-without-pricing → computed-with-pricing (cache-read rate honored) → provider-reported authoritative, `[model.pricing]` parsing + validation (`input_per_mtok: "free"` rejected), `resetUsage` clears accumulated cost. `npx tsc --noEmit` clean; **137/137** unit tests; scenarios 6/6.

**Verified live** — real-provider smoke: `/models` returned the endpoint's live model list (7 models incl. `deepseek-v4.1`); a real turn with declared pricing (`$1/$4 per Mtok`) displayed `cost est. $0.0025 (from declared pricing)` after ~2.4k tokens. No Anthropic key in this environment, so the native path is mock-verified (SSE mock server) rather than live-verified — honest limitation.

**Failed / learned** — the smoke config first used a TOML inline table (`pricing = { … }`), which our minimal parser rejects; the `[model.pricing]` section form is the documented shape (inline tables remain unsupported — consistent with the parser's scope). The capabilities stub initially matched only `claude-3`/`claude-4` strings, misclassifying `claude-sonnet-4-5`; capability checks for unknown models now default to capable rather than silently disabling features.

**Remaining** — MCP (spec Phase 10) through the unified registry, optimization phase (Part 96: gate re-reduction caching, retrieval/prompt tuning), per-provider capability probing at session start, Anthropic live-key verification.

**Architecture changes** — two genuinely different wire protocols behind one interface; cost became first-class budget state (tracked per granularity, displayed, never fabricated); model selection is now per-role (manager vs workers).

## Phase 10 (spec Phase 8) — Web + Browser + Vision

**Implemented**

- **`web_search`** (Part 48): keyless search via DuckDuckGo Lite with a deterministic parser built against the *live* endpoint's actual shape — single-quoted class attributes, `href` before `class`, redirect-wrapped URLs (`uddg=`) unwrapped, snippets in `<td class='result-snippet'>` siblings carrying both real tags and HTML-escaped markup. Returns title/URL/snippet triples; URLs travel with every claim (sources are kept).
- **`read_url`** (Part 48): fetches with timeout + cancellation-signal support, strips scripts/styles/nav, decodes entities, caps output, and writes the full text to `.project-agent/cache/reads/` for later reference.
- **Browser tools** (Parts 49–50): `browser_open` / `browser_click` / `browser_type` / `browser_screenshot` / `browser_console` drive the user's own Chromium-family browser over the Chrome DevTools Protocol using only Node built-ins (`spawn`, `fetch`, native `WebSocket`) — no Playwright/Puppeteer. Design decision and rationale in `docs/browser-design.md`: launch `--headless=new --remote-debugging-port=0`, read the DevTools port from stderr, connect to the page target, JSON-RPC (Runtime.evaluate, Page.navigate, Page.captureScreenshot, consoleAPICalled/Log.entryAdded). Screenshots land in `.project-agent/cache/screenshots/`. The browser launches lazily, is tracked by the CancellationController (no orphans), and is killed on session end. Where no browser exists, every tool returns a structured, actionable failure — the gate honestly reports BLOCKED rather than pretending verification happened.
- **Image input** (Part 51): `/image <file|URL>` attaches a PNG/JPEG/GIF/WebP to the *next* instruction. The ManagerLoop gates on the provider's real `supportsVision` capability: images become `image_url` data-URI content parts on the wire only for vision-capable models; otherwise a system notice records the drop (never silently ignored). Verified end-to-end against the real provider: valid PNG attached → `IMAGE_RECEIVED` from the model.

**Tested** — 8 new tests: entity decoding, DDG-Lite parsing (live-shape fixture: redirect unwrap, quote styles, snippet pairing, escaped+real tags), readable-text extraction, vision gating both ways (image parts sent to vision models, drop recorded for non-vision), browser-tool graceful degradation without a browser binary, browser evidence flowing through `verification_result` to the gate, wire-shape data-URI conversion. `npx tsc --noEmit` clean; **129/129** unit tests; scenario evals still 6/6.

**Verified live** — `evals/phase8-web/live.sh` against `deepseek-v4.1`: web_search invoked → nodejs.org URL cited from read_url → `/image` accepted → model confirmed image receipt (`IMAGE_RECEIVED`) → browser_open failed gracefully on this Chromium-less box → no crashes. Also probed directly: the endpoint accepts image content parts, and the provider encodes our parts to `image_url` correctly on the wire.

**Failed / learned** — the first parser assumed double-quoted attributes and `<a>` snippets; the live endpoint uses single quotes and `<td>` siblings, so search silently returned zero results until I probed the real HTML — **parse against the real thing, not the imagined shape**. The eval's first image fixture was a header-only 8-byte "PNG"; the model correctly refused to describe a truncated file, which proved the pipeline honest in both directions. A driver-side race (sending the question before the attach settled) produced one flaky FAIL; isolated probes re-proved the wire path before the rerun passed.

**Remaining** — browser scroll/keyboard CDP coverage, Firefox/Safari (incomplete CDP — documented, not hidden), optional Playwright peer-package for complex flows, spec Phase 9 (multi-provider + native Anthropic + cost reporting), MCP, optimization phase.

**Architecture changes** — network tools join the same registry/permission/risk/guard discipline as everything else; `ToolExecContext` now carries the cancellation signal; the browser is the first lazily-spawned long-lived resource with the same no-orphan guarantees as shell children; vision capability is consulted per model, not assumed.

## Phase 9.5 — Spec Part 61 commands + mandatory scenario evals (Parts 72–79)

**Implemented**

- **Slash commands completed** (Part 61): `/undo` (edit journal — pre-edit content captured before every successful `write_file`/`edit_file`; restore or remove-on-created; depth-capped at 50), `/retry` (re-runs the previous instruction), `/compact` + automatic threshold-based compaction (`runtime.compaction_threshold_tokens`, default 60k, 0 disables), `/new`/`/clear` (fresh task: new event log, gate, budget usage, transcript, journal — durable memory persists), `/provider` (provider catalog with key presence per BYOK env var), `/models` (live capability discovery + curated model list). A typed `/cancel` now acts **immediately** mid-run instead of queueing behind the run it was cancelling — a real UX bug the cancellation scenario's design review surfaced before any eval ran.
- **Context compaction (Part 68)**: runtime-owned, reducer-informed. The digest is built from the event log (the authoritative record), never from the model's own summary of itself. Preserved by construction: system prompt, unresolved corrections, open blockers, undecided objections, active requirements/skills, active decisions, recent failures, guard blocks. Injected as a system notice — no fake dialogue. The ManagerLoop consults compaction before every model turn (worker loops never compact); `/compact` forces it on demand.
- **Scenario evals** (`evals/scenarios/scenario.ts`, `npm run eval:scenarios`): the spec's mandatory scenarios run the real loop, real tools, real guard, and real event log against a scripted provider, asserting on emitted events and gate verdicts: P76 repetition (identical failing call executed exactly twice, third refused pre-execution as `REPEATED_FAILURE`, changed-state retry allowed), P77 completion gate (fail→INCOMPLETE, verified fix→COMPLETE, unverified write→INCOMPLETE), P78 budgets (tool-call: stop + `budget_exceeded` recorded once + zero hidden calls; token: mid-turn usage overshoot stops the run), P79 cancellation (cancelled run preserves partial output, records no completion), P74 correction (correction event, requirement invalidation, stale evidence marked invalid).

**Two real runtime gaps the scenarios exposed** (both fixed):

- *Mid-turn token overshoot*: provider-reported usage arrives with the finished response and could push the task over budget with no check until the next turn's start — one more model call could silently run on an exhausted budget. The loop now re-checks `firstViolation()` immediately after recording usage.
- *Corrections could not reopen a terminal task*: the reducer left `taskStatus` at `completed`/`cancelled` after a `user_correction`, so post-correction work was judged against a closed task. A correction now reopens the task — the user is boss, and follow-up work faces the gate again.

Also fixed: partially streamed assistant text was discarded on mid-stream cancellation/provider failure; `assistantText` now tracks the stream as it arrives (Part 78: stop means stop, state is preserved).

**Tested** — 7 new unit tests (journal capture/restore/created-file removal/cap, digest protection of corrections/blockers/requirements/failures, compaction shape + threshold/force semantics, budget `resetUsage`). `npx tsc --noEmit` clean; **121/121 unit tests**; **6/6 scenario evals**.

**Failed / learned** — the first token-budget scenario exposed the overshoot gap only because it asserted on events rather than internals; the correction scenario failed until the reducer learned to reopen terminal tasks; two scenario drafts had assertion-math bugs (transcript under the threshold it claimed to exceed; a "build" classified as a lint by the head-matcher) — the eval harness is only honest when its own fixtures are.

**Remaining** — spec Phase 8 (web + browser + vision), spec Phase 9 (multi-provider + cost reporting), MCP (spec Phase 10), optimization phase (Part 96: gate re-reduction caching, retrieval tuning). `/models` currently reports curated lists, not live endpoint discovery.

**Architecture changes** — compaction is runtime policy informed by the reducer, not model judgment; the edit journal introduces the first user-level inverse operation; scenario evals now exist as a committed, repeatable gate for the spec's mandatory behaviors alongside the unit suite and the live collaboration harness.

## Phase 9 — Tool policy completion (+ live harness verification)

**Implemented**

- **Live verification first**: the Phase 8 harness ran against the real provider for the first time and immediately proved its worth — the driver had never survived its own first prompt-wait (`set -e` + `pipefail` killed the script on `grep` over the empty log), the child was never `cd`'d into the staged project, and the dictated stagecraft let the model finish with a green suite and a still-invalidated checklist. All fixed; final run **13/13 audit checks PASS** against `deepseek-v4.1`.
- **Two real collaboration gaps the live run exposed** (both found by the audit, not by code reading):
  - *Decisions must survive paraphrase*: the model recorded `resolves the courier sandbox credentials blocker…` without naming `b-1`, and `recordDecision` matched ids only — so no `blocker_resolved` ever fired. `recordDecision` now falls back to a conservative paraphrase matcher: `"<desc> blocker(s)"` phrases are lifted from the statement (how humans actually refer to blockers) and must cover ≥2/3 of the desc's significant tokens in the blocker's reason; a whole-statement coverage fallback (≥half coverage, ≥3 token hits, strictly best, ties resolve nothing) covers the rest. Tokens are stop-word-filtered and stemmed; thin or ambiguous statements resolve nothing — a wrong auto-resolution is worse than an unresolved blocker, which stays visible at the gate.
  - *Invalidated checklists could never recover*: a correction invalidates satisfied skill requirements, but `satisfySkillRequirements` only touched `pending` ones — post-correction runtime evidence (edits, green runs) silently failed to re-earn them and the gate stayed INCOMPLETE forever. Both pending and invalidated items now qualify; the reducer's append-only replay keeps this deterministic (newest evidence wins).
- **Per-tool policy overrides (Part 55 completion)**: `[[tools.external]]` accepts `risk` (`low|medium|high`), `permission` (`read|write|shell|network`), and `worker_roles` (subset of explorer/researcher/reviewer/qa). Defaults unchanged (`shell`/`high`/manager-only); `permission = "read"` also flips `mutative` off. Invalid values are **hard parse errors** — a policy line that silently no-ops is worse than a rejected declaration. `ToolDefinition` gained optional `external`/`workerRoles` policy surface; `workerExternalTools(registry, role)` reads it back without an import cycle.
- **Worker-accessible external tools**: `scopedRegistry` adds external tools that *explicitly* declare the worker's role — read-only linters/format-checkers can run inside qa/reviewer investigations while arbitrary commands stay manager-only. Roles still cannot write workspace files: only user-named externals pass.
- **Waiver expiry (Part 95 completion)**: `/waive <id> for <Nh|Nd> [reason]` records an absolute `expires_at`; the reducer stores `waiverExpiresAt` (falling back to event-time anchoring when only a TTL is present, so replays stay deterministic), and the gate treats an expired waiver as an open blocker again — surfacing `open blocker b-1 (waiver expired) … or re-waive via /waive`. A waiver is now what it always should have been: a *temporary* reprieve the user can bound, with the system refusing to forget a waived blocker silently.

**Tested** — 5 new tests: policy overrides compile onto the ToolDefinition; defaults stay shell/high/manager-only; invalid policy values are hard errors; `workerExternalTools` grants exactly the declared roles; expired-waiver re-opens the blocker at the gate (while an active waiver keeps COMPLETE with waived-visibility). Plus two collaboration tests pinning the paraphrase matcher (unambiguous paraphrase resolves; ambiguous/thin statements resolve nothing) and the loop-level correction→invalidation→re-satisfaction lifecycle test. `npx tsc --noEmit` clean; **114/114 passing**.

**Verified** — harness live PASS (13/13 audit checks) after the fixes above; key staged at `/tmp/.syn_eval_key` (mode 600) and shredded after; artifacts cleaned on PASS.

**Failed / learned** — the harness's first three live attempts failed for reasons unit tests could never catch: a `pipefail`+`set -e` interaction on an empty log, a missing `cd`, and stagecraft that permitted the model to satisfy the letter ("run npm test first") while skipping the red observation the checklist semantics required — the dictated steps now specify the repro test, its expected failure, and the cleanup explicitly. The paraphrase threshold had to be built around real model output: the first token-overlap draft diluted below threshold once the model embellished its blocker reason with parentheticals, which is exactly why the `<desc> blocker` phrase-lift exists. The waiver-TTL test caught a genuine reducer design flaw: anchoring the deadline to the *current clock at reduce time* makes expiry non-deterministic under replay — absolute deadlines (with event-time fallback) fix it.

**Remaining** — waiver audit review surface (`/collab` already shows waived blockers; a review command listing expiring waivers is cheap to add), evaluation of external-tool transcript noise in long sessions, cross-task proposal memory, debate over multiple concurrent objections, gate re-reduction caching (Part 96).

**Architecture changes** — tool policy is now data on the definition, not a fixed property of builtins vs externals; worker scoping consults user-declared policy; waivers became time-bounded state the gate re-evaluates. `recordDecision` is the first matcher in the codebase tuned against live provider phrasing rather than test fixtures.

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
