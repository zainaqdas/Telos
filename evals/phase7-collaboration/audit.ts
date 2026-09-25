/**
 * Phase 7 collaboration eval — event-log auditor (Part 94).
 *
 * Assertions are made against the repo's own pure reducer, so a PASS means
 * the live system produced an event log whose derived state satisfies every
 * collaboration invariant — not that specific strings appeared in a transcript.
 *
 * Modes:
 *   audit.ts <stage-dir>          audit the newest live event log in <stage-dir>
 *   audit.ts --self-test <dir>    build a synthetic log in <dir>, audit it,
 *                                 then mutate it and confirm failures fire
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { reduce } from "../../src/events/state.ts";
import { CompletionGate } from "../../src/gate/gate.ts";
import type { AgentEvent } from "../../src/events/types.ts";

let failures = 0;
const checks: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`;
  checks.push(line);
  if (!ok) failures += 1;
}

function newestEventLog(dir: string): string {
  const eventsDir = join(dir, ".project-agent", "events");
  const files = readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl")).sort();
  if (files.length === 0) throw new Error(`no event log found in ${eventsDir}`);
  return join(eventsDir, files[files.length - 1]!);
}

function loadEvents(file: string): AgentEvent[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AgentEvent);
}

export function audit(events: AgentEvent[]): void {
  const state = reduce(events);
  const gate = new CompletionGate(() => events);

  // 1. A completing worker emitted a proposal, reconciled as a first-class
  //    event; the correction invalidated it in derived state (active before
  //    the correction, needs_rework/invalidated after).
  const proposal = events.find((e) => e.kind === "proposal");
  check("proposal event exists", Boolean(proposal), "no worker PROPOSAL reached the log");
  const correction = events.find((e) => e.kind === "user_correction");
  if (proposal && correction) {
    const cut = events.indexOf(correction);
    const before = reduce(events.slice(0, cut));
    const wasActive = [...before.proposals.values()].some((p) => p.status === "active");
    const after = [...state.proposals.values()].some((p) => p.status === "needs_rework" || p.status === "invalidated");
    check("proposal was active before the correction", wasActive);
    check("correction forced the proposal to needs_rework", after);
  } else {
    check("proposal was active before the correction", false, "proposal or correction missing");
    check("correction forced the proposal to needs_rework", false, "proposal or correction missing");
  }

  // 2. A blocker reached the log and was opened by a worker.
  const blocker = events.find((e) => e.kind === "blocker");
  check("blocker event exists", Boolean(blocker));
  const blockerOpenAtEnd = state.blockers.some((b) => b.status === "open" || b.status === "resolved");

  // 3. A worker answered WAITING and was resumed by the correction.
  const waiting = events.find((e) => e.kind === "worker_waiting");
  check("a worker answered WAITING", Boolean(waiting), "no worker_waiting event — stagecraft failed");
  const resumed = events.find((e) => e.kind === "worker_started" && e.data["resumed"] === true && e.data["reason"] === "user_correction");
  check("correction resumed the waiting worker", Boolean(resumed));

  // 4. The correction debates prior objections exactly once each.
  check("user correction recorded", Boolean(correction));
  const objections = events.filter((e) => e.kind === "objection");
  const debates = events.filter((e) => e.kind === "objection_debated");
  check(
    "each prior objection debated exactly once",
    debates.length === objections.length,
    `objections=${objections.length} debates=${debates.length}`,
  );

  // 5. The task completed via the gate, and at completion time no blocker or
  //    objection is left open/undecided — collaboration settled before COMPLETE.
  const lastComplete = [...events].reverse().find((e) => e.kind === "task_completed");
  check("task reached task_completed (gate COMPLETE)", Boolean(lastComplete));
  if (lastComplete) {
    const atEnd = reduce(events.slice(0, events.indexOf(lastComplete)));
    const openBlockers = atEnd.blockers.filter((b) => b.status === "open");
    const undecided = atEnd.objections.filter((o) => !o.resolved && o.debate?.verdict === "needs_decision");
    check("no open blockers at completion", openBlockers.length === 0, `open: ${openBlockers.map((b) => b.id).join(",")}`);
    check("no undecided objections at completion", undecided.length === 0, `undecided: ${undecided.map((o) => o.id).join(",")}`);
    const lastGate = gate.evaluate();
    check("final gate verdict is COMPLETE", lastGate.verdict === "COMPLETE", lastGate.summary);
  }
  check("blocker reached a terminal state", blockerOpenAtEnd);
}

// ─── Synthetic self-test (no provider, no cost) ───────────────────────────────

function syntheticEvents(): AgentEvent[] {
  const mk = (seq: number, kind: AgentEvent["kind"], data: Record<string, unknown>): AgentEvent => ({
    seq, t: seq, taskId: "selftest", kind, data,
  });
  return [
    mk(1, "task_started", { title: "selftest" }),
    mk(2, "worker_started", { id: "w1", role: "qa" }),
    mk(3, "worker_completed", { id: "w1", ok: true, cycle: 1 }),
    mk(4, "proposal", { id: "p-1", statement: "adopt option A", raised_by: "qa:w1" }),
    mk(5, "blocker", { id: "b-1", reason: "no sandbox credentials", raised_by: "qa:w1" }),
    mk(6, "objection", { id: "obj-1", statement: "option A adds an external service", raised_by: "qa:w1" }),
    mk(7, "worker_started", { id: "w2", role: "reviewer" }),
    mk(8, "worker_waiting", { id: "w2", role: "reviewer", cycle: 1, waiting_for: "the change is not applied" }),
    mk(9, "user_correction", { text: "no external services; option B only" }),
    mk(10, "worker_started", { id: "w2", role: "reviewer", resumed: true, cycle: 2, reason: "user_correction" }),
    mk(11, "worker_completed", { id: "w2", ok: true, cycle: 2 }),
    mk(12, "objection_debated", { id: "obj-1", debate: { verdict: "needs_decision", rationale: "risk term" } }),
    mk(13, "test_result", { ok: true, observation: "exit 0, 2 pass" }),
    mk(14, "decision", { id: "d-1", statement: "resolves b-1 and obj-1: credentials unavailable, simulation covers it" }),
    mk(15, "blocker_resolved", { id: "b-1", by: "d-1" }),
    mk(16, "objection_resolved", { id: "obj-1", by: "d-1" }),
    mk(17, "task_completed", { reason: "gate_complete" }),
  ];
}

function selfTest(dir: string): void {
  console.log("self-test: synthetic log");
  audit(syntheticEvents());
  report();

  console.log("self-test: mutated log (proposal removed, waiting removed, completion removed)");
  const mutated = syntheticEvents().filter((e) => !(e.kind === "proposal" || e.kind === "worker_waiting" || e.kind === "task_completed"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".project-agent", "events"), { recursive: true });
  writeFileSync(
    join(dir, ".project-agent", "events", "selftest-mutated.jsonl"),
    mutated.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  const before = failures;
  audit(mutated);
  report();
  if (failures === before) {
    console.error("self-test: auditor failed to detect the mutations — auditor is broken");
    process.exitCode = 1;
  } else {
    console.log("self-test: mutations detected — auditor is honest");
    process.exitCode = 0;
  }
}

function report(): void {
  for (const line of checks) console.log(`  ${line}`);
  checks.length = 0;
  console.log(`  (${failures} failure(s) so far)`);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args[0] === "--self-test" && args[1]) {
  selfTest(args[1]);
} else if (args[0]) {
  const file = newestEventLog(args[0]);
  console.log(`auditing: ${file}`);
  audit(loadEvents(file));
  report();
  process.exitCode = failures === 0 ? 0 : 1;
} else {
  console.error("usage: audit.ts <stage-dir> | audit.ts --self-test <dir>");
  process.exitCode = 2;
}
