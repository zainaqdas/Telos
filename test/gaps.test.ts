import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk, Usage } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { reduce } from "../src/events/state.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import { Orchestrator } from "../src/workers/orchestrator.ts";
import type { TelosConfig } from "../src/config/schema.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Provider that streams `delays` ms before its (single) text chunk. */
function scriptedProvider(text: string, delayMs = 0): Provider {
  const capabilities = (): import("../src/providers/types.ts").Capabilities => ({ supportsVision: "unsupported", supportsTools: "supported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100000 });
  return {
    name: "mock",
    capabilities,
    async *stream(_req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      yield { type: "text_delta", text };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 3, cachedTokens: 0, totalTokens: 8, modelCalls: 1, toolCalls: 0, costUsd: null } as Usage };
      yield { type: "finish", stopReason: "stop" };
    },
  };
}

function baseConfig(): TelosConfig {
  return {
    model: { provider: "openai-compatible", name: "test-model", baseUrl: "", apiKeyEnv: "X" },
    runtime: {
      autonomy: "autonomous",
      maxTotalTokens: 100000,
      maxToolCalls: 50,
      maxWorkerSpawns: 4,
      maxParallelWorkers: 2,
      maxWallTimeSeconds: 600,
      shellTimeoutSeconds: 10,
      maxStreamAttempts: 2,
    },
    security: { confirmDestructive: false },
  } as unknown as TelosConfig;
}

// ─── Gap 4: turn_summary + tool_call_id ──────────────────────────────────────

