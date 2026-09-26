/**
 * Part 96 benchmark — "Measure before optimizing."
 *
 * Runs the runtime's per-turn hot paths against synthetic-but-realistic load
 * and prints per-operation costs. This is the artifact that decides what gets
 * optimized; run `npm run bench` before and after any optimization change.
 *
 * Scenarios:
 *   1. gate re-reduction — the loop calls gate.evaluate() after every tool
 *      result; each call currently re-reads and re-reduces the whole log.
 *      We simulate a task with APPENDS events and EVALS gate evaluations.
 *   2. memory retrieval — MemoryStore.query per instruction.
 *   3. skill routing — SkillRouter.route per instruction.
 *   4. transcript token accounting — roughTokens over the message history.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { EventLog } from "../src/events/log.ts";
import { reduce } from "../src/events/state.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { StateStore } from "../src/events/state-store.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { SkillRouter } from "../src/skills/router.ts";
import type { SkillDefinition } from "../src/skills/schema.ts";
import { transcriptTokens } from "../src/runtime/compact.ts";

function time(label: string, iterations: number, fn: () => void): void {
  // warmup
  for (let i = 0; i < Math.min(5, iterations); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(52)} ${ms.toFixed(1).padStart(9)} ms total · ${(ms / iterations).toFixed(3).padStart(8)} ms/op · ${iterations} ops`);
}

// ── Scenario 1: the gate's re-reduction pattern ──────────────────────────────
const APPENDS = 2000; // events in the task log (long session)
const EVALS = 400; // gate.evaluate() calls (one per tool result, roughly)

const dir = mkdtempSync(join(tmpdir(), "syn-bench-"));
const log = new EventLog(join(dir, "events"), "bench-task");
log.append("task_started", { title: "bench", limits: { max_total_tokens: 400000, max_tool_calls: 90, max_worker_spawns: 2, max_parallel_workers: 1, max_wall_time_seconds: 600 } });
for (let i = 0; i < APPENDS; i++) {
  switch (i % 10) {
    case 0: log.append("user_instruction", { text: `instruction ${i} — fix the widget and verify it` }); break;
    case 1: log.append("tool_started", { name: "read_file" }); break;
    case 2: log.append("tool_completed", { name: "read_file", ok: true }); break;
    case 3: log.append("tool_started", { name: "edit_file" }); break;
    case 4: log.append("tool_completed", { name: "edit_file", ok: true }); break;
    case 5: log.append("requirement_added", { id: `r-${i}`, description: "requirement", required: true }); break;
    case 6: log.append("requirement_satisfied", { id: `r-${i}`, source: "tool:run_shell", producer: "runtime", observation: "ok" }); break;
    case 7: log.append("test_result", { ok: true, summary: "tests pass" }); break;
    case 8: log.append("finding", { text: `finding ${i}`, source: "worker" }); break;
    case 9: log.append("tool_started", { name: "run_shell" }); break;
  }
}

console.log(`── gate re-reduction (log: ${APPENDS} events, ${EVALS} gate evals) ──`);
time("A1 readAll+reduce (single cold call)", 50, () => void reduce(log.readAll()));
time("A2 gate.evaluate() with re-read (legacy source)", EVALS, () => new CompletionGate(() => log.readAll()).evaluate());
const store = new StateStore(log);
time("A3 gate.evaluate() over StateStore (incremental)", EVALS, () => new CompletionGate(store).evaluate());

// ── Scenario 2: memory retrieval ──────────────────────────────────────────────
console.log("── memory retrieval (store: 500 records) ──");
const memDir = mkdtempSync(join(tmpdir(), "syn-bench-mem-"));
const mem = new MemoryStore(memDir);
const TOPICS = ["react component render bug", "database migration lock timeout", "test flake retry semantics", "docker build cache invalidation", "auth token refresh race"];
for (let i = 0; i < 500; i++) {
  mem.add({
    type: (["lesson", "fact", "decision", "rejected_approach", "user_rule"] as const)[i % 5]!,
    key: `${TOPICS[i % 5]!.split(" ")[i % 3]}-${i}`,
    statement: `${TOPICS[i % 5]!} — record ${i} with specific detail variant ${i % 17}`,
    reason: i % 3 === 0 ? "observed in a previous task" : undefined,
    source: "user_or_evidence",
    verified: true,
  });
}
time("B1 MemoryStore.query per instruction", 2000, () => mem.query(TOPICS[2000 % 5]!));

// ── Scenario 3: skill routing ─────────────────────────────────────────────────
console.log("── skill routing (5 skills, per instruction) ──");
const skills: SkillDefinition[] = ["tdd", "migration", "perf", "security", "release"].map((name) => ({
  name,
  description: `${name} skill`,
  source: "builtin",
  autoInvoke: true,
  triggers: [name, `run ${name}`, `${name} checklist`],
  filePatterns: [`**/*.${name}.ts`],
  frameworks: [],
  commands: [`${name}-cmd`],
  constraints: [],
  checklist: [{ requirementId: `${name}-verify`, description: "verify", required: true }],
})) as unknown as SkillDefinition[];
const router = new SkillRouter({ skills, events: log });
time("C1 SkillRouter.route per instruction", 2000, () => void router.route("fix the widget using tdd and run the release checklist"));

// ── Scenario 4: transcript token accounting ───────────────────────────────────
console.log("── transcript accounting (100-message history) ──");
const messages: Array<{ role: string; parts: Array<{ type: string; text?: string; mediaType?: string; data?: string }> }> = [];
for (let i = 0; i < 100; i++) {
  messages.push({ role: i % 3 === 0 ? "assistant" : "user", parts: [{ type: "text", text: `message ${i}: `.padEnd(400, "x") }] });
}
time("D1 transcriptTokens over 100 messages", 2000, () => transcriptTokens(messages as never));

rmSync(dir, { recursive: true, force: true });
rmSync(memDir, { recursive: true, force: true });
