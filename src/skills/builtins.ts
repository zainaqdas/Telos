import type { SkillDefinition } from "./schema.ts";

/**
 * Built-in skills (Part 34). Ships with a small set of operational skills
 * demonstrating the three pieces: routing metadata, gate-bound checklists,
 * runtime-enforced constraints. Project/global skills use the same schema.
 */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: "test-first-bugfix",
    description: "Diagnose a failing test or reported bug: reproduce first, fix the cause, re-run the suite.",
    triggers: ["bug", "failing test", "broken", "regression", "fix the test", "test failure"],
    frameworks: [],
    filePatterns: ["*.test.ts", "*.test.js", "*_test.go", "*_test.py", "*.spec.ts"],
    commands: ["npm test", "node --test", "vitest", "jest", "pytest", "cargo test", "go test"],
    autoInvoke: true,
    priority: "high",
    checklist: [
      { requirementId: "tffb-reproduce", description: "Reproduce the failure and capture the actual error", required: true },
      { requirementId: "tffb-fix", description: "Implement the fix addressing the diagnosed root cause", required: true },
      { requirementId: "tffb-verify", description: "Run the test suite and confirm it passes", required: true },
    ],
    constraints: [
      {
        id: "tffb-no-blind-edit",
        description: "Do not edit source files before the failure has been reproduced",
        beforeTool: "edit_file",
        requiresRequirement: "tffb-reproduce",
        severity: "blocking",
      },
    ],
    source: "builtin",
  },
  {
    name: "db-migration-safety",
    description: "Inspect current migration state before changing database schema.",
    triggers: ["migration", "schema change", "alter table", "database schema"],
    frameworks: ["Prisma"],
    filePatterns: ["prisma/schema.prisma", "migrations/*.sql", "*_migration*"],
    commands: ["prisma", "knex", "alembic"],
    autoInvoke: true,
    priority: "normal",
    checklist: [
      { requirementId: "dbms-inspect", description: "Inspect current migration state before applying changes", required: true },
      { requirementId: "dbms-verify", description: "Verify migration applies cleanly against the current database", required: true },
    ],
    constraints: [
      {
        id: "dbms-inspect-first",
        description: "Do not run migration commands before inspecting current migration state",
        beforeTool: "run_shell",
        requiresRequirement: "dbms-inspect",
        severity: "blocking",
      },
    ],
    source: "builtin",
  },
];
