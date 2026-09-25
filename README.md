# Synergon

Terminal-native agentic coding CLI. A persistent Manager plans, edits, runs, and verifies work directly in your repository — with hard runtime budgets, a single evidence-based Completion Gate, and failure-aware repetition protection.

> Status: **Phases 0–2 complete** (foundation + runtime safety, single-agent runtime, context engine). Phase 3 (Skill Engine) next. See [`docs/PHASES.md`](docs/PHASES.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Why

Synergon is built on one principle: **the runtime enforces invariants; the model only provides judgment.** The model cannot exceed your budget, cannot talk its way past the Completion Gate, and cannot silently repeat a failing command. Convincing reasoning is never confused with verified work.

## Quick start

Requires Node.js 22+.

```bash
# in your project root
npx synergon init          # writes .project-agent/config.toml
export OPENAI_API_KEY=…    # BYOK: your key, your environment
export SYNERGON_MODEL=gpt-5-mini
npx synergon chat
```

Works with any OpenAI-compatible endpoint (`SYNERGON_BASE_URL`), including OpenRouter, Ollama, and vLLM.

## Architecture

```
CLI (src/index.ts)
  ↓
Session (src/session)               terminal-native UI, slash commands, Ctrl+C
  ↓
ManagerLoop (src/manager)           persistent builder: model turns + tool execution
  ├─→ ToolRegistry (src/tools)      declared permissions/risk, schema validation
  │    ├─ filesystem · shell · git  built-in tools
  │    └─ delegate                  spawns scoped, budget-gated workers
  ├─→ Orchestrator (src/workers)    explorer · researcher · reviewer · qa
  │    ├─ scoped registry views     workers are read-only; single-writer holds
  │    └─ reports → findings/objections (advisory to the Manager)
  ├─→ SkillRouter (src/skills)      deterministic routing; enforced checklists/constraints
  ├─→ FailureLearner (src/memory)   JSONL stores · lessons · rejected approaches
  ├─→ Provider (src/providers)      one OpenAI-compatible streaming path
  └─→ Guards (src/runtime)          BudgetEnforcer · RepetitionGuard · Cancellation
        ↓
CompletionGate (src/gate)           single completion authority
        ↓
EventLog (JSONL) → reducer → TeamState    (authoritative, append-only)
```

The Manager is the primary builder: it plans, edits, runs, and verifies. Workers are task-scoped, read-only specialists it can consult through the budget-enforced `delegate` tool — their findings, proposals, and blockers are advisory input, never writes. Proposals from workers are first-class: a user correction marks stale proposals `needs_rework`, blockers stay visible until a recorded decision clears them, and while workers run in parallel the Manager's write tools are stripped (single-writer discipline). Unresolved blockers and objections awaiting a decision keep the Completion Gate at BLOCKED.

## Highlights

- **Hard budgets** — tokens, tool calls, workers, wall clock. Enforced before every spend; never silently exceeded.
- **One Completion Gate** — tests, builds, and requirement evidence feed a single authority. `COMPLETE` requires verified work, not confident prose.
- **Repetition Guard** — state-fingerprinted retries. The same command failing the same way twice is blocked, not retried.
- **Real cancellation** — Ctrl+C kills the whole process tree; no orphaned servers.
- **Event-sourced history** — every task appends an auditable JSONL event log under `.project-agent/events/`.
- **Focused context** — repo profile (languages, frameworks, commands, instructions) discovered incrementally, never dumped wholesale.

## Slash commands

`/help` `/status` `/profile` `/diff` `/collab` `/cancel` `/correct` `/model` `/exit`

## Configuration

`.project-agent/config.toml` (human-editable; env vars override):

```toml
[model]
provider = "openai"            # openai | openai-compatible | openrouter | ollama
name = ""                      # or SYNERGON_MODEL
api_key_env = "OPENAI_API_KEY" # BYOK: env var holding your key

[runtime]
autonomy = "balanced"
max_total_tokens = 80000
max_tool_calls = 40
max_wall_time_seconds = 900

[security]
confirm_destructive = true

# [[tools.external]]
# name = "deploy_preview"        # exposed as a first-class tool to the Manager
# command = "bin/deploy-preview" # single invocation; args appended as quoted literals
# [[tools.external.params]]
# key = "env"
# type = "string"
# required = true
```

API keys are read from the environment only — never written to prompts, logs, event history, or Git.

## Development

```bash
npm install
npm test        # node:test suite, includes process-tree and end-to-end tests
npm run typecheck
```

Zero runtime dependencies; TypeScript runs natively via Node type-stripping.

## License

MIT
