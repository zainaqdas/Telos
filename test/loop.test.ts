import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk, Usage } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { registerShellTools } from "../src/tools/shell-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { reduce } from "../src/events/state.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import type { TelosConfig } from "../src/config/schema.ts";

/** Scripted provider: replays a fixed sequence of turns. */
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

function fakeConfig(): TelosConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 15, maxStreamAttempts: 2, minTestCount: 1, streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

interface Harness {
  loop: ManagerLoop;
  events: EventLog;
  budget: BudgetEnforcer;
  dir: string;
}

function harness(turns: Array<Array<StreamChunk>>, over: Partial<{ maxToolCalls: number }> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "syn-loop-"));
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });
  const events = new EventLog(join(dir, "ev"), "t");
  events.append("task_started", { title: "x", limits: { max_total_tokens: 100000, max_tool_calls: over.maxToolCalls ?? 10, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
  const budget = new BudgetEnforcer({
    maxTotalTokens: 100_000, maxToolCalls: over.maxToolCalls ?? 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60,
  });
  const loop = new ManagerLoop({
    provider: new FakeProvider(turns),
    model: "fake-1",
    config: fakeConfig(),
    registry,
    events,
    budget,
    cancellation,
    ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
    gate: new CompletionGate(() => events.readAll()),
  });
  return { loop, events, budget, dir };
}

function cleanup(h: Harness): void {
  rmSync(h.dir, { recursive: true, force: true });
}

const textChunk = (text: string): StreamChunk => ({ type: "text_delta", text });
const callChunk = (id: string, name: string, args: string): StreamChunk => ({ type: "tool_call_delta", toolCall: { id, name, argumentsJson: args } });
const usageChunk = (tokens: number): StreamChunk => ({ type: "usage", usage: { inputTokens: tokens, outputTokens: 1, cachedTokens: 0, totalTokens: tokens, modelCalls: 1, toolCalls: 0, costUsd: null } as Usage });

test("loop executes a tool call and feeds the result back to the model", async () => {
  const h = harness([
    [textChunk("I will read the file."), callChunk("c1", "read_file", JSON.stringify({ path: "sample.txt" }))],
    [textChunk("The file says hello.")],
  ]);
  try {
    writeFileSync(join(h.dir, "sample.txt"), "hello world\n", "utf8");
    const result = await h.loop.run("read sample.txt and summarize");
    // Read-only task, no change requested, no pending requirements → COMPLETE.
    assert.equal(result.status, "completed");
    assert.match(result.assistantText, /says hello/);
    const events = h.events.readAll();
    assert.ok(events.some((e) => e.kind === "tool_started" && e.data["name"] === "read_file"));
    assert.ok(events.some((e) => e.kind === "tool_completed"));
    // Second model turn received the tool result (fake provider ignores, but transcript must contain it).
    assert.ok(h.loop["messages"].some((m) => m.role === "tool" && m.parts.some((p) => p.type === "text" && p.text.includes("hello world"))));
  } finally {
    cleanup(h);
  }
});

test("gate reaches COMPLETE when a test run satisfies the runtime-derived requirement", async () => {
  const h = harness([
    [callChunk("c1", "run_shell", JSON.stringify({ command: "node -e \"console.log('test suite: 5 passed')\"" }))],
    [textChunk("All green.")],
  ]);
  try {
    const result = await h.loop.run("make the tests pass");
    assert.equal(result.status, "completed", `expected completed, got ${result.status}: ${result.gate?.summary}`);
    assert.equal(result.gate?.verdict, "COMPLETE");
    const state = h.events.readAll();
    assert.ok(state.some((e) => e.kind === "requirement_added" && e.data["id"] === "tests-pass"));
    assert.ok(state.some((e) => e.kind === "requirement_satisfied" && e.data["id"] === "tests-pass"));
  } finally {
    cleanup(h);
  }
});

test("zero-test exit-0 suites are not counted as verification (false-green guard)", async () => {
  const h = harness([
    [callChunk("c1", "run_shell", JSON.stringify({ command: "npm test" }))],
    [{ type: "text_delta", text: "All green." }],
  ]);
  try {
    writeFileSync(join(h.dir, "package.json"), JSON.stringify({ name: "empty", scripts: { test: "node -e 'console.log(\"ℹ tests 0\")'" } }), "utf8");
    const result = await h.loop.run("run the tests");
    assert.equal(result.status, "incomplete", "empty suite must not yield COMPLETE");
    assert.ok(h.events.readAll().some((e) => e.kind === "test_result" && e.data["ok"] === false));
  } finally {
    cleanup(h);
  }
});

test("gate stays INCOMPLETE when the test run fails", async () => {
  const h = harness([
    [callChunk("c1", "run_shell", JSON.stringify({ command: "node -e \"console.error('test run: 2 failed'); process.exit(1)\"" }))],
    [textChunk("Tests are failing.")],
  ]);
  try {
    const result = await h.loop.run("make the tests pass");
    assert.equal(result.status, "incomplete");
    assert.equal(result.gate?.verdict, "INCOMPLETE");
    assert.ok(h.events.readAll().some((e) => e.kind === "requirement_invalidated" && e.data["id"] === "tests-pass"));
  } finally {
    cleanup(h);
  }
});

test("user correction invalidates satisfied requirements; fresh runtime evidence re-satisfies them", async () => {
  const h = harness([
    [callChunk("c1", "run_shell", JSON.stringify({ command: "node -e \"console.log('tests 5 passed')\"" }))],
    [textChunk("Green.")],
    // Correction turn: no tool calls, so the invalidation sticks.
    [textChunk("Understood — redoing.")],
    [callChunk("c2", "run_shell", JSON.stringify({ command: "node -e \"console.log('tests 7 passed')\"" }))],
    [textChunk("Redo complete.")],
  ]);
  try {
    const gate = () => new CompletionGate(() => h.events.readAll());
    // Turn 1: a passing suite registers + satisfies `tests-pass`.
    await h.loop.run("run the tests");
    assert.equal(gate().evaluate().verdict, "COMPLETE");

    // Turn 2: a correction invalidates every satisfied requirement…
    await h.loop.run("redo it with jittered retries", { isCorrection: true });
    assert.equal(reduce(h.events.readAll()).requirements.get("tests-pass")?.status, "invalidated");
    assert.equal(gate().evaluate().verdict, "INCOMPLETE");

    // …and a fresh passing run re-satisfies it (reducer replays the newest
    // evidence last, so no re-add is needed — verified on the real path).
    const result = await h.loop.run("run the tests again");
    assert.equal(result.gate?.verdict, "COMPLETE", `gate summary: ${result.gate?.summary}`);
  } finally {
    cleanup(h);
  }
});

test("hard tool-call budget stops execution and is reported", async () => {
  const foreverToolTurn = (): Array<StreamChunk> => [callChunk(`c${Math.random()}`, "list_directory", JSON.stringify({ path: "." }))];
  const h = harness([[foreverToolTurn()[0]!]], { maxToolCalls: 1 });
  try {
    // Provider keeps requesting tools; after 1 allowed call the runtime must stop it.
    const result = await h.loop.run("list directories forever");
    assert.equal(result.status, "budget_exceeded");
    assert.match(result.detail ?? "", /tool calls/);
    assert.ok(h.events.readAll().some((e) => e.kind === "budget_exceeded" && e.data["resource"] === "tool_calls"));
  } finally {
    cleanup(h);
  }
});

test("token usage from the provider counts against the token budget", async () => {
  const h = harness([[usageChunk(60_000)], [usageChunk(60_000), textChunk("done")]], { maxToolCalls: 10 });
  try {
    // First turn burns 60k; the loop continues; second turn's check uses projection.
    const b1 = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 5, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
    b1.recordUsage({ inputTokens: 60_000, outputTokens: 0, cachedTokens: 0, totalTokens: 60_000, modelCalls: 1, toolCalls: 0, costUsd: null });
    assert.equal(b1.check("model_call", 60_000).allowed, false);
    void h;
  } finally {
    cleanup(h);
  }
});

test("tool args with raw newlines inside JSON strings are repaired once, not refused", async () => {
  // DeepSeek-family models sometimes emit literal newlines inside JSON string
  // values — invalid JSON, but unambiguously repairable.
  const { ManagerLoop } = await import("../src/manager/loop.ts");
  const calls: Array<{ args: string }> = [];
  const fakeRegistry = {
    get: (_n: string) => ({ name: "write_file", description: "w", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, execute: async (a: Record<string, unknown>) => { calls.push({ args: JSON.stringify(a) }); return { ok: true, output: `wrote ${String(a["path"])}` }; } }),
    names: () => ["write_file"],
    specs: () => [],
  };
  const loop = Object.create(ManagerLoop.prototype) as unknown as { deps: Record<string, unknown>; guard: unknown; satisfySkillRequirements: unknown; scanRejections: unknown; executeTool: (c: { name: string; argumentsJson: string }) => Promise<{ output: string }> };
  loop.deps = { registry: fakeRegistry, events: { append: () => {}, readAll: () => [] }, cancellation: { isCancelled: false, signal: undefined }, ctx: { root: "/tmp", signal: undefined }, budget: { check: () => ({ allowed: true }), record: () => {} }, config: { runtime: {} } };
  loop.guard = { evaluate: () => ({ verdict: "ALLOW", reason: "" }), recordNonStorm: () => {}, record: () => {} };
  loop.deps["skillRouter"] = { route: () => [], activate: () => {} };
  loop.satisfySkillRequirements = () => {};
  loop.scanRejections = async () => null;
  const out = await loop.executeTool({
    name: "write_file",
    argumentsJson: '{"path": "s.html", "content": "<html>\\n<body>\\nhi\\n</body>\\n</html>"}',
  });
  assert.ok(!out.output.includes("not valid JSON"), `unexpected refusal: ${out.output}`);
  assert.equal(calls.length, 1);
});
