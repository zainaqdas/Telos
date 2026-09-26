# Telos Skills — Format Guide

A skill is **operational infrastructure**, not documentation the model may or may not remember. When a skill activates, three things happen mechanically:

1. Its **checklist** items are registered as Completion Gate requirements — the task cannot be ruled `COMPLETE` until they are satisfied by real evidence.
2. Its **constraints** are enforced by the runtime *before* tool execution — a `blocking` constraint refuses the tool call outright.
3. The Manager is informed via a runtime notice — it cannot skip, invent, or satisfy requirements by persuasion.

Skill files are TOML. No build step, no plugin system.

---

## Locations and precedence

| Source | Location | Precedence |
|---|---|---|
| Built-in | compiled into the binary | lowest |
| Global | `~/.telos/skills/*.toml` | middle |
| Project | `<repo>/.project-agent/skills/*.toml` | highest |

A skill with the same `name` in a higher-precedence source fully replaces lower ones. Check with `/skills` in a session — each entry is tagged with its `[source]`.

A malformed file **never blocks the session**: it prints a warning to stderr and is skipped.

---

## File format

```toml
[[skill]]                       # opens one skill (array-of-tables)
name = "test-first-bugfix"      # required, unique; explicit mention in a
                                # user instruction activates decisively
description = "…"               # required, one line
auto_invoke = true              # default true; false = never auto-activated
priority = "high"               # low | normal | high (default normal)

triggers     = ["failing test", "regression", "bug"]   # phrase match on the
frameworks   = ["React"]                               # instruction
file_patterns = ["*.test.ts", "*_test.go"]             # repo/file evidence
commands     = ["npm test", "node --test"]             # command evidence

[[skill.checklist]]             # becomes a Completion Gate requirement
requirement_id = "tffb-reproduce"   # required, stable, unique
description    = "Reproduce the failure and capture the actual error"
required       = true               # default true

[[skill.constraints]]           # runtime enforcement, BEFORE the tool runs
id                  = "tffb-no-blind-edit"
description         = "Do not edit source files before the failure has been reproduced"
before_tool         = "edit_file"          # tool this guard applies to
requires_requirement = "tffb-reproduce"    # must exist in THIS skill's checklist
severity            = "blocking"           # advisory | required | blocking
```

Parser notes: strings are double-quoted; arrays are inline (`["a", "b"]`); `#` starts a comment; booleans are lowercase. `[[skill.checklist]]` and `[[skill.constraints]]` attach to the most recent `[[skill]]` in the file. A file may contain multiple `[[skill]]` blocks.

---

## Routing: deterministic-first

Each user instruction is scored against every `auto_invoke` skill. Tiers, in order:

| Tier | Evidence | Points |
|---|---|---|
| 1 | skill `name` appears in the instruction | +10 (decisive) |
| 2 | a `triggers` phrase appears | +3 each |
| 3 | `file_patterns` match repo files / instruction | +2 |
| 4 | `frameworks` match the repository profile | +2 |
| 5 | `commands` match repo scripts / instruction | +1 |

Skills scoring **≥ 2** activate, best-first, capped at 3 per instruction. No LLM classifier runs on this path; one is reserved for genuine ambiguity and currently unused.

## The naming convention that drives discharge

Requirement satisfaction is deterministic — evidence comes from executed tools, never from model prose. The suffix convention is load-bearing:

| Checklist id suffix | Satisfied automatically by |
|---|---|
| `-reproduce` | a **failing** verification run (tests/build/lint) — a red run *is* the reproduction |
| `-fix` | a successful workspace edit (`edit_file` / `write_file`) |
| `-verify` | a **passing** verification run |

Name your checklist ids accordingly (`login-reproduce`, `login-verify`, …). Requirements can also be satisfied or invalidated by user corrections and other runtime evidence; a correction invalidates pending and satisfied requirements, which may re-open a skill's checklist.

## Constraint severities

| Severity | Effect when the guarded tool is called before `requires_requirement` is satisfied |
|---|---|
| `blocking` | **Tool call refused.** The model receives `REFUSED BY SKILL CONSTRAINT — …` and must change course. |
| `required` | Tool runs, but the result is prefixed with a visible warning. |
| `advisory` | Tool runs; an informational note is included. |

