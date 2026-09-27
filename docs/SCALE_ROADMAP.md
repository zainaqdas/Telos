# Scale roadmap: large repositories, long codebases, large projects

**STATUS (2026-09-27): ALL FIVE BATCHES SHIPPED.** Test suite 210/210, `tsc --noEmit` clean,
shipped as `@zainaqdas/telos@0.1.6`.

| Batch | Theme | Commit | Tests |
|---|---|---|---|
| 1 | See the repository (search, profile, read caps) | `a334bdb` | `test/large-repo.test.ts` |
| 2 | Survive the context (spill, catalog, compaction) | `d454f50` | `test/scale-batch2.test.ts` |
| 3 | Edit reliably at scale (fuzzy ladder, syntax check, git /undo) | `118a8c8` | `test/scale-batch3.test.ts` |
| 4 | Delegate and steer (parallel reads, steering, retry v2) | `fca2f20` | `test/scale-batch4.test.ts` |
| 5 | Long-project polish (conventions, plan, few-shot, rest-render, sub-budgets, `<think>`) | `6eae4f1` | `test/scale-batch5.test.ts` |

Release bump: `45c506b` → v0.1.6.

---

Goal (user directive, 2026-09-26): Telos must handle a large repository / long codebase, and build
large projects — without regressing the core philosophy: the runtime enforces invariants, the
Completion Gate decides from evidence, zero runtime dependencies, event-sourced everything.

Ground truth from docs/COMPARATIVE_STUDY.md: at ~9k lines we are 10–30× smaller than the studied
agents, and the gaps that matter for scale are concentrated in five places: search, context
economy, edit reliability, delegation, and budget realism. This roadmap sequences every study fix
into shippable batches ordered so that each one measurably improves large-repo behavior.

## The scale bar (how we'll know it works)

A batch is done when it passes the existing 175-test suite **and** the new `evals/large-repo/`
harness:

1. **Navigate**: a generated 3,000-file fixture repo — `search_text` returns in < 2 s with
   `.gitignore` respected; `find_files` finds files by pattern; a 4,000-line file can be read in
   slices and its elided parts recovered.
2. **Endure**: a session that reads ~40 files and runs ~15 commands on a small-context model
   (8k) never overflows — compaction triggers from the *model's real* context window, old tool
   outputs are pruned to spill files, and the task still completes.
3. **Build**: a 20–30-file project (multi-module, tests, docs) is built end-to-end live without
   the model losing the plot mid-way (plan visible, edits verified, gate COMPLETE).
4. **Recover**: a bad edit on a large file is repaired via fuzzy matching or a guided retry; an
   unwanted change is rolled back with /undo.

## Guiding constraints (core philosophy, applied)

- **Zero runtime deps**: ripgrep is *spawned if present on PATH*, never bundled or auto-downloaded;
  every search/path feature keeps a pure-Node fallback. No Effect, no AI SDK, no LiteLLM.
- **Runtime enforces**: budgets, gate, and cancellation semantics unchanged; scale features add
  *evidence and visibility*, never model discretion. Compaction is deterministic/reducer-informed;
  pruning is runtime-owned.
- **Event-sourced**: every new mechanism appends events (`repo_profile`, `tool_spilled`,
  `tool_output_pruned`, `edit_syntax_check`, `git_snapshot_created`, `plan_updated`,
  `provider_retry`) so sessions stay auditable and /new, /compact, gate audits keep working.
- **BYOK/honest UX**: model limits come from a vendored static catalog + observed caps, surfaced
  in the banner (`context 8k · output ~4k capped`), never invented at runtime.

---

## Batch 1 — See the repository (navigation foundation)

*Everything in a large repo starts with: what's here, and where is the thing I need?*

1. **Repo profile v2** (`src/context/profile.ts`): full file tree from `git ls-files` (fallback:
   ignore-aware walk), token-budgeted tree rendering with per-directory file counts, key-file
   detection (manifests, entry points, configs), injected into the system prompt (Codebuff-style
   truncated tree; Aider-style "here's the map").
2. **ripgrep-backed search** (`fs-tools.ts`): `search_text` and `find_files` spawn `rg` when
   available (`rg --json` for structure, `-g` for globs, respects .gitignore for free); keep the
   JS walk as fallback; raise caps (50 → 200 results, 3,000 → 50,000 files); results stay
   `path:line: match`.
3. **read_file hardening**: per-line 2,000-char truncation with an explicit marker (OpenCode
   parity), binary-file detection ("binary, N bytes — not shown"), spill reference for oversized
   files, description states the continuation protocol explicitly.

Events: `repo_profile` (tree stats), `tool_spilled` (spill refs).

## Batch 2 — Survive the context (context economy)

*Large codebases generate enormous tool output; the loop must metabolize it.*

4. **Tool-output spill**: `read_file`/`run_shell` outputs beyond caps are written to
   `.project-agent/spill/<id>` (7-day retention like OpenCode); the tool result says what's there
   and how to read it back. Nothing the model might need is ever truly lost.
5. **Model catalog** (`src/providers/catalog.ts`): vendored JSON keyed by model-id substring —
   `contextWindow`, `maxOutput`, `observedOutputCap`, `ignoresMaxTokens`, `reasoning` flag;
   resolution logs a `model_limits` event. Compaction thresholds, budget warnings, and the banner
   all read from it (fixes the vyceai 4k-cap class of failure properly).
