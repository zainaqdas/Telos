# Telos vs. the field: a comparative study of OpenCode, Aider, Pi, and Codebuff/Freebuff

Study date: 2026-09-26 · Trees studied: sst/opencode (default branch, shallow), Aider-AI/aider,
badlogic/pi-mono, CodebuffAI/codebuff. Method: file-by-file reading of the agent loop, tool layer,
provider/streaming layer, prompts, and context management of each project, compared line-for-line
against our `src/`.

Scope of the codebases studied (source lines, excluding tests):

| Project | Lines | Language | Architecture |
|---|---|---|---|
| OpenCode | ~141k | TS (Effect) | Client/server; local runtime; models.dev catalog |
| Codebuff/Freebuff | ~297k | TS | CLI (Ink/React) + agent-runtime package + SDK; XML tool protocol |
| Pi (pi-mono) | ~78k | TS | `pi-ai` provider library + agent package + custom TUI toolkit |
| Aider | ~20k | Python | Single-process, LiteLLM, coders-per-edit-format |
| **Telos** | **~9k** | TS | Single process, zero deps, raw SSE |

Verdict up front: our *architecture* (event sourcing, budget enforcement, gate) is sound and in
some areas ahead of all four. What we get wrong is concentrated in three layers: **provider
robustness, tool ergonomics for the model, and feedback loops after edits**. The findings below
cite their files and our gaps, ordered by impact.

---

## 1. Provider layer: the single biggest correctness gap

### 1.1 Model metadata is not optional — all four treat it as infrastructure

- **OpenCode** pulls a full catalog from **models.dev** (`provider/provider.ts:704` —
  `limit: { context: m.context, output: m.output }`), with per-model input limits, output caps,
  modalities, and pricing. `provider/transform.ts` sets `OUTPUT_TOKEN_MAX = 32_000` and clamps
  requests per model family.
- **Pi** ships a typed **model catalog** (`packages/ai/src/model-catalog.ts`) where every model has
  `contextWindow: number; maxTokens: number` (`types.ts:1091`). Before every call,
  `simple-options.ts` runs `clampMaxTokensToContext()`:
  `maxTokens = min(requested, contextWindow − contextEstimate − 4096)`.
- **Aider** carries `max_input_tokens` / `max_output_tokens` per model (`models.py:281-358`) and
  derives `max_chat_history_tokens = clamp(max_input/16, 1024, 8192)`.
- **Codebuff** leans on the Vercel AI SDK (`"ai": "^7.0.59"`) which embeds provider metadata.

**Telos:** `capabilities()` returns **hard-coded constants** — `contextLimit: 128_000` for every
OpenAI-compatible model (`openai-compatible.ts:30`), and we send `max_tokens` (32k) to a gateway
that silently caps at ~4k and *ignores* the field. We discovered this empirically only because the
live test failed. We have no per-model limit knowledge, no models.dev-style source of truth, and no
`clampMaxTokensToContext` equivalent.

**What we're doing wrong:** our provider layer lies to the loop about the model. Consequences hit
everywhere: compaction thresholds tuned for a 128k context can overflow an 8k-context local model;
output caps are invisible, so `finish_reason: length` surprises us.

**Fix direction:** a `models.json` catalog (vendor it from models.dev) keyed by model id substring,
carrying `contextWindow`, `maxOutput`, `ignoresMaxTokens`, `capsOutput` (observed cap), and
`supportsReasoningField`. The session resolves model → limits at boot and (a) sets `max_tokens`
appropriately, (b) feeds compaction a real budget, (c) warns in the banner when the configured
model's context is small.

### 1.2 `finish_reason: length` must be a first-class state — and our recovery guidance is better than two of theirs

- **Pi** (`agent-loop.ts:264-268`): when `stopReason === "length"`, **every tool call in that
  message is failed automatically** — "the response hit the output token limit, so its arguments
  may be truncated. Re-issue the tool call with complete arguments." They never execute a
  potentially borked call.
- **Aider** (`base_coder.py:1492`): raises `FinishReasonLength` and — if the model supports
  assistant prefill — **continues the same message** by appending the partial response as a
  `prefix=True` assistant message and streaming the remainder. That's a genuine resume mechanism,
  not just an error.
