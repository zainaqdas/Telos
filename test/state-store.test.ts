import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/events/log.ts";
import { reduce } from "../src/events/state.ts";
import { StateStore } from "../src/events/state-store.ts";
import { CompletionGate } from "../src/gate/gate.ts";

/** Drive a realistic event mix through a log (same shape as bench A). */
function drive(log: EventLog, n: number): void {
  for (let i = 0; i < n; i++) {
    switch (i % 10) {
      case 0: log.append("user_instruction", { text: `instruction ${i}` }); break;
      case 1: log.append("tool_started", { name: "read_file" }); break;
      case 2: log.append("tool_completed", { name: "read_file", ok: true }); break;
      case 3: log.append("requirement_added", { id: `r-${i}`, description: "req", required: true }); break;
      case 4: log.append("requirement_satisfied", { id: `r-${i}`, source: "tool:run_shell", producer: "runtime", observation: "ok" }); break;
      case 5: log.append("blocker", { id: `b-${i}`, reason: "cannot proceed" }); break;
      case 6: log.append("blocker_resolved", { id: `b-${i - 1}` }); break; // resolve the one opened at i-1
      case 7: log.append("test_result", { ok: true, summary: "pass" }); break;
      case 8: log.append("finding", { text: `f-${i}`, source: "worker" }); break;
      case 9: log.append("tool_started", { name: "run_shell" }); break;
    }
  }
}

test("state store: incremental fold equals full reduce after every append", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-store1-"));
  try {
    const log = new EventLog(join(dir, "events"), "t1");
    const store = new StateStore(log);
    for (let i = 0; i < 40; i++) {
      drive(log, 1);
      const incremental = store.current();
      const full = reduce(log.readAll());
      // Deep-equal on every derived collection the consumers act on.
      assert.deepEqual([...incremental.requirements.entries()], [...full.requirements.entries()]);
      assert.deepEqual(incremental.blockers, full.blockers);
      assert.deepEqual(incremental.findings, full.findings);
      assert.deepEqual(incremental.instructions, full.instructions);
      assert.equal(incremental.budget.toolCallsUsed, full.budget.toolCallsUsed);
      assert.equal(incremental.budget.workersSpawned, full.budget.workersSpawned);
      assert.equal(incremental.taskStatus, full.taskStatus);
    }
    assert.equal(store.events().length, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state store: /new rebind re-derives from the fresh log and stops folding the old one", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-store2-"));
  try {
    const logA = new EventLog(join(dir, "events"), "t-a");
    const store = new StateStore(logA);
    drive(logA, 10);
    const logB = new EventLog(join(dir, "events"), "t-b");
    store.attach(logB);
    assert.equal(store.current().instructions.length, 0, "fresh task state is empty");
    logA.append("user_instruction", { text: "stale task write" }); // old log must not leak in
    assert.equal(store.current().instructions.length, 0);
    logB.append("user_instruction", { text: "fresh instruction" });
    assert.equal(store.current().instructions.length, 1);
    assert.equal(store.current().instructions[0]!.text, "fresh instruction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state store: rebuild re-derives identically; dispose stops updates", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-store3-"));
  try {
    const log = new EventLog(join(dir, "events"), "t3");
    const store = new StateStore(log);
    drive(log, 20);
    store.rebuild();
    const rebuilt = reduce(log.readAll());
    assert.deepEqual([...store.current().requirements.entries()], [...rebuilt.requirements.entries()]);
    assert.equal(store.events().length, 20);

    store.dispose();
    log.append("user_instruction", { text: "after dispose" });
    assert.equal(store.current().instructions.length, 2, "disposed store no longer folds");
    // Rebuilding still recovers the truth from the log (log is the authority).
    store.rebuild();
    assert.equal(store.current().instructions.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state store: a throwing listener never fails the append", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-store4-"));
  try {
    const log = new EventLog(join(dir, "events"), "t4");
    let calls = 0;
    log.onAppend(() => {
      calls++;
      throw new Error("broken listener");
    });
    const store = new StateStore(log); // subscribed second; still folds
    log.append("user_instruction", { text: "survives" });
    assert.equal(calls, 1, "listener ran");
    assert.equal(store.current().instructions.length, 1, "store unaffected by the broken listener");
    assert.equal(log.readAll().length, 1, "durable write unaffected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate over StateStore: identical verdicts to the function source, without re-reading", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-store5-"));
  try {
    const log = new EventLog(join(dir, "events"), "t5");
    const store = new StateStore(log);
    const gateStore = new CompletionGate(store);
    const gateFn = new CompletionGate(() => log.readAll());

    drive(log, 12);
    const a = gateStore.evaluate();
    const b = gateFn.evaluate();
    assert.equal(a.verdict, b.verdict);
    assert.deepEqual(a.satisfied, b.satisfied);
    assert.deepEqual(a.unsatisfied, b.unsatisfied);
    assert.equal(a.summary, b.summary);

    // An unverified write + a change-requesting instruction → INCOMPLETE in both.
    log.append("tool_started", { name: "write_file" });
    log.append("tool_completed", { name: "write_file", ok: true });
    assert.equal(gateStore.evaluate().verdict, "INCOMPLETE");
    assert.equal(gateFn.evaluate().verdict, "INCOMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