test("loop emits a turn_summary with Part 66 fields after every manager run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-gap1-"));
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
    const log = new EventLog(join(dir, "events"), "t-ts");
    log.append("task_started", { title: "x", limits: { max_total_tokens: 100000, max_tool_calls: 50, max_worker_spawns: 2, max_parallel_workers: 1, max_wall_time_seconds: 600 } });
    const provider = scriptedProvider("done");
    const loop = new ManagerLoop({
      provider,
      model: "test-model",
      config: baseConfig(),
      registry: new ToolRegistry(),
      events: log,
      budget: new BudgetEnforcer({ maxTotalTokens: 100000, maxToolCalls: 50, maxWorkerSpawns: 2, maxParallelWorkers: 1, maxWallTimeSeconds: 600 }),
      cancellation: new CancellationController(),
      ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
    });
    await loop.run("read a.txt");
    const summary = log.readAll().find((e) => e.kind === "turn_summary");
    assert.ok(summary, "turn_summary event recorded");
    const d = summary!.data;
    assert.equal(d["provider"], "mock");
    assert.equal(d["model"], "test-model");
    assert.equal(d["status"], "completed"); // no gate wired → prose-completion path
    assert.equal(d["total_tokens"], 8);
    assert.equal(d["model_calls"], 1);
    assert.equal(d["gate_verdict"], null);
    assert.equal(typeof d["wall_ms"], "number");
    assert.equal(d["cost_usd"], null, "cost stays null when nothing is declared (Part 24)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool events carry the model's tool_call_id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-gap2-"));
  try {
    writeFileSync(join(dir, "a.txt"), "hello\n", "utf8");
    const log = new EventLog(join(dir, "events"), "t-tid");
    log.append("task_started", { title: "x", limits: { max_total_tokens: 100000, max_tool_calls: 50, max_worker_spawns: 2, max_parallel_workers: 1, max_wall_time_seconds: 600 } });
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const provider: Provider = {
      name: "mock",
      capabilities: () => ({ supportsVision: "unsupported", supportsTools: "supported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100000 }),
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: "tool_call_delta", toolCall: { id: "call_abc123", name: "read_file", argumentsJson: "{\"path\":\"a.txt\"}" } };
        yield { type: "finish", stopReason: "tool_calls" };
      },
    };
    const loop = new ManagerLoop({
      provider,
      model: "m",
      config: baseConfig(),
      registry,
      events: log,
      budget: new BudgetEnforcer({ maxTotalTokens: 100000, maxToolCalls: 50, maxWorkerSpawns: 2, maxParallelWorkers: 1, maxWallTimeSeconds: 600 }),
      cancellation: new CancellationController(),
      ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
    });
    await loop.run("read a.txt");
    const started = log.readAll().find((e) => e.kind === "tool_started");
    assert.ok(started, "tool_started recorded");
    assert.equal(started!.data["tool_call_id"], "call_abc123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Gap 3: selective stop-workers ────────────────────────────────────────────

test("stopWorker cancels one worker's controller without touching session cancellation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-gap3-"));
  try {
    const log = new EventLog(join(dir, "events"), "t-stop");
    log.append("task_started", { title: "x", limits: { max_total_tokens: 100000, max_tool_calls: 50, max_worker_spawns: 4, max_parallel_workers: 2, max_wall_time_seconds: 600 } });
    const sessionCancellation = new CancellationController();
    // A provider that stalls long enough for the test to stop the worker.
    let probes = 0;
    const provider: Provider = {
      name: "mock",
      capabilities: () => ({ supportsVision: "unsupported", supportsTools: "supported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100000 }),
      async *stream(_req: GenerateRequest): AsyncIterable<StreamChunk> {
        // Respect abort like a real stream would.
        for (let i = 0; i < 100; i++) {
          if (_req.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          await new Promise((r) => setTimeout(r, 20));
          probes++;
        }
        yield { type: "text_delta", text: "never" };
      },
    };
    const orchestrator = new Orchestrator({
      provider,
      model: "m",
      config: baseConfig(),
      registry: new ToolRegistry(),
      events: log,
      budget: new BudgetEnforcer({ maxTotalTokens: 100000, maxToolCalls: 50, maxWorkerSpawns: 4, maxParallelWorkers: 2, maxWallTimeSeconds: 600 }),
      cancellation: sessionCancellation,
      ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
    });
    const delegation = orchestrator.runDelegation({ role: "explorer", question: "look around" });
    await new Promise((r) => setTimeout(r, 150)); // let the cycle start
    assert.ok(probes > 0, "worker stream is running");

    const active = orchestrator.activeWorkerIds();
    assert.equal(active.length, 1);
    const stop = orchestrator.stopWorker(active[0]!);
    assert.equal(stop.ok, true, stop.message);
    const result = await delegation;
    assert.match(result.error ?? "", /stopped/);

    assert.equal(sessionCancellation.isCancelled, false, "session controller untouched by worker stop");
    const stopped = log.readAll().find((e) => e.kind === "worker_completed" && e.data["stopped"] === true);
    assert.ok(stopped, "worker_completed(stopped) recorded");
    const state = reduce(log.readAll());
    assert.equal(state.workers.get(active[0]!)?.status, "stopped", "reducer records stopped status");
    assert.equal(orchestrator.stopWorker(active[0]!).ok, false, "double-stop refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session-level cancel still reaches running workers (one-way propagation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-gap4-"));
  try {
    const log = new EventLog(join(dir, "events"), "t-prop");
    log.append("task_started", { title: "x", limits: { max_total_tokens: 100000, max_tool_calls: 50, max_worker_spawns: 4, max_parallel_workers: 2, max_wall_time_seconds: 600 } });
    const sessionCancellation = new CancellationController();
    let sawAbort = false;
    const provider: Provider = {
      name: "mock",
      capabilities: () => ({ supportsVision: "unsupported", supportsTools: "supported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100000 }),
      async *stream(req: GenerateRequest): AsyncIterable<StreamChunk> {
        for (let i = 0; i < 100; i++) {
          if (req.signal?.aborted) { sawAbort = true; throw Object.assign(new Error("aborted"), { name: "AbortError" }); }
          await new Promise((r) => setTimeout(r, 20));
        }
        yield { type: "text_delta", text: "never" };
      },
    };
    const orchestrator = new Orchestrator({
      provider,
      model: "m",
      config: baseConfig(),
      registry: new ToolRegistry(),
      events: log,
      budget: new BudgetEnforcer({ maxTotalTokens: 100000, maxToolCalls: 50, maxWorkerSpawns: 4, maxParallelWorkers: 2, maxWallTimeSeconds: 600 }),
      cancellation: sessionCancellation,
      ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
    });
    const delegation = orchestrator.runDelegation({ role: "explorer", question: "q" });
    await new Promise((r) => setTimeout(r, 100));
    sessionCancellation.cancel("user pressed ctrl+c");
    await delegation;
    assert.ok(sawAbort, "worker stream observed the session-level abort");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Gap 2: /model switching plumbing ────────────────────────────────────────

test("setModel switches the manager's model for subsequent calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-gap5-"));
  try {
    const log = new EventLog(join(dir, "events"), "t-model");
    log.append("task_started", { title: "x", limits: { max_total_tokens: 100000, max_tool_calls: 50, max_worker_spawns: 2, max_parallel_workers: 1, max_wall_time_seconds: 600 } });
    const seenModels: string[] = [];
    const provider: Provider = {
      name: "mock",
      capabilities: () => ({ supportsVision: "unsupported", supportsTools: "supported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100000 }),
      async *stream(_req: GenerateRequest, model: string): AsyncIterable<StreamChunk> {
        seenModels.push(model);
        yield { type: "text_delta", text: "ok" };
        yield { type: "finish", stopReason: "stop" };
      },
    };
    const loop = new ManagerLoop({
      provider,
      model: "model-a",
      config: baseConfig(),
      registry: new ToolRegistry(),
      events: log,
      budget: new BudgetEnforcer({ maxTotalTokens: 100000, maxToolCalls: 50, maxWorkerSpawns: 2, maxParallelWorkers: 1, maxWallTimeSeconds: 600 }),
      cancellation: new CancellationController(),
      ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
    });
    await loop.run("first");
    loop.setModel("model-b");
    await loop.run("second");
    assert.deepEqual(seenModels, ["model-a", "model-b"]);
    // The turn_summary reflects the model that actually served each turn.
    const summaries = log.readAll().filter((e) => e.kind === "turn_summary");
    assert.deepEqual(summaries.map((s) => s.data["model"]), ["model-a", "model-b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
