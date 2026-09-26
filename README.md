# Telos

**Terminal-native agentic coding CLI.** A persistent Manager plans, edits, runs, and verifies code directly in your repository — while the runtime enforces the rules that matter: hard budgets, evidence-based completion, and protection against blind retry loops.

Telos runs on Node.js with **zero runtime dependencies**. Your API keys stay in your environment. Every task leaves an auditable event log.

---

## Installation

```bash
npm install -g @zainaqdas/telos
```

Requires Node.js **22.18+** (24 LTS recommended). Check with `node -v`.

No-install alternatives:

```bash
npx @zainaqdas/telos          # run without installing
curl -fsSL https://raw.githubusercontent.com/zainaqdas/Telos/main/install.sh | bash
                              # source install: clones to ~/.telos, builds, links `telos`
```

Update with `npm update -g @zainaqdas/telos` (or re-run the curl line). Uninstall a source install with `bash ~/.telos/install.sh --uninstall`.

## Quick start

```bash
cd your-project
telos
```

The first run scaffolds `.project-agent/config.toml` and tells you what to fill in:

1. **Set a model** — either in `config.toml` under `[model] name`, or via the environment: `export TELOS_MODEL=gpt-5-mini`
2. **Provide your API key** — Telos reads it from the environment variable named by `api_key_env` (default `OPENAI_API_KEY`). Keys are never written to prompts, logs, event history, or Git.
3. **Run `telos` again** — the session starts:

```
Telos — openai/gpt-5-mini  [OPENAI_API_KEY: present]
task t-2026-09-26T12-00-00-000Z-ab1c
budgets: 80000 tokens · 40 tool calls · 900s wall
Ctrl+C cancels the running task · Ctrl+C again exits · /help for commands

> Fix the failing test in auth and verify the suite passes.
```

Describe the work in plain language. Telos investigates, edits, runs commands, tests, and reports — and the Completion Gate decides when the task is actually done.

### CLI

```
telos [command] [options]

Commands:
  chat       Start an interactive session (default)
  init       Write .project-agent/config.toml and exit
  status     Show configuration and environment readiness
  version    Print version

Options:
  --model <name>         Model override (env: TELOS_MODEL)
  --provider <name>      Provider override (env: TELOS_PROVIDER)
  --base-url <url>       API base URL override (env: TELOS_BASE_URL)
  --max-tokens <n>       Token budget override (env: TELOS_MAX_TOKENS)
  --max-tool-calls <n>   Tool-call budget override (env: TELOS_MAX_TOOL_CALLS)
```

### Providers

Any OpenAI-compatible endpoint works out of the box: OpenAI, OpenRouter, Ollama, vLLM, LM Studio, or a self-hosted gateway via `base_url`. A native Anthropic Messages API provider is included. Set `provider`, `name`, `base_url`, and `api_key_env` in `[model]` — or the `TELOS_*` environment equivalents.

---

## What makes Telos different

Telos is built on one principle: **the runtime enforces invariants; the model only provides judgment.** LLMs are capable and unreliable in equal measure, so every guarantee Telos makes is implemented in code, never in a prompt:

- **Hard budgets.** Tokens, tool calls, worker spawns, parallelism, and wall clock are checked *before* every spend. A task that hits its budget stops — it is never silently exceeded, and provider usage that arrives after the fact is re-checked immediately.
- **One Completion Gate.** The model cannot declare success. The Gate — a single completion authority — derives its verdict from runtime evidence: passing test runs, successful builds, requirement records, skill checklists. Confident prose is never confused with verified work. Unverified edits keep the verdict INCOMPLETE; unresolved blockers keep it BLOCKED.
- **Repetition Guard.** Every tool call is fingerprinted by command, arguments, and workspace state. The same call failing the same way twice is refused, not retried a third time — and when the state genuinely changes, the retry is allowed again.
- **Real cancellation.** Ctrl+C terminates the task, every spawned child process, and their process trees. No orphaned servers, no half-detached builds. Pressing it again exits the session.
- **Failure learning.** Tool failures are classified, deduplicated, and persisted as lessons. Recurring failures get promoted to verified lessons that are retrieved in future sessions. Approaches the user rejects are remembered as first-class rejected approaches.
- **Event-sourced everything.** Every instruction, decision, delegation, tool call, test result, and gate verdict is appended to a per-task JSONL log under `.project-agent/events/`. The current state of the team is always a pure reduction of that log — inspectable, replayable, and authoritative.
- **Zero runtime dependencies.** The whole CLI runs on Node built-ins. Nothing in your `node_modules`, nothing downloaded at runtime, nothing that can be supply-chain attacked through the tool itself.

---

## How it works

