/**
 * Scenario eval harness (Parts 72–79). Unlike unit tests, each scenario runs
 * the REAL ManagerLoop, real tools, real event log, and real Repetition Guard
 * against a fully scripted provider — the assertions judge emitted events and
 * gate verdicts, i.e. actual runtime behavior, not internals.
 *
 * Usage: node --experimental-strip-types evals/scenarios/scenario.ts
 * Exit 0 = all scenarios pass; failures print the offending event stream.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { CompletionGate } from "../../src/gate/gate.ts";
import { ManagerLoop } from "../../src/manager/loop.ts";
import type { TelosConfig } from "../../src/config/schema.ts";

interface Turn {
  chunks: Array<StreamChunk>;
  /** Executed after the model turn: mutate the workspace between turns. */
  after?: () => void;
}

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private turn = 0;
  private readonly turns: Turn[];
  constructor(turns: Turn[]) {
    this.turns = turns;
  }
  capabilities() {
    return { supportsTools: true, supportsVision: false, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 100_000 };
  }
  async *stream(_req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    const turn = this.turns[Math.min(this.turn, this.turns.length - 1)]!;
    this.turn += 1;
    for (const c of turn.chunks) yield c;
    turn.after?.();
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
      autonomy: "balanced", maxTotalTokens: 200_000, maxToolCalls: 12, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 10, maxStreamAttempts: 2, minTestCount: 1,
      streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

interface Rig {
  loop: ManagerLoop;
  events: EventLog;
  budget: BudgetEnforcer;
  gate: CompletionGate;
  dir: string;
}

function rig(turns: Turn[], overrides: Partial<{ maxToolCalls: number }> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "syn-ev-"));
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });
  const events = new EventLog(join(dir, "ev"), "t");
  const budget = new BudgetEnforcer({
    maxTotalTokens: 200_000, maxToolCalls: overrides.maxToolCalls ?? 12, maxWorkerSpawns: 0,
    maxParallelWorkers: 0, maxWallTimeSeconds: 60,
  });
  events.append("task_started", { title: "scenario", limits: { max_total_tokens: 200_000, max_tool_calls: overrides.maxToolCalls ?? 12, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
  const loop = new ManagerLoop({
    provider: new ScriptedProvider(turns),
    model: "scripted-1",
    config: config(),
    registry,
    events,
    budget,
    cancellation,
    ctx: makeContext(dir, { shellTimeoutSeconds: 10 }),
    gate: new CompletionGate(() => events.readAll()),
  });
  return { loop, events, budget, gate: new CompletionGate(() => events.readAll()), dir };
}

function finish(rig: Rig): void {
  rmSync(rig.dir, { recursive: true, force: true });
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function scenario(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message });
    console.log(`  FAIL  ${name}\n        ${(err as Error).message.split("\n")[0]}`);
  }
}

// ─── Part 76: repetition — same command, same failure, same environment ──────

await scenario("P76 repetition: identical failing call blocked after 2 attempts; changed state re-allows", async () => {  const r = rig([
    { chunks: [call("c1", "run_shell", { command: "node build.js" })] },
    { chunks: [say("first failure noted")] },
    { chunks: [call("c2", "run_shell", { command: "node build.js" })] },
    { chunks: [say("second failure noted")] },
    { chunks: [call("c3", "run_shell", { command: "node build.js" })] },
    { chunks: [say("guard refused the third identical attempt")] },
    { chunks: [call("c4", "run_shell", { command: "node build.js --verbose" })] },
    { chunks: [say("changed-argument retry allowed")] },
  ]);
  try {
    writeFileSync(join(r.dir, "build.js"), "console.log('failing build'); process.exit(3);\n", "utf8");

    await r.loop.run("make the build pass");
    await r.loop.run("try again");
    const third = await r.loop.run("try again");
    assert.equal(third.status, "incomplete", "run ends at prose; gate stays INCOMPLETE (invalidated build-pass)");
    assert.ok(third.assistantText.includes("guard refused"), "the model's final prose is the refusal turn");

    let events = r.events.readAll();
    const failures = events.filter((e) => e.kind === "tool_failed" && e.data["name"] === "run_shell");
    assert.ok(failures.length >= 2, `two real failures expected, got ${failures.length}`);
    const executed = events.filter((e) => e.kind === "tool_started" && e.data["name"] === "run_shell").length;
    assert.equal(executed, 2, "exactly 2 identical attempts executed, third refused pre-execution");
    assert.ok(events.some((e) => e.kind === "tool_failed" && e.data["category"] === "REPEATED_FAILURE"), "guard block recorded");

    // Meaningful change: the arguments change → key changes → retry valid again.
    await r.loop.run("retry with verbose output now");
    events = r.events.readAll();
    const startedAfter = events.filter((e) => e.kind === "tool_started" && (e.data["args_summary"] as string ?? "").includes("--verbose")).length;
    assert.equal(startedAfter, 1, "changed-argument call executed exactly once (not refused)");
    assert.ok(!events.some((e) => e.kind === "tool_failed" && (e.data["message"] as string ?? "").includes("--verbose")), "changed call never refused");
  } finally {
    finish(r);
  }
});