---

## Worked examples

### 1. Minimal skill — checklist only

`.project-agent/skills/docs-update.toml`

```toml
[[skill]]
name = "docs-update"
description = "Update README/docs whenever public behavior changes"
triggers = ["update the docs", "readme", "documentation"]

[[skill.checklist]]
requirement_id = "docs-consistent"
description = "Documentation reflects the changed behavior"
```

Routing: the instruction "update the readme to match the new API" hits trigger `"readme"` (+3) → activates. The gate will hold the task `INCOMPLETE` until `docs-consistent` is satisfied or explicitly waived.

### 2. Guarded fix workflow (same shape as the built-in)

```toml
[[skill]]
name = "safe-hotfix"
description = "Production hotfixes reproduce first and verify after"
triggers = ["hotfix", "production bug", "urgent fix"]
priority = "high"
commands = ["npm test"]

[[skill.checklist]]
requirement_id = "hotfix-reproduce"
description = "Reproduce the production failure locally"
required = true

[[skill.checklist]]
requirement_id = "hotfix-fix"
description = "Apply the minimal fix"
required = true

[[skill.checklist]]
requirement_id = "hotfix-verify"
description = "Run the full suite and confirm it is green"
required = true

[[skill.constraints]]
id = "hotfix-no-blind-edit"
description = "Do not touch source before the failure has been reproduced"
before_tool = "edit_file"
requires_requirement = "hotfix-reproduce"
severity = "blocking"
```

With this active, an instruction like *"skip the tests and just change X"* gets the edit **refused** until a failing run exists. This exact scenario was verified live: a model instructed to edit-first had its `edit_file` refused three times across sessions until it produced a red test run.

### 3. Framework + file-pattern skill

```toml
[[skill]]
name = "react-debugging"
description = "Diagnose React rendering and state issues systematically"
triggers = ["component", "renders", "state update", "useeffect"]
frameworks = ["React"]
file_patterns = ["*.tsx", "*.jsx"]
commands = ["vitest"]

[[skill.checklist]]
requirement_id = "react-reproduce"
description = "Reproduce the rendering issue"
required = true

[[skill.checklist]]
requirement_id = "react-verify"
description = "Verify the fix in the running UI or component test"
required = true
```

Activates on, e.g., "the cart component renders twice on state update" — trigger `"component"` (+3) plus framework React (+2) via the repo profile.

### 4. Shell-guarded operations

```toml
[[skill]]
name = "db-migration-safety"
description = "Inspect current migration state before changing database schema"
triggers = ["migration", "schema change", "alter table"]
frameworks = ["Prisma"]
commands = ["prisma", "knex"]

[[skill.checklist]]
requirement_id = "dbms-inspect"
description = "Inspect current migration state before applying changes"
required = true

[[skill.checklist]]
requirement_id = "dbms-verify"
description = "Verify migration applies cleanly"
required = true

[[skill.constraints]]
id = "dbms-inspect-first"
description = "Do not run migration commands before inspecting state"
before_tool = "run_shell"
requires_requirement = "dbms-inspect"
severity = "blocking"
```

Note what this does *not* do: it cannot distinguish "run migrations" from "run tests" on `run_shell`. Guards on `run_shell` are blunt — pair them with checklist ids the model can satisfy through a read-only inspection step recorded as evidence, and prefer scoping such skills tightly.

---

## Validation rules

The loader rejects (file skipped, warning printed) when:

- `name` or `description` is missing/empty
- a checklist item lacks `requirement_id` or `description`
- a constraint lacks `id`, `before_tool`, or `requires_requirement`
- a constraint's `requires_requirement` does not match **any** checklist item of the *same skill* — a guard that can never be discharged is a deadlock, so it is refused at load time

## Inspecting what the runtime did

- `/skills` — list loaded skills, source, checklist, constraints
- The event log (`.project-agent/events/<task>.jsonl`) records `skill_activated` with routing reasons, plus every `requirement_added` / `requirement_satisfied` / `requirement_invalidated`
- Gate reports list pending skill requirements by id in the summary line