6. **Budget-aware compaction** (`runtime/compact.ts`): trigger becomes
   `tokens > contextWindow − reserve − maxOutput` (Pi's `shouldCompact`), plus an OpenCode-style
   **tool-output pruning pass**: protect the recent window + last N tool results, replace older
   outputs with `[pruned → spill/<id>]`. Deterministic, reducer-informed — the model never chooses
   what to forget.
7. **Prompt-cache stability**: tool array order fixed (canonical sort); write-tool stripping during
   worker runs replaces with placeholders instead of removing, so the serialized prefix stays
   stable across turns.

## Batch 3 — Edit reliably at scale

*Large files = more chance `old_string` drifted; large changes = need rollback.*

8. **Fuzzy edit ladder** (Aider's, ported): exact match → whitespace-normalized match →
   blank-line-tolerant match → failure with **nearest-match line numbers** ("closest at L142, Δ8
   chars") so the model can correct in one retry. `replaceAll` semantics per OpenCode.
9. **Post-edit syntax check**: `node --check` for JS/CLS files, `JSON.parse` for `.json`,
   balanced-delimiter heuristic (warning-grade) for TS/TSX/HTML — appended to the edit result
   ("edit applied; syntax OK" / "syntax suspect: unclosed brace near L88"). Aider's lint_edited /
   OpenCode's LSP-diagnostics feedback, zero-dep edition.
10. **Git-backed /undo**: at run start under a git repo, snapshot via index-tree
    (`git add -A` into a temp index + `git write-tree`) — no commits, no history pollution;
    `/undo` restores with `read-tree` + `checkout-index`. Composes with the existing journal
    (journal stays for non-git dirs).

## Batch 4 — Delegate and steer (long tasks)

*Building a large project = many steps; the user must be able to redirect mid-flight, and the
manager must not burn its own context on exploration.*

11. **Explore worker role**: read-only role (search/read/list/external tools, no write), its own
    isolated context, returns cited summaries (`path:line` lists) — the OpenCode Task/explore
    pattern, implemented on our existing orchestrator so worker budgets/cancellation still apply.
12. **Parallel read-only tool execution**: consecutive read-only calls in one assistant turn run
    via `Promise.all` (Pi's `executionMode` split); mutations stay strictly sequential.
13. **Mid-turn steering**: the loop polls a session steering queue at every tool-call boundary
    (Pi's `getSteeringMessages`); queued corrections join the context at the boundary instead of
    after run end. Ctrl+C semantics unchanged.
14. **Retry v2**: honor `retry-after`/`retry-after-ms`, ×2 backoff with ±25% jitter, 5 attempts,
    visible "retrying in Xs (rate limit)" line (OpenCode's taxonomy, our error classes).

## Batch 5 — Long-project polish

15. **Conventions injection**: `AGENTS.md`/`TELOS.md` from root + parents into the system prompt
    (OpenCode's instruction discovery).
16. **Plan tool** (`set_plan`/`update_plan`): writes `plan_updated` events; the plan is rendered
    in turn summaries and reviewed by the gate audit — the todo-write pattern, gate-visible so a
    30-file build keeps its plot (runtime stores it; the model can't silently drift).
17. **Few-shot tool example** in the system prompt: one worked read → edit → test → report cycle,
    plus the chunked-write rule we already shipped.
18. **Markdown rest-render**: raw streaming preserved; at turn end, code fences get minimal
    syntax-agnostic highlighting (zero-dep).
19. **Per-worker budgets**: each delegation carries its own tool-call/token sub-budget (reported
    in the delegation event), so a 12-worker build can't starve the manager's budget.
20. **`<think>` tag parsing** for gateways that inline reasoning into `content`.

---

## What we are explicitly NOT doing (scope discipline)

- No bundled binaries or postinstall downloads (OpenCode downloads rg; we spawn-or-fallback).
- No LLM-written summaries in compaction (Codebuff's mechanical compaction is the proof it's
  unnecessary; our event-log digest is already mechanical).
- No subagent spawn DSL / publisher registry (Codebuff's trust problem is a cautionary tale).
- No TUI framework rewrite — the terminal-native printer stays.

## Order of attack

Batches are independent enough to ship separately, but 1 → 2 is the critical path for *large
repos*, and 2 → 3 for *large projects*. Batch 2's catalog (item 5) unblocks 2.6, 5.19, and the
banner work, so it lands early inside Batch 2. Each batch: implementation → unit tests →
large-repo harness additions → full suite → live harness on vyceai → commit/push (zainaqdas) →
version bump for npm release at milestones (not per batch).

## Shipped-variance notes (implementation vs. plan)

- **Item 2 (search):** spawned-rg with pure-Node fallback shipped as `src/tools/search-engine.ts`;
  result caps now scale with the engine (Batch 1).
- **Item 4 (spill):** shipped as `spillToolOutput` in the manager loop writing
  `.project-agent/spill/`; transcripts keep a bounded 8k-char head plus a read-back path (Batch 2).
- **Item 6 (compaction trigger):** shipped as model-catalog-driven `compactionThreshold` + the
  existing reducer-informed `compactMessages`; per-output pruning is covered by the spill path
  (Batch 2).
- **Item 7 (prompt-cache stability):** tool order is canonical via the registry's stable-order
  disabled-notice work; write-tool stripping keeps placeholders via refcounted `setDisabled`
  (Batch 2).
- **Item 10 (git /undo):** snapshot ref is `refs/telos/snapshot`, taken on the FIRST write via the
  journal hook (not run start); post-snapshot files are computed from a throwaway index BEFORE
  `read-tree` because untracked files are invisible to `git diff` (Batch 3).
- **Item 13 (steering):** drain polls AFTER tool results are on the transcript (assistant→tool
  adjacency for strict OpenAI-compatible gateways), not before (Batch 4).
- **Item 19 (per-worker budgets):** sub-budget is a fixed bounded share
  (`WORKER_SUB_BUDGET`, 30 tool calls / 120k tokens) reported in the delegation event; exhaustion
  degrades the worker gracefully instead of hard-stopping the run — the shared budget remains the
  hard stop (Batch 5).