// ─── Part 77: completion gate ────────────────────────────────────────────────

await scenario("P77 gate: passing verified run → COMPLETE; failed tests → INCOMPLETE; unverified write → INCOMPLETE", async () => {
  const r = rig([
    // Turn 1: write + failing test run → INCOMPLETE.
    { chunks: [call("w1", "write_file", { path: "calc.js", content: "module.exports = () => 41;" }), call("t1", "run_shell", { command: "node -e \"const c=require('./calc.js'); if(c()!==42) { console.error('test failed: expected 42'); process.exit(1) }\"" })] },
    { chunks: [say("test failed")] },
    // Turn 2: fix + passing run (≥1 test) → COMPLETE.
    { chunks: [call("w2", "edit_file", { path: "calc.js", old_string: "() => 41", new_string: "() => 42" }), call("t2", "run_shell", { command: "node -e \"const c=require('./calc.js'); if(c()!==42) process.exit(1); console.log('tests 1 passed')\"" })] },
    { chunks: [say("fixed and verified")] },
  ]);
  try {
    const first = await r.loop.run("make calc return 42");
    assert.equal(first.status, "incomplete", `got ${first.status}: ${first.gate?.summary}`);
    assert.equal(first.gate?.verdict, "INCOMPLETE");
    assert.ok(first.gate!.summary.includes("tests-pass"), "tests-pass named as unsatisfied/invalidated");

    const second = await r.loop.run("fix it and verify");
    assert.equal(second.status, "completed", `got ${second.status}: ${second.gate?.summary}`);
    assert.equal(second.gate?.verdict, "COMPLETE");

    // Turn 3: a write with NO verification afterwards → INCOMPLETE again.
    const third = await r.loop.run("also update the comment", { isCorrection: true });
    assert.equal(third.status, "incomplete");
    assert.match(third.gate!.summary, /nothing was run to verify|tests-pass/);
  } finally {
    finish(r);
  }
});

// ─── Part 78: budgets ────────────────────────────────────────────────────────

await scenario("P78 budget: tool-call budget stops execution, records budget_exceeded, no hidden extra call", async () => {
  // Provider keeps demanding tool calls; budget allows exactly 2.
  const forever = (): Turn => ({ chunks: [call(`c${Math.random()}`, "list_directory", { path: "." })] });
  const r = rig([forever(), forever(), forever(), forever(), forever(), forever()], { maxToolCalls: 2 });
  try {
    const result = await r.loop.run("list everything");
    assert.equal(result.status, "budget_exceeded", `got ${result.status}`);
    assert.match(result.detail ?? "", /tool calls/);
    const events = r.events.readAll();
    const exceeded = events.filter((e) => e.kind === "budget_exceeded");
    assert.equal(exceeded.length, 1, "recorded exactly once");
    assert.equal(exceeded[0]!.data["resource"], "tool_calls");
    const started = events.filter((e) => e.kind === "tool_started").length;
    assert.equal(started, 2, "no hidden extra tool call beyond the budget");
    // State preserved: reducer still derives a coherent task.
    const state = reduce(events);
    assert.ok(state.task.id.length > 0);
  } finally {
    finish(r);
  }
});

