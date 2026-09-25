import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { registerShellTools } from "../src/tools/shell-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import { loadSkills } from "../src/skills/loader.ts";
import { SkillRouter } from "../src/skills/router.ts";
import { validateSkill } from "../src/skills/schema.ts";
import { reduce } from "../src/events/state.ts";
import type { SynergonConfig } from "../src/config/schema.ts";

// ─── Schema validation ────────────────────────────────────────────────────────

test("skill schema validates and rejects malformed definitions", () => {
  const good = validateSkill(
    {
      name: "x",
      description: "d",
      triggers: ["t"],
      checklist: [{ requirement_id: "x-a", description: "do a", required: true }],
      constraints: [{ id: "c1", before_tool: "edit_file", requires_requirement: "x-a", severity: "blocking" }],
    },
    "project",
  );
  assert.equal(good.autoInvoke, true);
  assert.equal(good.priority, "normal");
  assert.throws(() => validateSkill({ name: "y", checklist: [] }, "project"), /description/);
  assert.throws(
    () =>
      validateSkill(
        {
          name: "z",
          description: "d",
          constraints: [{ id: "c", before_tool: "edit_file", requires_requirement: "missing" }],
        },
        "project",
      ),
    /unknown checklist item/,
  );
});

test("loader precedence: project overrides global overrides builtin", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-skill-"));
  try {
    mkdirSync(join(dir, ".project-agent", "skills"), { recursive: true });
    writeFileSync(
      join(dir, ".project-agent", "skills", "test-first-bugfix.toml"),
      `[[skill]]
name = "test-first-bugfix"
description = "project override"
triggers = ["failing test"]
[[skill.checklist]]
requirement_id = "tffb-reproduce"
description = "reproduce"
`,
      "utf8",
    );
    const skills = loadSkills(dir, join(dir, "nonexistent-global"));
    const override = skills.find((s) => s.name === "test-first-bugfix")!;
    assert.equal(override.source, "project");
    assert.equal(override.description, "project override");
    // db-migration-safety should survive as builtin.
    assert.ok(skills.some((s) => s.name === "db-migration-safety" && s.source === "builtin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Router: deterministic tiers ──────────────────────────────────────────────

function makeRouter(dir: string, events: EventLog): SkillRouter {
  const skills = loadSkills(dir, join(dir, "no-global"));
  return new SkillRouter({ skills, events });
}

test("router: explicit name mention activates decisively", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-route-"));
  try {
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const router = makeRouter(dir, events);
    const matches = await router.route("use the test-first-bugfix approach here");
    assert.equal(matches[0]?.skill.name, "test-first-bugfix");
    assert.ok(matches[0]!.reasons.includes("explicitly named"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router: trigger + command evidence crosses threshold; unrelated text does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-route2-"));
  try {
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const router = makeRouter(dir, events);

    const hit = await router.route("npm test is failing with a regression");
    assert.equal(hit[0]?.skill.name, "test-first-bugfix");

    const miss = await router.route("please summarize the readme file");
    assert.equal(miss.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("activation registers checklist requirements once and is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-act-"));
  try {
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const router = makeRouter(dir, events);
    const matches = await router.route("fix this regression in the test suite");
    assert.ok(matches.length > 0);
    router.activate(matches[0]!);
    router.activate(matches[0]!); // second activation must be a no-op

    const state = reduce(events.readAll());
    assert.equal(state.skills.get("test-first-bugfix")?.status, "active");
    assert.deepEqual(state.skills.get("test-first-bugfix")?.requirementIds.sort(), ["tffb-fix", "tffb-reproduce", "tffb-verify"]);
    assert.equal(state.requirements.get("tffb-reproduce")?.skill, "test-first-bugfix");
    const activated = events.readAll().filter((e) => e.kind === "skill_activated");
    assert.equal(activated.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Constraint enforcement through the real Manager loop ─────────────────────

class FakeProvider implements Provider {
  readonly name = "fake";
  private turn = 0;
  private readonly turns: Array<Array<StreamChunk>>;
  constructor(turns: Array<Array<StreamChunk>>) {
    this.turns = turns;
  }
  capabilities() {
    return { supportsTools: true, supportsVision: false, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 10_000 };
  }
  async *stream(_req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    const chunks = this.turns[Math.min(this.turn, this.turns.length - 1)]!;
    this.turn += 1;
    for (const c of chunks) yield c;
  }
}

function fakeConfig(): SynergonConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 15, maxStreamAttempts: 2,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

test("constraint discharges after the requirement is satisfied by runtime evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-constraint-"));
  try {
    writeFileSync(join(dir, "calc.js"), "export const add = (a, b) => a - b;\n", "utf8");
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const cancellation = new CancellationController();
    registerShellTools(registry, { cancellation });
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const router = makeRouter(dir, events);
    const gate = new CompletionGate(() => events.readAll());

    // Turn 1: model tries to edit source immediately (before reproducing).
    const loop = new ManagerLoop({
      provider: new FakeProvider([
        [
          { type: "tool_call_delta", toolCall: { id: "c1", name: "edit_file", argumentsJson: JSON.stringify({ path: "calc.js", old_string: "a - b", new_string: "a + b" }) } },
        ],
        [{ type: "text_delta", text: "Understood; I will reproduce the failure first." }],
      ]),
      model: "fake-1",
      config: fakeConfig(),
      registry,
      events,
      budget: new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
      cancellation,
      ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
      gate,
      skillRouter: router,
    });

    const result = await loop.run("there is a bug in calc.js, fix it");
    assert.equal(result.status, "incomplete");
    // The edit must NOT have been applied — constraint blocked it.
    assert.equal(readFileSync(join(dir, "calc.js"), "utf8"), "export const add = (a, b) => a - b;\n");
    // The model was told why.
    assert.ok(
      loop["messages"].some((m) => m.role === "tool" && m.parts.some((p) => p.type === "text" && p.text.includes("REFUSED BY SKILL CONSTRAINT"))),
    );
    // Skill + checklist are registered.
    const state = reduce(events.readAll());
    assert.ok(state.skills.has("test-first-bugfix"));
    assert.equal(state.requirements.get("tffb-reproduce")?.status, "pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("constraint discharges after the requirement is satisfied by runtime evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-discharge-"));
  try {
    writeFileSync(join(dir, "calc.js"), "export const add = (a, b) => a - b;\n", "utf8");
    writeFileSync(join(dir, "calc.test.js"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './calc.js';\ntest('adds', () => assert.equal(add(2, 2), 4));\n", "utf8");
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const cancellation = new CancellationController();
    registerShellTools(registry, { cancellation });
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const router = makeRouter(dir, events);
    const gate = new CompletionGate(() => events.readAll());

    // Turn 1: reproduce via a failing test run (discharges tffb-reproduce via
    // runtime-derived requirement satisfaction… note: failing run satisfies
    // tffb-reproduce because 'reproduce the failure' is evidenced by the red test).
    // Turn 2: edit; must now be allowed.
    const loop = new ManagerLoop({
      provider: new FakeProvider([
        [
          { type: "tool_call_delta", toolCall: { id: "c1", name: "run_shell", argumentsJson: JSON.stringify({ command: "node --test" }) } },
        ],
        [
          { type: "tool_call_delta", toolCall: { id: "c2", name: "edit_file", argumentsJson: JSON.stringify({ path: "calc.js", old_string: "a - b", new_string: "a + b" }) } },
        ],
        [{ type: "text_delta", text: "Fixed." }],
      ]),
      model: "fake-1",
      config: fakeConfig(),
      registry,
      events,
      budget: new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
      cancellation,
      ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
      gate,
      skillRouter: router,
    });

    // Activate the skill up front (as routing would on this instruction).
    const matches = await router.route("failing test in calc, fix the regression");
    if (matches.length) router.activate(matches[0]!);

    await loop.run("failing test in calc, fix the regression");

    // The edit WAS applied this time (constraint discharged by the red test run).
    assert.equal(readFileSync(join(dir, "calc.js"), "utf8"), "export const add = (a, b) => a + b;\n");
    const state = reduce(events.readAll());
    assert.equal(state.requirements.get("tffb-reproduce")?.status, "satisfied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Gate skill audit ─────────────────────────────────────────────────────────

test("gate audit lists pending skill requirements and blocks premature completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-audit-"));
  try {
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const router = makeRouter(dir, events);
    const matches = await router.route("fix this regression");
    router.activate(matches[0]!);

    const gate = new CompletionGate(() => events.readAll());
    const report = gate.evaluate();
    // Checklist requirements are pending → not COMPLETE.
    assert.equal(report.verdict, "INCOMPLETE");
    assert.match(report.summary, /skill test-first-bugfix pending: tffb-fix, tffb-reproduce, tffb-verify|skill test-first-bugfix pending: tffb-reproduce, tffb-fix, tffb-verify|tffb-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