```
CLI (src/index.ts)
  ↓
Session (src/session)               terminal UI, slash commands, keybindings, shutdown
  ↓
ManagerLoop (src/manager)           persistent builder: model turns + tool execution
  ├─→ ToolRegistry (src/tools)      schema-validated tools with permissions and risk
  │    ├─ filesystem · shell · git  built-ins
  │    ├─ web · browser             web_search, read_url, CDP-driven browser tools
  │    ├─ external tools            user-declared shell commands as first-class tools
  │    └─ mcp_* tools               Model Context Protocol servers
  ├─→ Orchestrator (src/workers)    explorer · researcher · reviewer · qa workers
  ├─→ SkillRouter (src/skills)      deterministic routing, gate-bound checklists
  ├─→ MemoryStore (src/memory)      lessons · rejected approaches · user rules
  ├─→ Provider (src/providers)      OpenAI-compatible + native Anthropic, streaming
  └─→ Runtime guards                BudgetEnforcer · RepetitionGuard · Cancellation
        ↓
CompletionGate (src/gate)           the single completion authority
        ↓
EventLog (JSONL) → reducer → TeamState    append-only, authoritative
```

### The Manager is the primary builder

The Manager does the work itself: reading files, editing code, running tests. When broader investigation helps, it can delegate to **task-scoped, read-only specialists** through a budget-enforced `delegate` tool:

| Role | Mission | Tools |
|---|---|---|
| `explorer` | Map repository structure, ownership, and change risk | read-only + git |
| `researcher` | Answer questions about dependencies, APIs, docs | read-only |
| `reviewer` | Adversarially review changes; raise objections | read-only + git |
| `qa` | Reproduce defects, run tests and builds | read-only + shell |

Workers cannot write to your workspace. While workers run in parallel, the Manager's own write tools are stripped (single-writer discipline). Workers report structured findings, proposals, objections, and blockers; blockers stay visible until the Manager records an explicit decision, and unresolved blockers or objections awaiting a decision hold the Gate at BLOCKED. A worker that needs something (an edit not yet applied, missing credentials) answers `WAITING:` and is resumed later with `continue_worker` — or stopped selectively with `/stop`.

### Skills are operational infrastructure

Skills live in TOML (built-ins, `~/.telos/skills/`, or `.project-agent/skills/` — project overrides global). A skill has three enforcement surfaces, all applied by the runtime:

- **Routing** — deterministic tiers (explicit name > trigger phrases > repo evidence), no LLM classifier on the happy path. Example built-ins: `test-first-bugfix` (reproduce → fix → verify, with a blocking no-blind-edit constraint) and `db-migration-safety`.
- **Checklists** — activation registers checklist items as gate requirements. If the skill says "browser verification required" and no browser ran, the Gate refuses completion — no matter what the model says.
- **Constraints** — a blocking constraint (e.g. "no `edit_file` before the failure is reproduced") refuses the tool call outright until runtime evidence discharges it.

### Memory persists across sessions

`.project-agent/memory/` holds JSONL stores — verified lessons, rejected approaches, user rules, decisions, objections — with a trust hierarchy and capped, topic-gated retrieval. Corrections like "don't use Redis here" become durable user rules automatically. Relevant memory is injected into context before work begins; nothing relevant is fetched after actions are already taken.

### Cost and observability

Declare `[model.pricing]` (USD per million tokens) and the budget bar and `/status` show a running cost estimate; a provider-reported cost is used when available, and the estimate is `null` — never invented — when neither exists. Every run appends a structured `turn_summary` (model, token granularity, tool calls, cost when known, wall time, gate verdict) and every tool call carries the provider's `tool_call_id`, making the event log fully machine-analyzable.

---

## Using Telos

### In-session commands

| | | |
|---|---|---|
| `/help` | command reference | `/status` budgets, task state, model, cost |
| `/profile` | repository profile | `/diff` working-tree diff summary |
| `/skills` | available + active skills | `/memory` durable memory contents |
| `/collab` | proposals, blockers, objections | `/image <path>` attach an image |
| `/undo` | revert the last workspace write | `/retry` re-run the previous instruction |
| `/compact` | fold transcript into an event-log digest | `/new` `/clear` fresh task |
| `/model <name>` | show or switch model | `/models` live model catalog |
| `/provider` | provider catalog + key status | `/waive <id> [for 2h]` waive a blocker |
| `/stop <id>` | stop one worker | `/stop-workers` stop all workers |
| `/correct <text>` | record a correction (highest priority) | `/cancel` cancel the running task |
| `/exit` | quit | |

Notable behaviors: `/undo` restores the exact pre-edit content (or removes files the undone edit created); `/compact` derives its digest from the event log, so corrections, blockers, and open requirements survive while chatter does not; `/new` clears transcript, journal, and gate state but durable memory persists; `/correct` supersedes earlier instructions, invalidates stale work, and re-briefs waiting workers.