- **OpenCode** relies on the AI SDK's built-in `stopReason` mapping and its `invalid` tool sink
  (see §3.2).
- **Telos** (fixed 2026-09-26): we now detect `length` and return chunked-write guidance naming
  `append_file` and the partial path (`loop.ts` truncation branch). This is the *right* shape —
  more actionable than Pi's generic message — but we learned it by accident from a live failure
  while all four designed for it up front.

**What we're doing wrong:** reactive instead of deliberate. We should have had a
`stopReason: length` test from day one (Pi and Aider both do).

### 1.3 Retry is far too naive

- **OpenCode** (`session/retry.ts`): 7 regex families of retryable errors, `RETRY_INITIAL_DELAY =
  2000`, backoff ×2, **jitter ×0.25**, honors `retry-after` / `retry-after-ms` headers, max 5
  retries, and classifies *which* retry reason to show the user (free tier vs rate limit vs
  network).
- **Aider** (`base_coder.py:1469-1489`): exponential backoff from 0.125s with a cap, litellm's
  exception taxonomy, and it *opens the error's URL* for the user when the provider returns one.
- **Telos:** `500ms × attempt`, max 2 attempts, no header awareness, no jitter, no error
  classification beyond `retryable: status >= 500 || 429`.

**What we're doing wrong:** under real gateway load (exactly what vyceai exhibits) our retry gets
3 tries in 1.5s and gives up. OpenCode would back off for up to 30s with jitter and honor the
server's `retry-after`.

**Fix direction:** port the OpenCode pattern — pattern list, header-aware delay, jitter, 5
attempts, and a visible "retrying in Xs (reason)" line so the user isn't staring at silence.

### 1.4 Reasoning/thinking is a supported content type, not an afterthought

- **Pi** has a `thinking` content block type end-to-end (`openai-completions.ts:107`), maps
  `reasoning.text`/`reasoning.encrypted` parts, and carries thinking budgets per model.
- **Codebuff** has `reasoningOptions` per agent (`max_tokens` or `effort` levels) routed to
  OpenRouter.
- **OpenCode** tracks reasoning parts in a `reasoningMap` with timers (`processor.ts:207-213`) and
  ships a dedicated thinking TUI context.
- **Telos:** we now surface `reasoning_content` deltas (dim), which is at parity for *display*, but
  we still (a) don't parse `<think>` inline tags some gateways emit in `content`, (b) don't pass a
  thinking-budget control, and (c) drop thinking from the transcript entirely — Pi's `clamp` and
  cache logic explicitly keeps it because models need their own reasoning on follow-up turns for
  some providers.

### 1.5 Prompt-cache friendliness is designed for; ours is accidental

- **Pi** has `openai-prompt-cache.ts`; Aider does `warm_cache()` before sending and orders
  `chat_chunks` so the stable system + files prefix stays byte-identical across turns;
  **Codebuff** documents prompt-cache retention options in `StreamOptions.cacheRetention`.
- **Telos:** our system prompt is stable, but we rebuild `tools` from the registry each turn and
  our worker flow *strips and restores write tools* between turns — every tool-strip cycle
  reorders the serialized tool array, which can invalidate provider-side prompt caching of the
  tools block (OpenAI-compatible caches are prefix-based; tool definitions are part of the
  prefix).

**Fix direction:** keep the tool array order stable; when stripping write tools, replace them with
placeholders rather than removing them, or sort canonically. Mark the stable prefix (system + tools)
and never mutate it mid-task.

---

## 2. Tool layer: theirs are built for the model that has to use them

### 2.1 Edit robustness: Aider's whole raison d'être — and our biggest functional gap

Aider survived two years of weak models by making edits **self-healing**
(`coders/editblock_coder.py:134-300`):

1. `perfect_or_whitespace` — match ignoring leading whitespace differences;
2. blank-line-tolerant retry;
3. `try_dotdotdots` — recognize `...` elision the model added and splice around it;
4. `replace_closest_edit_distance` — when all else fails, apply to the **closest match by edit
   distance** and report what it did;