await scenario("P78 budget: token budget stops mid-run via provider-reported usage", async () => {
  const usage = (tokens: number): StreamChunk => ({ type: "usage", usage: { inputTokens: tokens, outputTokens: 0, cachedTokens: 0, totalTokens: tokens, modelCalls: 1, toolCalls: 0, costUsd: null } });
  const r = rig(
    [
      { chunks: [usage(70_000), call("c1", "list_directory", { path: "." })] },
      { chunks: [usage(70_000), say("continuing")] },
      { chunks: [usage(70_000), say("should never get here")] },
    ],
    { maxToolCalls: 12 },
  );
  // Tight token budget: 100k.
  const dir = mkdtempSync(join(tmpdir(), "syn-ev-tok-"));
  try {
    const events = new EventLog(join(dir, "ev"), "t");
    const budget = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 12, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
    events.append("task_started", { title: "tok", limits: { max_total_tokens: 100_000, max_tool_calls: 12, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
    const loop = new ManagerLoop({
      provider: new ScriptedProvider([
        { chunks: [usage(70_000), call("c1", "list_directory", { path: "." })] },
        { chunks: [usage(70_000), say("second turn")] },
      ]),
      model: "scripted-1",
      config: config(),
      registry: (() => {
        const reg = new ToolRegistry();
        registerFilesystemTools(reg);
        return reg;
      })(),
      events,
      budget,
      cancellation: new CancellationController(),
      ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
      gate: new CompletionGate(() => events.readAll()),
    });
    const result = await loop.run("burn tokens");
    assert.equal(result.status, "budget_exceeded", `got ${result.status}: ${result.detail}`);
    assert.match(result.detail ?? "", /token budget/);
    assert.ok(events.readAll().some((e) => e.kind === "budget_exceeded" && e.data["resource"] === "tokens"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Part 79: cancellation (in-loop, via the controller the loop honors) ─────

await scenario("P79 cancellation: cancelled run stops, records task state, control returns", async () => {
  // The provider signals cancellation during its first stream; the loop must
  // return "cancelled" and not record task_completed.
  const cancellation = new CancellationController();
  const dir = mkdtempSync(join(tmpdir(), "syn-ev-cx-"));
  try {
    const events = new EventLog(join(dir, "ev"), "t");
    const budget = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
    events.append("task_started", { title: "cx", limits: { max_total_tokens: 100_000, max_tool_calls: 10, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
    const provider: Provider = {
      name: "cx",
      capabilities: () => ({ supportsTools: true, supportsVision: false, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 10_000 }),
      async *stream(req) {
        req.signal?.addEventListener("abort", () => {}, { once: true });
        yield say("starting work...");
        // The stream itself honors the signal like a real provider: abort
        // surfaces as AbortError from the iteration.
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 100);
          req.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
          cancellation.cancel("scenario");
        });
        yield say("never reached");
      },
    };
    const loop = new ManagerLoop({
      provider,
      model: "scripted-1",
      config: config(),
      registry: (() => {
        const reg = new ToolRegistry();
        registerFilesystemTools(reg);
        return reg;
      })(),
      events,
      budget,
      cancellation,
      ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
      gate: new CompletionGate(() => events.readAll()),
    });
    const result = await loop.run("do a long task");
    assert.equal(result.status, "cancelled", `got ${result.status}`);
    const all = events.readAll();
    assert.ok(!all.some((e) => e.kind === "task_completed"), "no completion recorded after cancellation");
    // The transcript keeps whatever was already streamed: state preserved.
    assert.match(result.assistantText, /starting work/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Part 74: user correction propagation (reducer-derived assertions) ───────

await scenario("P74 correction: correction event, requirement invalidation, stale evidence rejected", async () => {
  const r = rig([
    { chunks: [call("w1", "write_file", { path: "style.css", content: "body { background: tan; }" }), call("t1", "run_shell", { command: "node -e \"console.log('tests 1 passed')\"" })] },
    { chunks: [say("styled and verified")] },
    { chunks: [say("correction noted — no stale work continues")] },
  ]);
  try {
    const first = await r.loop.run("style the page with css and verify");
    assert.equal(first.status, "completed");
    const corrected = await r.loop.run("Do NOT use inline styles. Rewrite with a stylesheet.", { isCorrection: true });
    assert.equal(corrected.status, "incomplete", "post-correction gate must not claim completion");

    const events = r.events.readAll();
    assert.ok(events.some((e) => e.kind === "user_correction" && (e.data["text"] as string).includes("stylesheet")), "correction recorded");
    const state = reduce(events);
    assert.equal(state.instructions.at(-1)?.isCorrection, true);
    const testsPass = state.requirements.get("tests-pass");
    assert.ok(testsPass, "tests-pass requirement exists");
    assert.equal(testsPass!.status, "invalidated", "satisfied requirement invalidated by correction");
    for (const e of testsPass!.evidence) assert.equal(e.valid, false, "stale evidence marked invalid");
    assert.equal(reduce(events).task.status, "active", "task still open — no silent stale completion");
  } finally {
    finish(r);
  }
});

// ─── Report ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
console.log(`\nscenarios: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("failed:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
process.exit(0);