### Editing a running task

- **Ctrl+C** — cancel the running task immediately (kills the process tree). Press again to exit.
- **`/correct`** — change course: higher priority than earlier instructions, invalidates stale requirements and proposals, resumes waiting workers with the new context.
- **`/stop <worker-id>`** — stop one worker's stream and shell children without touching the rest of the session.
- **`/waive b-1 for 4h`** — consciously accept a blocker for a bounded time; the Gate re-opens it when the waiver lapses.

### Autonomy modes

`runtime.autonomy` selects how much the Manager decides on its own:

| Mode | Behavior |
|---|---|
| `ask` | confirm before consequential actions |
| `balanced` | act freely within safety rules; destructive commands still gated |
| `autonomous` | full self-direction; only hard refusals (destructive/system-level) remain |

Destructive and system-level commands are refused by the runtime regardless of mode.

### Extending with tools

**External tools** — expose your own single-invocation shell commands as first-class tools:

```toml
[[tools.external]]
name = "deploy_preview"
command = "bin/deploy-preview"   # args appended as quoted literals — no injection
risk = "medium"                  # default high
worker_roles = ["qa"]            # worker roles allowed to call it
[[tools.external.params]]
key = "env"
type = "string"
required = true
```

**MCP servers** — connect any Model Context Protocol stdio server; its tools appear as `mcp_<server>_<tool>` with the same validation, budgets, and permissions as built-ins:

```toml
[[mcp.servers]]
name = "files"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
timeout_seconds = 30
worker_roles = ["explorer"]

[mcp.servers.env]
NODE_ENV = "production"
```

**Skills** — drop a TOML file in `.project-agent/skills/`:

```toml
[[skill]]
name = "release-checklist"
description = "Verify a release end-to-end before tagging."
triggers = ["release", "tag a version"]
autoInvoke = true

[[skill.checklist]]
requirement_id = "release-verify"
description = "Full test suite and build pass on the release commit."
required = true
```

---

## Configuration reference

`.project-agent/config.toml` — all values have safe defaults; environment variables (`TELOS_*`) override.

```toml
[model]
provider = "openai"            # openai | anthropic | openai-compatible | openrouter | ollama
name = ""                      # model name, e.g. "gpt-5-mini" (or TELOS_MODEL)
base_url = ""                  # optional endpoint override (or TELOS_BASE_URL)
api_key_env = "OPENAI_API_KEY" # env var holding your key (BYOK)
worker_model = ""              # optional cheaper model for worker delegations

[model.pricing]                # optional: enables cost estimates
input_per_mtok = 3
output_per_mtok = 15
cache_read_per_mtok = 0.3

[runtime]
autonomy = "balanced"          # ask | balanced | autonomous
max_total_tokens = 80000
max_tool_calls = 40
max_worker_spawns = 3
max_parallel_workers = 2
max_wall_time_seconds = 900
shell_timeout_seconds = 120
max_stream_attempts = 2
min_test_count = 1             # exit-0 suites reporting fewer tests are not verification (0 disables)
stream_timeout_seconds = 120
compaction_threshold_tokens = 60000

[security]
confirm_destructive = true
block_secrets = true
```

## Project state directory

Telos writes everything under `.project-agent/` in your project:

```
.project-agent/
├── config.toml          your configuration
├── events/              per-task JSONL event logs (the authority)
├── memory/              durable memory: facts, lessons, decisions, rejections, user rules
└── skills/              project-local skills
```

Add `.project-agent/` to `.gitignore` if you don't want task history in your repository — or commit it if you do; the logs are plain JSON Lines.

## Requirements

- **Node.js 22.18+** (24 LTS recommended)
- That's it — no runtime dependencies, no database, no daemon
- Optional: a Chromium-based browser for `browser_*` verification tools (Telos drives your installed browser over the DevTools Protocol and degrades gracefully if none exists)

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — component map and data flow
- [`docs/PHASES.md`](docs/PHASES.md) — per-phase implementation reports
- [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — spec compliance matrix
- [`docs/skills.md`](docs/skills.md), [`docs/memory.md`](docs/memory.md), [`docs/browser-design.md`](docs/browser-design.md) — subsystem deep dives

## Development

```bash
npm install
npm test                  # 157 tests: unit, process-tree, e2e
npm run typecheck
npm run eval:scenarios    # scenario evals: correction, repetition, gate, budgets, cancellation
npm run eval:acceptance   # verbatim acceptance tasks (tiny / research / complex bug / skill-blocked)
npm run bench             # hot-path benchmark (measure before optimizing)
```

## License

MIT
