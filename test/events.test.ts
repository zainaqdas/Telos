import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events/log.ts";
import { reduce } from "../src/events/state.ts";

function withLog(fn: (log: EventLog, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "syn-events-"));
  try {
    fn(new EventLog(dir, "t1"), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("event log appends JSONL with monotonic seq", () => {
  withLog((log, dir) => {
    const e1 = log.append("task_started", { title: "x" });
    const e2 = log.append("user_instruction", { text: "do the thing" });
    assert.equal(e2.seq, e1.seq + 1);
    const raw = readFileSync(join(dir, "t1.jsonl"), "utf8").trim().split("\n");
    assert.equal(raw.length, 2);
    assert.deepEqual(Object.keys(JSON.parse(raw[0]!)).sort(), ["data", "kind", "seq", "t", "taskId"]);
  });
});

test("reducer derives state: requirements lifecycle and evidence", () => {
  withLog((log) => {
    log.append("task_started", { title: "fix bug", limits: { max_total_tokens: 1000, max_tool_calls: 10, max_worker_spawns: 1, max_parallel_workers: 1, max_wall_time_seconds: 60 } });
    log.append("requirement_added", { id: "tests-pass", description: "npm test passes", required: true });
    log.append("requirement_satisfied", { id: "tests-pass", source: "tool:run_shell", producer: "manager", observation: "exit 0, 5 passed", fingerprint: "abc" });
    const state = reduce(log.readAll());
    const req = state.requirements.get("tests-pass");
    assert.equal(req?.status, "satisfied");
    assert.equal(req?.evidence.length, 1);
    assert.equal(req?.evidence[0]?.valid, true);
    assert.equal(state.budget.limits.maxToolCalls, 10);
  });
});

test("user correction invalidates pending requirements and is recorded as high priority", () => {
  withLog((log) => {
    log.append("task_started", { title: "x" });
    log.append("requirement_added", { id: "tailwind", description: "use tailwind", required: true });
    log.append("requirement_satisfied", { id: "tailwind", source: "manager", producer: "manager", observation: "added classes" });
    log.append("user_correction", { text: "do not use tailwind, use plain css" });
    const state = reduce(log.readAll());
    assert.equal(state.instructions.at(-1)?.isCorrection, true);
    assert.equal(state.requirements.get("tailwind")?.status, "invalidated");
    assert.equal(state.requirements.get("tailwind")?.evidence[0]?.valid, false);
  });
});

test("budget_exceeded flips task status with the resource as end reason", () => {
  withLog((log) => {
    log.append("task_started", { title: "x" });
    log.append("budget_exceeded", { resource: "tool_calls", message: "40/40" });
    const state = reduce(log.readAll());
    assert.equal(state.taskStatus, "budget_exceeded");
    assert.equal(state.endReason, "tool_calls");
  });
});

test("tool_started increments the budget snapshot; worker events track roster", () => {
  withLog((log) => {
    log.append("task_started", { title: "x" });
    log.append("tool_started", { name: "run_shell" });
    log.append("tool_started", { name: "read_file" });
    log.append("worker_started", { id: "w1", role: "explorer" });
    log.append("worker_completed", { id: "w1", ok: true });
    const state = reduce(log.readAll());
    assert.equal(state.budget.toolCallsUsed, 2);
    assert.equal(state.workers.get("w1")?.status, "completed");
    assert.equal(state.budget.workersSpawned, 1);
  });
});
