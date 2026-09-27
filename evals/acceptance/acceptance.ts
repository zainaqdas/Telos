/**
 * Verbatim acceptance-task evals (Parts 80–83).
 *
 * The INPUTS are the spec's own words; the assertions judge runtime behavior
 * (events, worker delegations, gate verdicts) — the same doctrine as
 * evals/scenarios. Runs the real ManagerLoop, tools, event log, skill router,
 * orchestrator, and Completion Gate against a scripted provider.
 *
 * Usage: node --experimental-strip-types evals/acceptance/acceptance.ts
 * Exit 0 = all acceptance tasks pass.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk } from "../../src/providers/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { registerFilesystemTools } from "../../src/tools/fs-tools.ts";
import { registerShellTools } from "../../src/tools/shell-tools.ts";
import { makeContext } from "../../src/tools/util.ts";
import { BudgetEnforcer } from "../../src/runtime/usage.ts";
import { CancellationController } from "../../src/runtime/cancellation.ts";
import { EventLog } from "../../src/events/log.ts";
import { reduce } from "../../src/events/state.ts";
import { StateStore } from "../../src/events/state-store.ts";
import { CompletionGate } from "../../src/gate/gate.ts";
import { ManagerLoop } from "../../src/manager/loop.ts";
import { Orchestrator } from "../../src/workers/orchestrator.ts";
import { loadSkills } from "../../src/skills/loader.ts";
import { SkillRouter } from "../../src/skills/router.ts";
import type { TelosConfig } from "../../src/config/schema.ts";

interface Turn {
  chunks: Array<StreamChunk>;
}

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private turn = 0;
  private readonly turns: Turn[];
  constructor(turns: Turn[]) {
    this.turns = turns;
  }
  capabilities(): import("../../src/providers/types.ts").Capabilities {
    return { supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100_000 };
  }
  async *stream(_req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    const turn = this.turns[Math.min(this.turn, this.turns.length - 1)]!;
    this.turn += 1;
    for (const c of turn.chunks) yield c;
  }
}

const call = (id: string, name: string, args: Record<string, unknown>): StreamChunk => ({
  type: "tool_call_delta",
  toolCall: { id, name, argumentsJson: JSON.stringify(args) },
});
const say = (text: string): StreamChunk => ({ type: "text_delta", text });

function config(): TelosConfig {
  return {
    model: { provider: "openai", name: "scripted-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 200_000, maxToolCalls: 16, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 10, maxStreamAttempts: 2, minTestCount: 1,
      streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

interface Rig {
  loop: ManagerLoop;
  events: EventLog;
  dir: string;
}

interface RigOpts {
  maxWorkerSpawns?: number;
  skillToml?: string;
}

function rig(turns: Turn[], opts: RigOpts = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "telos-acc-"));
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });
  const events = new EventLog(join(dir, "ev"), "t");
  const budget = new BudgetEnforcer({
    maxTotalTokens: 200_000, maxToolCalls: 16, maxWorkerSpawns: opts.maxWorkerSpawns ?? 0,
    maxParallelWorkers: opts.maxWorkerSpawns ? 1 : 0, maxWallTimeSeconds: 60,
  });
  events.append("task_started", { title: "acceptance", limits: { max_total_tokens: 200_000, max_tool_calls: 16, max_worker_spawns: opts.maxWorkerSpawns ?? 0, max_parallel_workers: opts.maxWorkerSpawns ? 1 : 0, max_wall_time_seconds: 60 } });

  let router: SkillRouter | undefined;
  if (opts.skillToml) {
    mkdirSync(join(dir, ".project-agent", "skills"), { recursive: true });
    writeFileSync(join(dir, ".project-agent", "skills", "browser-verify.toml"), opts.skillToml, "utf8");
    router = new SkillRouter({ skills: loadSkills(dir, join(dir, "no-global")), events });
  }

  const orchestrator = new Orchestrator({
    provider: new ScriptedProvider(turns),
    model: "scripted-1",
    config: config(),
    registry,
    events,
    budget,
    cancellation,
    ctx: makeContext(dir, { shellTimeoutSeconds: 10 }),
  });
  registry.register(orchestrator.delegateTool());
  registry.register(orchestrator.continueTool());
  registry.register(orchestrator.decisionTool());

  const loop = new ManagerLoop({
    provider: (orchestrator as unknown as { deps: { provider: Provider } }).deps.provider,
    model: "scripted-1",
    config: config(),
    registry,
    events,
    budget,
    cancellation,
    ctx: makeContext(dir, { shellTimeoutSeconds: 10 }),
    gate: new CompletionGate(new StateStore(events)),
    skillRouter: router,
  });
  return { loop, events, dir };
}

function finish(rig: Rig): void {
  rmSync(rig.dir, { recursive: true, force: true });
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function acceptance(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
    console.log(`  FAIL  ${name}\n        ${(err as Error).message.split("\n")[0]}`);
  }
}

// ─── Part 80 — Tiny Task ─────────────────────────────────────────────────────
// Input (verbatim): "Rename foo to bar across the project."
// Expected: Manager → 0 workers → focused edits → appropriate validation → Gate complete.

await acceptance("P80 tiny task: 0 workers, focused edits, validation, gate COMPLETE", async () => {
  const r = rig([
    { chunks: [
      call("c1", "edit_file", { path: "lib.js", old_string: "function foo", new_string: "function bar" }),
      call("c2", "edit_file", { path: "lib.js", old_string: "module.exports = { foo }", new_string: "module.exports = { bar }" }),
    ] },
    { chunks: [call("c3", "run_shell", { command: "node lib.test.js" })] },
    { chunks: [say("Renamed foo to bar across the project; the test suite passes.")] },
  ]);
  try {
    writeFileSync(join(r.dir, "lib.js"), "function foo() { return 42; }\nmodule.exports = { foo };\n", "utf8");
    writeFileSync(join(r.dir, "lib.test.js"), "const assert = require('assert');\nconst { bar } = require('./lib.js');\nassert.equal(bar(), 42);\nconsole.log('tests 1 pass');\n", "utf8");
    const result = await r.loop.run("Rename foo to bar across the project.");
    const events = r.events.readAll();
    const state = reduce(events);
    assert.equal(state.instructions[0]?.text, "Rename foo to bar across the project.", "verbatim input");
    assert.equal(events.filter((e) => e.kind === "delegation").length, 0, "Part 80: Manager → 0 workers");
    assert.ok(events.some((e) => e.kind === "tool_completed" && e.data["name"] === "edit_file"), "focused edits happened");
    const tests = events.filter((e) => e.kind === "test_result");
    assert.equal(tests.length, 1, "exactly one validation run");
    assert.equal(tests[0]!.data["ok"], true);
    assert.equal(state.requirements.get("tests-pass")?.status, "satisfied");
    assert.equal(state.taskStatus, "completed", "task completed via the gate");
    assert.equal(result.gate?.verdict, "COMPLETE");
  } finally {
    finish(r);
  }
});

// ─── Part 81 — Research Task ─────────────────────────────────────────────────
// Input (verbatim): "Determine why library X is used and whether library Y is compatible."
// Expected: Manager → Researcher → documentation research → evidence → Manager conclusion. No source modification.

await acceptance("P81 research task: researcher delegation, evidence, manager conclusion, no writes", async () => {
  const r = rig([
    { chunks: [call("c1", "delegate", { role: "researcher", question: "Determine why library X is used and whether library Y is compatible. Inspect package.json and docs/API-NOTES.md." })] },
    { chunks: [
      call("c2", "read_file", { path: "package.json" }),
      call("c3", "read_file", { path: "docs/API-NOTES.md" }),
    ] },
    { chunks: [say("FINDING: library X (left-pad) is used because String.prototype.padStart was unavailable on the oldest supported Node runtimes.\nEVIDENCE: docs/API-NOTES.md line 3 states the rationale; package.json declares left-pad ^1.3.0.\nCONFIDENCE: high on why X is used; medium on Y compatibility — docs/API-NOTES.md line 7 claims API compatibility for our use, unverified by execution.")] },
    { chunks: [say("Conclusion: library X remains for legacy Node support; library Y is documented as API-compatible for our usage, but treat that as unverified until an execution smoke test exists.")] },
  ], { maxWorkerSpawns: 1 });
  try {
    mkdirSync(join(r.dir, "docs"), { recursive: true });
    writeFileSync(join(r.dir, "package.json"), JSON.stringify({ name: "p", dependencies: { "left-pad": "^1.3.0" } }, null, 2), "utf8");
    writeFileSync(join(r.dir, "docs", "API-NOTES.md"), "# API notes\n\n- library X (left-pad) was chosen because String.prototype.padStart was unavailable on the oldest supported Node runtimes.\n- library Y (stringz) is API-compatible for our use per its documentation.\n", "utf8");
    const result = await r.loop.run("Determine why library X is used and whether library Y is compatible.");
    const events = r.events.readAll();
    assert.equal(events.filter((e) => e.kind === "delegation" && e.data["role"] === "researcher").length, 1, "Manager → Researcher");
    const writes = events.filter((e) => e.kind === "tool_started" && (e.data["name"] === "edit_file" || e.data["name"] === "write_file"));
    assert.equal(writes.length, 0, "Part 81: no source modification unless requested");
    assert.ok(result.assistantText.length > 40, "manager produced a conclusion");
  } finally {
    finish(r);
  }
});

// ─── Part 82 — Complex Bug ───────────────────────────────────────────────────
// Input (verbatim): "Login sometimes redirects incorrectly."
// Expected: investigate → reproduce → understand → implement → review if warranted → verify → Completion Gate.

await acceptance("P82 complex bug: explorer→qa(reproduce)→implement→qa(verify)→reviewer→gate COMPLETE", async () => {
  const r = rig([
    { chunks: [call("d1", "delegate", { role: "explorer", question: "Login sometimes redirects incorrectly. Map the code path responsible." })] },
    { chunks: [say("FINDING: src/login.js owns the redirect decision and ignores the user's role.\nEVIDENCE: src/login.js line 2 returns a constant.\nRISK: changing it affects every login redirect.\nRECOMMENDATION: make the redirect role-dependent and re-run the suite.")] },
    { chunks: [call("d2", "delegate", { role: "qa", question: "Reproduce the login redirect defect: run node test/login.test.js and report the actual behavior." })] },
    { chunks: [call("c1", "run_shell", { command: "node test/login.test.js" })] },
    { chunks: [say("TESTED: node test/login.test.js against current src/login.js.\nRESULT: fail (exit 1) — redirect for a non-admin user is wrong.\nEVIDENCE: assertion failure reproduced locally.\nREMAINING_UNCERTAINTY: none for this case.")] },
    { chunks: [call("c2", "edit_file", { path: "src/login.js", old_string: "redirect: () => \"/admin\"", new_string: "redirect: (u) => (u.isAdmin ? \"/admin\" : \"/user\")" })] },
    { chunks: [call("d3", "delegate", { role: "qa", question: "Re-run node test/login.test.js against the updated src/login.js and report." })] },
    { chunks: [call("c3", "run_shell", { command: "node test/login.test.js" })] },
    { chunks: [say("TESTED: node test/login.test.js after the fix.\nRESULT: pass (exit 0), tests 1 pass.\nEVIDENCE: clean run with no assertion failures.\nREMAINING_UNCERTAINTY: other redirect call sites were not exercised.")] },
    { chunks: [call("d4", "delegate", { role: "reviewer", question: "Adversarially review the change in src/login.js." })] },
    { chunks: [say("VERDICT: approve\nFINDING: none blocking.\nEVIDENCE: src/login.js:2 now branches on isAdmin consistently with test/login.test.js.\nOBJECTION: none.")] },
    { chunks: [say("Reproduced, fixed, and verified: the redirect now depends on the user's role; the suite passes and review approved the change.")] },
  ], { maxWorkerSpawns: 4 });
  try {
    mkdirSync(join(r.dir, "src"), { recursive: true });
    mkdirSync(join(r.dir, "test"), { recursive: true });
    writeFileSync(join(r.dir, "src", "login.js"), "module.exports = { redirect: () => \"/admin\" };\n", "utf8");
    writeFileSync(join(r.dir, "test", "login.test.js"), "const assert = require('assert');\nconst { redirect } = require('../src/login.js');\nassert.equal(redirect({ isAdmin: false }), '/user');\nconsole.log('tests 1 pass');\n", "utf8");
    const result = await r.loop.run("Login sometimes redirects incorrectly.");
    const events = r.events.readAll();
    assert.equal(state0(events).instructions[0]?.text, "Login sometimes redirects incorrectly.", "verbatim input");
    const roles = events.filter((e) => e.kind === "delegation").map((e) => String(e.data["role"]));
    assert.ok(roles.includes("explorer"), "explorer investigated");
    assert.ok(roles.includes("reviewer"), "reviewer reviewed");
    assert.equal(roles.filter((x) => x === "qa").length, 2, "qa ran twice: reproduce then verify");
    const tests = events.filter((e) => e.kind === "test_result");
    assert.deepEqual(tests.map((t) => t.data["ok"]), [false, true], "reproduce (red) before verify (green)");
    assert.equal(state0(events).requirements.get("tests-pass")?.status, "satisfied");
    assert.equal(state0(events).taskStatus, "completed", "completed via the gate");
    assert.equal(result.gate?.verdict, "COMPLETE");
  } finally {
    finish(r);
  }
});

function state0(events: ReturnType<EventLog["readAll"]>) {
  return reduce(events);
}

// ─── Part 83 — Skill Acceptance Test ─────────────────────────────────────────
// Skill requirement (verbatim): "Browser verification required."
// Implementation passes tests; browser verification has not happened.
// Expected: the Manager cannot declare completion.
// Mapping note: our gate names an unmet skill checklist INCOMPLETE (BLOCKED is
// reserved for blockers/needs-decision objections); the invariant under test —
// completion refused — is identical.

await acceptance("P83 skill acceptance: tests pass but required browser verification missing → completion refused", async () => {
  const skillToml = `[[skill]]
name = "browser-verify"
description = "Login flow changes require real browser verification before completion."
triggers = ["login redirect"]
autoInvoke = true

[[skill.checklist]]
requirement_id = "browser-verification"
description = "Browser verification required for the login flow."
required = true
`;
  const r = rig([
    { chunks: [call("c1", "run_shell", { command: "node test/login.test.js" })] },
    { chunks: [say("All tests pass.")] },
  ], { skillToml });
  try {
    mkdirSync(join(r.dir, "test"), { recursive: true });
    writeFileSync(join(r.dir, "test", "login.test.js"), "const assert = require('assert');\nassert.equal(1, 1);\nconsole.log('tests 1 pass');\n", "utf8");
    const result = await r.loop.run("The login redirect flow changed — update the redirect logic and confirm tests pass.");
    const events = r.events.readAll();
    const state = reduce(events);
    assert.equal(state.skills.has("browser-verify"), true, "skill activated");
    assert.equal(state.requirements.get("browser-verification")?.status, "pending", "browser verification never satisfied");
    const browserCalls = events.filter((e) => e.kind === "tool_started" && String(e.data["name"]).startsWith("browser_"));
    assert.equal(browserCalls.length, 0, "no browser verification happened");
    assert.equal(state.requirements.get("tests-pass")?.status, "satisfied", "implementation passes tests");
    assert.notEqual(result.gate?.verdict, "COMPLETE", "Part 83: the Manager cannot declare completion");
    assert.match(result.gate?.summary ?? "", /browser-verification/, "the gate names the missing verification");
    assert.equal(events.some((e) => e.kind === "task_completed"), false, "no completion recorded");
  } finally {
    finish(r);
  }
});

// ─── Report ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\nacceptance: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("failed:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
process.exit(0);