5. precise, per-hunk error messages (`UnifiedDiffNoMatch`, `UnifiedDiffNotUnique`, plus "Note: some
   hunks did apply successfully") so the model can recover partial failures;
6. up to `max_reflections = 3` automatic re-asks with the error fed back.

**Telos:** `edit_file` requires an exact `includes()` hit and fails on ambiguity. Our live test
showed the model *can* use it, but one whitespace drift away from a failed loop. We have no fuzzy
fallback, no partial-application reporting, and no whitespace-tolerant match.

**Fix direction (in priority order):** whitespace-normalized matching; "did you mean" nearest-match
suggestion in the failure message (cheap: keep our line scan, add edit distance on the failing
window); `count` semantics aligned with OpenCode's `replaceAll`; and a `search_replace` variant
that reports *all* matches with line numbers when ambiguous instead of just the count.

### 2.2 Every tool output is a designed artifact with explicit truncation semantics

- **OpenCode** separates the *description for the model* (`read.txt`: "Any line longer than 2000
  characters is truncated… Call this tool in parallel when you know there are multiple files you
  want to read") from the implementation, caps `MAX_LINE_LENGTH = 2000`, `MAX_BYTES = 50KB`, and —
  crucially — **spills the full output to a file** (`truncate.ts`: `outputPath`, retention 7 days)
  so nothing is ever lost, only elided from context.
- **Pi** does the same: bash output truncates to last N lines/KB with `fullOutputPath` spill, and
  **streams partial output live to the UI** via `onUpdate` checkpoints every 2s (`bash.ts:74-100`)
  — the user watches `npm test` scroll while it runs.
- **Telos:** `read_file` truncates silently at 2000 lines with no spill and no per-line cap; the
  model that wants the rest must know to paginate (our description hints at it, theirs states the
  continuation protocol explicitly). Our `run_shell` captures to a 1MB string buffer and truncates
  with no spill file, and streams nothing.

**What we're doing wrong:** (a) truncation without a recovery path (the model can't ever see the
elided content); (b) no live tool output — a 90s `npm install` renders as one frozen `⚙ run_shell`
line, which *feels identical to a hang* — the exact complaint that started the live-session
investigation.

**Fix direction:** spill-to-file for both `read_file` and `run_shell` overflow (`.project-agent/spill/`),
with the path returned in the result ("full output: …, use read_file offset to continue"); stream
shell output to the UI line with throttling (π's 2s checkpoint idea).

### 2.3 Search: they bundle ripgrep; we walk the tree with Node

OpenCode **downloads and manages a real ripgrep binary** (`packages/core/src/ripgrep/binary.ts`,
per-platform pinned 15.1.0) and both its `grep` and `glob` tools go through it. Aider uses
`grep_ast` (tree-sitter) for language-aware matching.

**Telos:** `search_text` is a recursive `readdir` walk in JS, skipping a hard-coded IGNORE list,
capped at 3000 files, reading every text file fully into memory. On any real repo this is slow
(seconds) and memory-heavy; it also has no `.gitignore` awareness (only a fixed list).

**Fix direction:** spawn `rg` when present on PATH (it is on most dev machines), keep the JS walk
as fallback; or vendor `@vscode/ripgrep`. Respect `.gitignore` at minimum.

### 2.4 Parallelism and serialization of tool calls

- **Pi** (`agent-loop.ts:517-519`): tools declare `executionMode`; safe read tools run
  **in parallel** within one assistant turn, mutations run sequentially through a
  **file-mutation queue** (`file-mutation-queue.ts` — per-canonical-path promise chains, so two
  concurrent writes to the same file serialize by canonical path, not by path string).
- **OpenCode**'s system prompt actively trains the model to batch: "send a single message with
  multiple tool calls to run the calls in parallel… use the Task tool in order to reduce context
  usage."
- **Telos:** every tool call runs sequentially, and we never tell the model it *could* batch. Not a
  correctness bug, but a real latency cost on multi-file work.

### 2.5 A structured "invalid tool" sink

**OpenCode** registers an `invalid` tool (`invalid.ts`): malformed calls are routed to a real tool
whose output is `The arguments provided to the tool are invalid: ${error}` — so the failure is a
*normal tool result* in the transcript, consistently formatted, instead of an ad-hoc string.

**Telos:** we return free-form strings. Functionally similar; the difference is theirs is
guaranteed consistent and testable.

---

## 3. The loop: steering, not just queueing

### 3.1 Mid-turn steering is a loop primitive, not an input trick

- **Pi** (`agent-loop.ts`): the loop polls `config.getSteeringMessages()` at **every step
  boundary** and even *between* tool execution and the next model call; queued messages join the
  current context instead of waiting for the run to end. There's also a `prepareNextTurn` hook
  (compaction can run there) and `getFollowUpMessages` for post-stop continuations.
- **Codebuff** (`cli/src/utils/steering-buffer.ts`): a dedicated mailbox between the composer and
  the active run, with an **owner guard** (an aborted run resolving late must not drain a newer
  run's buffer) and leftover-requeue semantics — the level of care you need when cancellations
  race inputs.
- **Telos:** mid-run lines are queued in `pendingLines` and processed only *after* the run
  finishes; a correction mid-run requires the user to Ctrl+C first, or waits. Our `/correct` path
  cancels-then-corrects, which kills in-flight work that might have been 90% done.

**What we're doing wrong:** our "user is boss" doctrine (Part 62) is enforced at task granularity;
pi and codebuff enforce it at step granularity. For an interactive agent this is the difference
between collaboration and turn-taking.

**Fix direction:** at each tool-call boundary in `ManagerLoop`, poll a session-provided steering
callback; if a correction arrived, feed it as a user message at the next boundary (the loop's
budget/gate machinery already handles invalidation). Keep Ctrl+C semantics unchanged.

### 3.2 Compaction is event-driven and budget-aware; ours is threshold-naive

- **OpenCode**: two mechanisms — **prune** old tool outputs (protect the last 40k tokens of tool
  results, only prune beyond 20k, mark `compacted` timestamps, protect `skill` outputs) plus a
  **structured compaction prompt** (`prompt/compaction.txt`: "produce a structured summary… so
  another coding agent can continue") triggered by `isOverflow` computed from the *model's actual
  context window* (`overflow.ts`), not a fixed constant.
- **Codebuff**: **deterministic, zero-cost compaction** (`compact-history.ts`) — no LLM call at
  all; mechanically rewrites history into `<conversation_summary>` keeping "every file read or
  edited, every command run, every user message" — with a parity test ensuring the LLM-based pruner
  agent matches it. They made compaction *free* by making it mechanical.
- **Pi**: `shouldCompact(contextTokens, contextWindow, reserve)` — threshold derived from the
  real context window; compaction runs in `prepareNextTurn`, off the critical path.
- **Telos:** fixed `COMPACT_THRESHOLD_TOKENS = 60_000` regardless of model; digest built from our
  event log (good idea — closer to codebuff's mechanical approach than to LLM summaries), but the
  trigger can never fire *early enough* for an 8k-context model and is uninformed by real usage.

**Fix direction:** keep our event-log digest, but gate it on catalog context window:
`shouldCompact = tokens > contextWindow − reserve − maxOutput`. That single change makes Telos
correct on small local models (ollama users) where we're currently broken.

### 3.3 Aider's two ideas worth stealing outright

1. **Auto-commit + /undo.** aider commits AI edits to git *automatically* (attribute-tagged) and
   offers `/undo` (rolling back to `commit_before_message` SHA). Our journal/undo is
   file-content-based, which loses renames/deletes and can't restore a mixed edit+delete change.
   Git-backed undo is strictly stronger where a repo exists. **Fix direction:** if `.git` exists,
   snapshot-commit (or `git stash create`) before mutating tools; `/undo` = `git reset --hard` to
   the snapshot.
2. **Lint-after-edit.** After every edit, aider lints the changed file and feeds failures back
   into the same turn (`lint_edited`, `base_coder.py:1681`). OpenCode does the LSP version: after
   `edit`, it queries diagnostics and appends "LSP errors detected in this file, please fix: …" to
   the tool output (`edit.ts:196-205`). **Telos has nothing** — our gate catches *test* failures
   only at completion time, so syntax errors surface a full turn later than they must. **Fix
   direction:** post-edit `node --check` (JS/TS) or language-appropriate syntax probe, result
   appended to the edit tool output; it converts our `zero-test` gate gap into immediate feedback.

### 3.4 Context assembly: conventions files, per-provider prompts, reminders

- **OpenCode**: instruction files (`AGENTS.md`, `CLAUDE.md`, up-the-glob) discovered per directory,
  injected as system text; **15 provider-specific prompt variants** (105-line Anthropic prompt,
  147-line GPT "beast" prompt, Kimi, Gemini…), selected by model id; synthetic per-turn
  **reminders** for plan/build mode switches.
- **Aider**: `example_messages` per edit format (few-shot examples of the edit syntax — this is
  how edit formats survive weak models), `lazy_prompt`/`overeager_prompt` reminders injected at
  the tail of every request.
- **Telos:** one 45-line prompt for all models. Our live test showed the model ignoring
  single-file/HTML conventions (it defaulted to framework-speak until told), and our prompt has no
  few-shot examples at all.

**Fix direction:** minimum viable version — (a) read `AGENTS.md`/`TELOS.md` from root + parents
into the system prompt; (b) add one worked tool-call example (read → edit → run test → report) to
teach the loop shape; (c) a `minimal` prompt variant flag for small models.

---

## 4. Session/UX layer

### 4.1 Markdown streaming with a stable window (aider's mdstream)

Aider renders streaming responses as **live markdown** with a 6-line sliding window at 20fps
(`mdstream.py:92-103`), flushing the final render at completion. Codebuff renders an entire Ink
(React) TUI per turn. Pi built a component TUI with markdown + syntax highlighting. OpenCode's TUI
is a full SolidJS app with a thinking context panel.

**Telos:** raw delta passthrough. It's honest and zero-dep, and after our printer fix it's
readable — but code blocks scroll by unstyled and there's no markdown rendering at rest either. A
minimal improvement preserving zero-deps: at **end of turn**, re-render the final text with a tiny
built-in markdown highlighter (code fences only, syntax-agnostic dim/green) — streaming raw,
resting styled.

### 4.2 Structured in-chat questions

OpenCode's `question` tool lets the model ask the user multiple-choice questions *during* a run
with typed answers — the loop blocks on the UI, and the answer comes back as a tool result. Our
decision/blocker flow covers governance but not "should X be snake_case or camelCase?" mid-task.
Low priority, but it's why their agents guess less.

### 4.3 Subagents: their spawn contract is typed and auditable

OpenCode agent schema (`agent.ts:30-56`): `mode: subagent | primary | all`, own permission ruleset,
own model, own temperature, `steps` cap. Codebuff: `spawn_agent_inline` with `set_output` schemas;
publisher-trust gating for executable agents. Pi: harness tools with declared execution contexts.

**Telos:** our orchestrator is manager↔worker with proposals/blockers — a genuinely different (and
in the governance dimension, richer) model. What we lack vs. them: per-worker `steps`/token caps
are budget-global rather than per-spawn, and worker *prompts* are less structured than their
typed briefs. Cheap win: per-worker `max_tool_calls` default derived from config, reported in the
delegation event.

---

## 5. What Telos already does better (keep, don't regress)

Honest ledger — several things we do are absent or weaker in all four:

1. **Event-sourced state with a reducer.** Our JSONL log + derived state (events/state.ts) is
   auditable and replayable. OpenCode has snapshots/metadata; none of the four has a total ordered
   event log as the source of truth.
2. **Hard budget enforcement before spend.** Pi/opencode have step caps; only our BudgetEnforcer
   checks tokens/tools/wall-clock *before* each spend and mid-turn on usage arrival. Codebuff's
   `maxAgentSteps` is a step count only.
3. **The Completion Gate.** No studied project has a gate that derives COMPLETE from runtime
   evidence and refuses otherwise. OpenCode's plan mode is a governance approximation; ours is
   verdict-based with waivers. This is Telos's differentiator — keep it strict.
4. **Objection/decision/waiver governance.** Blockers with ids, decision resolution, waivers with
   TTL that re-open at the gate — none of the four has anything comparable.
5. **Failure learning with promotion.** Our deterministic root-cause classification and
   verified-lesson promotion is more than opencode's retry taxonomy (which is about transport, not
   about *tool* failure semantics).
6. **Zero runtime dependencies.** All four depend on heavy SDKs (Vercel AI SDK, LiteLLM, Effect).
   Our raw-SSE approach cost us §1's bugs, but once hardened it is *more* controllable — we fixed
   our truncation bug in one afternoon; the AI SDK's would be a fork.

---

## 6. Prioritized fix list

| # | Fix | Why (evidence) | Effort |
|---|---|---|---|
| 1 | Model catalog: per-model context/output limits, `ignoresMaxTokens`, observed output caps; clamp `max_tokens` to context | §1.1 — vyceai silently caps at 4k; hard-coded 128k lies | M |
| 2 | Header-aware, jittered, 5-attempt retry with reason display | §1.3 — OpenCode `retry.ts` pattern | S |
| 3 | Shell output streaming to UI + spill-to-file for read/shell overflow | §2.2 — the "feels hung" complaint; no recovery from truncation | M |
| 4 | Whitespace-tolerant edit matching + nearest-match hint in failures | §2.1 — Aider's ladder | M |
| 5 | Compaction threshold from model catalog (`contextWindow − reserve − maxOutput`) | §3.2 — small-context models currently overflow | S |
| 6 | Post-edit syntax check (`node --check` etc.) appended to edit output | §3.3 — OpenCode LSP-diagnostics pattern | S |
| 7 | Git-snapshot `/undo` when a repo exists | §3.3 — Aider auto-commit/undo | M |
| 8 | Mid-turn steering poll at tool-call boundaries | §3.1 — Pi's loop; our queue-till-end | M |
| 9 | `AGENTS.md`/`TELOS.md` injection + one few-shot tool-call example in prompt | §3.4 | S |
| 10 | Parallel read-only tool execution; stable tool ordering for prompt cache | §2.4, §1.5 | M |
| 11 | Markdown rest-render (code fences) at turn end | §4.1 | S |
| 12 | `<think>` tag parsing for gateways that inline reasoning into content | §1.4 | S |

## 7. File map of what was studied (for future reference)

- **OpenCode:** `packages/opencode/src/session/{processor,compaction,overflow,retry,reminders,instruction,system}.ts`,
  `session/prompt/*.txt` (15 variants), `tool/{read,edit,write,shell,glob,grep,invalid,task,question,todo,truncate}.ts`,
  `agent/agent.ts`, `provider/{provider,transform}.ts`, `packages/core/src/ripgrep/binary.ts`.
- **Pi:** `packages/agent/src/{agent-loop,stream-fn}.ts`, `agent/src/harness/{system-prompt,skills,hooks,messages}.ts`,
  `harness/tools/{bash,write,edit,read,file-mutation-queue}.ts`, `harness/compaction/compaction.ts`,
  `packages/ai/src/{model-catalog,api/openai-completions,api/simple-options}.ts`.
- **Aider:** `coders/base_coder.py` (loop, retries, reflections, lint, auto-commit),
  `coders/{editblock,udiff,wholefile}_coder.py`, `history.py` (recursive summarize), `watch.py`,
  `linter.py`, `mdstream.py`, `models.py`, `repomap.py`.
- **Codebuff/Freebuff:** `packages/agent-runtime/src/{run-agent-step,tool-stream-parser,compact-history,main-prompt}.ts`,
  `system-prompt/prompts.ts`, `common/src/tools/params/tool/*` (39 tools incl. `end_turn`,
  `propose_write_file`, `spawn_agent_inline`), `cli/src/utils/{steering-buffer,active-run,byok}.ts`,
  `docs/agents-and-tools.md` (publisher trust, MCP consent gating).
