import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetEnforcer, type BudgetLimits } from "../src/runtime/usage.ts";

function limits(over: Partial<BudgetLimits> = {}): BudgetLimits {
  return {
    maxTotalTokens: 1000,
    maxToolCalls: 3,
    maxWorkerSpawns: 2,
    maxParallelWorkers: 1,
    maxWallTimeSeconds: 60,
    ...over,
  };
}
function make(l: BudgetLimits = limits(), now: () => number = () => 0): BudgetEnforcer {
  return new BudgetEnforcer(l, now);
}

test("token budget blocks when projected spend exceeds limit", () => {
  const b = make();
  assert.equal(b.check("model_call", 900).allowed, true);
  b.record("model_call", 900);
  const v = b.check("model_call", 200);
  assert.equal(v.allowed, false);
  assert.equal(v.resource, "tokens");
});

test("tool-call budget blocks the call that would exceed the limit", () => {
  const b = make();
  for (let i = 0; i < 3; i++) {
    assert.equal(b.check("tool_call").allowed, true);
    b.record("tool_call");
  }
  const v = b.check("tool_call");
  assert.equal(v.allowed, false);
  assert.equal(v.resource, "tool_calls");
  // Recording is still refused by callers; the counter does not move on a failed check.
  assert.equal(b.used.toolCalls, 3);
});

test("worker spawn and parallel limits are independent", () => {
  const b = make(limits({ maxWorkerSpawns: 2, maxParallelWorkers: 1 }));
  assert.equal(b.check("worker_spawn").allowed, true);
  b.record("worker_spawn");
  const v = b.check("worker_spawn");
  assert.equal(v.allowed, false);
  assert.equal(v.resource, "parallel_workers");
  b.workerFinished();
  assert.equal(b.check("worker_spawn").allowed, true);
  b.record("worker_spawn");
  const v2 = b.check("worker_spawn");
  assert.equal(v2.allowed, false);
  assert.equal(v2.resource, "worker_spawns");
});

test("wall-clock timeout blocks after the deadline", () => {
  const b = make(limits({ maxWallTimeSeconds: 10 }), () => 0);
  assert.equal(b.check("tool_call").allowed, true);
  const late = b.check("tool_call", 0, () => 10_001);
  assert.equal(late.allowed, false);
  assert.equal(late.resource, "wall_time");
});

test("recordUsage accumulates provider usage into token counter", () => {
  const b = make();
  b.recordUsage({ inputTokens: 100, outputTokens: 50, cachedTokens: 0, totalTokens: 150, modelCalls: 1, toolCalls: 0, costUsd: null });
  b.recordUsage({ inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, modelCalls: 1, toolCalls: 0, costUsd: null });
  assert.equal(b.used.tokens, 165);
  assert.equal(b.used.modelCalls, 2);
});
