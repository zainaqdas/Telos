import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/events/types.ts";
import { reduce } from "../src/events/state.ts";
import type { GenerateRequest, Provider, StreamChunk } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { registerShellTools } from "../src/tools/shell-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { FailureLearner } from "../src/memory/pipeline.ts";
import { Orchestrator } from "../src/workers/orchestrator.ts";
import { evaluateObjection, formatReportForManager, parseWorkerReport } from "../src/workers/roles.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import type { TelosConfig } from "../src/config/schema.ts";

/** Scripted provider: each stream call consumes the next turn and records the prompts it saw. */
class ScriptedProvider implements Provider {
  readonly name = "fake";
  readonly calls: Array<{ system: string; user: string }> = [];
  private readonly turns: Array<Array<StreamChunk>>;
  constructor(turns: Array<Array<StreamChunk>>) {
    this.turns = turns;
  }
  capabilities(): import("../src/providers/types.ts").Capabilities {
    return { supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100_000 };
  }
  async *stream(req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    void _model;
    const sys = req.messages.find((m) => m.role === "system");
    const user = [...req.messages].reverse().find((m) => m.role === "user");
    this.calls.push({
      system: sys ? sys.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : "",
      user: user ? user.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : "",
    });
    const idx = Math.min(this.calls.length - 1, this.turns.length - 1);
    for (const c of this.turns[idx] ?? []) yield c;
  }
}

function fakeConfig(): TelosConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 500_000, maxToolCalls: 40, maxWorkerSpawns: 6,
      maxParallelWorkers: 2, maxWallTimeSeconds: 120, shellTimeoutSeconds: 15, maxStreamAttempts: 2, minTestCount: 1, streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

function setup(dir: string, provider: Provider) {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });
  const events = new EventLog(join(dir, "ev"), "t");
  events.append("task_started", { title: "x" });
  const budget = new BudgetEnforcer({ maxTotalTokens: 500_000, maxToolCalls: 40, maxWorkerSpawns: 6, maxParallelWorkers: 2, maxWallTimeSeconds: 120 });
  const store = new MemoryStore(dir);
  const learner = new FailureLearner(store);
  const orchestrator = new Orchestrator({ provider, model: "fake-1", config: fakeConfig(), registry, events, budget, cancellation, ctx: makeContext(dir, { shellTimeoutSeconds: 15 }), learner });
  registry.register(orchestrator.delegateTool());
  registry.register(orchestrator.continueTool());
  registry.register(orchestrator.decisionTool());
  return { registry, events, budget, orchestrator, store };
}

function ev(seq: number, kind: AgentEvent["kind"], data: Record<string, unknown>, t = seq): AgentEvent {
  return { seq, t, taskId: "t", kind, data };
}

// ─── Parser + contract integration ───────────────────────────────────────────

test("report parser extracts PROPOSAL and BLOCKER sections and renders them back", () => {
  const text = ["VERDICT: approve", "FINDING: the fix is minimal", "PROPOSAL: extract the discount tiers into a table", "BLOCKER: staging credentials are missing", "CONFIDENCE: high"].join("\n");
  const r = parseWorkerReport(text);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0]?.statement, "extract the discount tiers into a table");
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0], "staging credentials are missing");
  const rendered = formatReportForManager("reviewer", "w1-x", r);
  assert.match(rendered, /PROPOSAL: extract the discount tiers/);
  assert.match(rendered, /BLOCKER: staging credentials are missing/);
});

test("a proposals-only reply counts as structured (no format retry)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c1-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "PROPOSAL: split the pricing module into tiers.ts" }]]);
    const { events, orchestrator } = setup(dir, provider);
    const result = await orchestrator.runDelegation({ role: "reviewer", question: "review the pricing change" });
    assert.ok(!result.error);
    assert.ok(!events.readAll().some((e) => e.kind === "failure" && e.data["source"] === "worker_contract"), "no format retry for proposals-only report");
    const state = reduce(events.readAll());
    assert.equal(state.proposals.size, 1);
    assert.ok([...state.proposals.values()].every((p) => p.status === "active"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Reconciliation: proposals + blockers as first-class events ──────────────

test("worker proposals and blockers are reconciled into events, state, and memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c2-"));
  try {
    const report = "VERDICT: request_changes\nFINDING: tiers overlap at 100\nPROPOSAL: make tier thresholds exclusive\nBLOCKER: no test runner configured in this repo";
    const provider = new ScriptedProvider([[{ type: "text_delta", text: report }]]);
    const { events, orchestrator, store } = setup(dir, provider);
    const result = await orchestrator.runDelegation({ role: "reviewer", question: "review the tier change" });
    assert.ok(!result.error);
    const all = events.readAll();
    assert.ok(all.some((e) => e.kind === "proposal" && e.data["id"] === "p-1"));
    assert.ok(all.some((e) => e.kind === "blocker" && e.data["id"] === "b-1"));
    const state = reduce(all);
    assert.equal(state.proposals.get("p-1")?.status, "active");
    assert.equal(state.proposals.get("p-1")?.raisedBy, "reviewer:" + result.workerId);
    assert.equal(state.blockers[0]?.status, "open");
    assert.ok(store.all("fact").some((f) => f.statement.includes("tier thresholds exclusive")));
    assert.ok(store.all("fact").some((f) => f.statement.includes("resolve via a recorded decision")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Reducer: correction invalidates proposals + supersedes decisions ─────────

test("user correction forces active proposals to needs_rework and supersedes decisions", () => {
  const state = reduce([
    ev(1, "proposal", { id: "p-1", statement: "use a regex", raised_by: "reviewer:w1" }),
    ev(2, "decision", { id: "d-1", statement: "ship without a migration" }),
    ev(3, "user_correction", { text: "do not use a regex; write a real parser" }),
  ]);
  assert.equal(state.proposals.get("p-1")?.status, "needs_rework");
  assert.equal(state.decisions[0]?.status, "superseded");
});

test("proposal_invalidated and blocker_resolved events update state", () => {
  const state = reduce([
    ev(1, "proposal", { id: "p-1", statement: "use a regex", raised_by: "reviewer:w1" }),
    ev(2, "blocker", { id: "b-1", reason: "no creds" }),
    ev(3, "proposal_invalidated", { id: "p-1", status: "needs_rework" }),
    ev(4, "blocker_resolved", { id: "b-1", by: "d-1" }),
  ]);
  assert.equal(state.proposals.get("p-1")?.status, "needs_rework");
  assert.equal(state.blockers[0]?.status, "resolved");
});

// ─── Decisions resolve blockers ───────────────────────────────────────────────

test("recordDecision appends a decision event and resolves exactly the named blocker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c3-"));
  try {
    const provider = new ScriptedProvider([
      [{ type: "text_delta", text: "FINDING: x\nBLOCKER: missing credentials\nBLOCKER: CI not wired" }],
    ]);
    const { events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "explorer", question: "map the release flow" });
    const resolved = orchestrator.recordDecision("resolves b-1: credentials were added to the env", "verified with a live call");
    assert.equal(resolved, 1, "b-2 stays open");
    const state = reduce(events.readAll());
    assert.equal(state.blockers.find((b) => b.id === "b-1")?.status, "resolved");
    assert.equal(state.blockers.find((b) => b.id === "b-2")?.status, "open");
    assert.ok(state.decisions.some((d) => d.statement.includes("credentials were added")));
    // Idempotent: a second decision naming b-1 resolves nothing new.
    assert.equal(orchestrator.recordDecision("resolves b-1 again"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision tool resolves blockers referenced by id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c4-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "FINDING: x\nBLOCKER: lockfile conflict" }]]);
    const { registry, events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "explorer", question: "inspect the dependency state" });
    const tool = registry.get("decision");
    assert.ok(tool, "decision tool registered");
    const res = await tool.execute({ statement: "resolves b-1 by rebasing on main", reason: "conflict was mechanical" }, makeContext(dir, { shellTimeoutSeconds: 15 }));
    assert.ok(res.ok);
    assert.match(res.output, /1 blocker\(s\) marked resolved/);
    assert.equal(reduce(events.readAll()).blockers[0]?.status, "resolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Objection debate ─────────────────────────────────────────────────────────

test("objection debate: upheld when the correction addresses the subject", () => {
  const d = evaluateObjection("the proposed caching layer breaks session invalidation", "keep the caching layer but fix session invalidation first");
  assert.equal(d.verdict, "upheld");
});

test("objection debate: risk objections need a decision, not silent compliance", () => {
  const d = evaluateObjection("this rewrite risks data loss during migration", "use plain functions instead of classes");
  assert.equal(d.verdict, "needs_decision");
  assert.match(d.rationale, /surface|decision|risk/i);
});

test("objection debate: preference-only objections are dismissed by a correction", () => {
  const d = evaluateObjection("I would prefer the factory pattern here", "stop using classes; keep it simple");
  assert.equal(d.verdict, "dismissed");
});

test("correction propagation runs the debate once per prior objection and records the verdict", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c5-"));
  try {
    const provider = new ScriptedProvider([
      [{ type: "text_delta", text: "FINDING: x\nOBJECTION: the shortcut risks data loss on migration" }],
    ]);
    const { events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "reviewer", question: "review the shortcut" });
    await orchestrator.propagateCorrection("stop touching the migration");
    const notices = events.readAll().filter((e) => e.kind === "task_updated" && String(e.data["notice"] ?? "").includes("OBJECTION DEBATE"));
    assert.equal(notices.length, 1);
    assert.match(String(notices[0]?.data["notice"]), /needs_decision/);
    // The verdict is a first-class event attached to the objection's id.
    const debated = events.readAll().filter((e) => e.kind === "objection_debated");
    assert.equal(debated.length, 1);
    assert.equal(debated[0]?.data["id"], "obj-1");
    assert.equal((debated[0]?.data["debate"] as { verdict: string }).verdict, "needs_decision");
    // Second propagation: the same objection is not re-debated.
    await orchestrator.propagateCorrection("correction number two");
    assert.equal(events.readAll().filter((e) => e.kind === "objection_debated").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Correction propagation into waiting workers ──────────────────────────────

test("correction propagates to waiting workers and re-briefs them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c6-"));
  try {
    writeFileSync(join(dir, "feature.ts"), "export const feature = () => 1;\n", "utf8");
    const provider = new ScriptedProvider([
      [{ type: "text_delta", text: "WAITING: the fix is not applied yet" }],
      [{ type: "text_delta", text: "VERDICT: approve\nFINDING: the applied fix is correct\nPROPOSAL: none" }],
    ]);
    const { events, orchestrator } = setup(dir, provider);
    const first = await orchestrator.runDelegation({ role: "reviewer", question: "review the feature fix" });
    assert.match(first.error ?? "", /WORKER WAITING/);
    assert.ok(orchestrator.waitingWorkerIds().includes(first.workerId));

    const resumed = await orchestrator.propagateCorrection("the fix is applied to feature.ts now");
    assert.deepEqual(resumed, [first.workerId]);
    assert.ok(!orchestrator.waitingWorkerIds().includes(first.workerId), "no longer waiting after resume");

    // The worker was re-briefed with the correction, marked as a correction resume.
    const resumeCall = provider.calls[1];
    assert.match(resumeCall?.user ?? "", /USER CORRECTION/);
    assert.match(resumeCall?.system ?? "", /OUTPUT CONTRACT/);
    assert.ok(events.readAll().some((e) => e.kind === "worker_started" && e.data["resumed"] === true && e.data["reason"] === "user_correction"));
    // The resumed cycle completed and reconciled.
    assert.ok(events.readAll().some((e) => e.kind === "worker_completed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("propagateCorrection with no waiting workers is a no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c7-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "FINDING: nothing to do" }]]);
    const { orchestrator } = setup(dir, provider);
    const resumed = await orchestrator.propagateCorrection("irrelevant correction");
    assert.deepEqual(resumed, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Parallel-write discipline ────────────────────────────────────────────────

test("write tools are stripped from the manager registry while a worker runs, then restored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c8-"));
  try {
    writeFileSync(join(dir, "code.ts"), "export const v = 1;\n", "utf8");
    const { registry, events, budget } = setup(dir, new ScriptedProvider([[]]));
    // The probe provider observes the MANAGER registry mid-run (the worker's
    // scoped view never contains write tools anyway).
    let sawStripped: boolean | undefined;
    const stripProvider: Provider = {
      name: "fake",
      capabilities: () => ({ supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100_000 }),
      async *stream() {
        sawStripped = registry.get("edit_file") === undefined && registry.get("write_file") === undefined;
        yield { type: "text_delta", text: "FINDING: checked" };
      },
    };
    const orch2 = new Orchestrator({ provider: stripProvider, model: "fake-1", config: fakeConfig(), registry, events, budget, cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 15 }) });
    await orch2.runDelegation({ role: "explorer", question: "map the code" });
    assert.equal(sawStripped, true, "write tools absent during the worker run");
    assert.ok(registry.get("edit_file"), "edit_file restored after the run");
    assert.ok(registry.get("write_file"), "write_file restored after the run");
    // The restored definition is the real one and still works.
    const edit = registry.get("edit_file")!;
    const res = await edit.execute({ path: "code.ts", old_string: "1", new_string: "2" }, makeContext(dir, { shellTimeoutSeconds: 15 }));
    assert.ok(res.ok);
    assert.equal(readFileSync(join(dir, "code.ts"), "utf8"), "export const v = 2;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Gate integration: blockers + needs_decision objections → BLOCKED ──────

test("gate stays COMPLETE with no collaboration state (regression guard)", () => {
  const gate = new CompletionGate(() => [ev(1, "task_started", { title: "x" })]);
  const report = gate.evaluate();
  assert.equal(report.verdict, "COMPLETE");
});

test("gate BLOCKED on open blocker; decision unblocks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c10-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "FINDING: x\nBLOCKER: staging db not reachable" }]]);
    const { events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "explorer", question: "check the staging integration" });

    const gate = new CompletionGate(() => events.readAll());
    const before = gate.evaluate();
    assert.equal(before.verdict, "BLOCKED");
    assert.ok(before.summary.includes("open blocker b-1"), `summary must name the blocker: ${before.summary}`);
    assert.ok(before.summary.includes("staging db not reachable"));

    orchestrator.recordDecision("resolves b-1: staging db moved to the read replica");
    const after = gate.evaluate();
    assert.equal(after.verdict, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate BLOCKED on needs_decision objection; resolving decision unblocks; dismissed does not block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c11-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "FINDING: x\nOBJECTION: this rewrite risks data loss during migration" }]]);
    const { events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "reviewer", question: "review the rewrite plan" });
    await orchestrator.propagateCorrection("use plain functions instead");

    const gate = new CompletionGate(() => events.readAll());
    const blocked = gate.evaluate();
    assert.equal(blocked.verdict, "BLOCKED");
    assert.ok(blocked.summary.includes("awaits a decision"), `summary must name the undecided objection: ${blocked.summary}`);

    // A dismissed objection never blocks.
    const { verdict } = evaluateObjection("I prefer the factory pattern", "keep it simple, no classes");
    assert.equal(verdict, "dismissed");

    // A decision that names the objection clears it and the gate.
    orchestrator.recordDecision("resolves obj-1: migration runs behind the feature flag, data loss reviewed");
    assert.equal(gate.evaluate().verdict, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision paraphrasing the blocker (no id) resolves the single unambiguous open blocker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c14-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "FINDING: x\nBLOCKER: the courier sandbox credentials are unavailable, so live rate behavior cannot be measured" }]]);
    const { events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "qa", question: "check the courier integration" });

    // Real users never know the runtime id — they describe the blocker.
    const n = orchestrator.recordDecision("resolves the courier sandbox credentials blocker: credentials are permanently unavailable; the unit simulation covers it instead", "substitute evidence accepted");
    assert.equal(n, 1, "paraphrased statement must resolve the open blocker");
    assert.equal(reduce(events.readAll()).blockers[0]?.status, "resolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ambiguous or thin paraphrases resolve nothing (conservative fallback)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c15-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "FINDING: x\nBLOCKER: the courier sandbox credentials are unavailable for live measurement\nBLOCKER: the payment gateway credentials are missing from the vault" }]]);
    const { events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "qa", question: "check external integrations" });

    // "credentials" appears in both reasons — a vague statement must not pick one.
    assert.equal(orchestrator.recordDecision("credentials will be provided later, proceed without them"), 0);
    assert.ok(reduce(events.readAll()).blockers.every((b) => b.status === "open"));

    // A statement that clearly covers only one blocker's tokens resolves exactly that one.
    const n = orchestrator.recordDecision("resolves the blocker: the payment gateway vault missing issue is settled by the new secret reference");
    assert.equal(n, 1);
    const state = reduce(events.readAll());
    assert.equal(state.blockers.find((b) => b.reason.includes("courier"))?.status, "open");
    assert.equal(state.blockers.find((b) => b.reason.includes("payment"))?.status, "resolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy no-id objection is still resolvable by statement and can block the gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c12-"));
  try {
    const provider = new ScriptedProvider([[{ type: "text_delta", text: "FINDING: x" }]]);
    const { events, orchestrator } = setup(dir, provider);
    // Legacy log shape: objection without an id, debate matched by statement.
    events.append("objection", { statement: "this risks data loss", raised_by: "reviewer:w1" });
    events.append("objection_debated", { statement: "this risks data loss", debate: { verdict: "needs_decision", rationale: "risk term" } });

    const gate = new CompletionGate(() => events.readAll());
    const blocked = gate.evaluate();
    assert.equal(blocked.verdict, "BLOCKED");
    assert.ok(blocked.summary.includes("(legacy)"), `legacy objection surfaced: ${blocked.summary}`);

    const n = orchestrator.recordDecision("this risks data loss — mitigated by the dry-run mode");
    assert.equal(n, 1, "statement-level resolution for legacy objection");
    assert.equal(gate.evaluate().verdict, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one decision can resolve a blocker and an objection together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c13-"));
  try {
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "FINDING: x\nBLOCKER: credentials missing\nOBJECTION: bypassing the api risks a security regression" },
    ]]);
    const { events, orchestrator } = setup(dir, provider);
    await orchestrator.runDelegation({ role: "reviewer", question: "review the integration shortcut" });
    await orchestrator.propagateCorrection("ship the shortcut behind the flag");

    const gate = new CompletionGate(() => events.readAll());
    assert.equal(gate.evaluate().verdict, "BLOCKED");

    const resolved = orchestrator.recordDecision("resolves b-1 and obj-1: credentials provisioned, shortcut confined to the flag");
    assert.equal(resolved, 2);
    assert.equal(gate.evaluate().verdict, "COMPLETE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel delegations keep write tools stripped until the last worker finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-c9-"));
  try {
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    registerShellTools(registry, { cancellation: new CancellationController() });
    const observations: boolean[] = [];
    let active = 0;
    let peak = 0;
    const provider: Provider = {
      name: "fake",
      capabilities: () => ({ supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100_000 }),
      async *stream() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        observations.push(registry.get("write_file") === undefined);
        active -= 1;
        yield { type: "text_delta", text: "FINDING: done" };
      },
    };
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const budget = new BudgetEnforcer({ maxTotalTokens: 500_000, maxToolCalls: 40, maxWorkerSpawns: 6, maxParallelWorkers: 2, maxWallTimeSeconds: 120 });
    const orch = new Orchestrator({ provider, model: "fake-1", config: fakeConfig(), registry, events, budget, cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 15 }) });
    const results = await orch.runParallel(
      [
        { role: "explorer", question: "map the auth flow" },
        { role: "explorer", question: "map the billing flow" },
      ],
      2,
    );
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => !r.error));
    assert.equal(peak, 2, "workers actually ran in parallel");
    assert.ok(observations.length === 2 && observations.every((o) => o === true), "write tools absent during every parallel run");
    assert.ok(registry.get("write_file") && registry.get("edit_file"), "restored after all workers finished");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Phase 9: waiver expiry ───────────────────────────────────────────────────

test("waiver deadlines re-open the blocker at the gate after expiry", () => {
  // /waive writes an ABSOLUTE expires_at (Date.now() + ttl at issuance) —
  // event data, deterministic on replay (the reducer never reads the clock).
  const future = ev(1, "blocker", { id: "b-1", reason: "staging db not reachable" });
  const waived = ev(2, "blocker_waived", { id: "b-1", reason: "known outage", expires_at: Date.now() + 24 * 3_600_000 });
  const gateFuture = new CompletionGate(() => [future, waived]);
  const report = gateFuture.evaluate();
  assert.equal(report.verdict, "COMPLETE");
  assert.ok(report.summary.includes("waived by user: b-1"), `waived listed: ${report.summary}`);

  // Expired: same shape, but the absolute deadline has passed.
  const expired = ev(2, "blocker_waived", { id: "b-1", reason: "known outage", expires_at: Date.now() - 3_600_000 });
  const state2 = reduce([future, expired]);
  assert.equal(state2.blockers[0]?.status, "waived");
  const gateExpired = new CompletionGate(() => [future, expired]);
  const r2 = gateExpired.evaluate();
  assert.equal(r2.verdict, "BLOCKED", "expired waiver must block again");
  assert.ok(r2.summary.includes("waiver expired"), `summary names expiry: ${r2.summary}`);

  // Legacy relative TTL (expires_in_hours): stored as a task-relative
  // deadline (waiverExpiresT) — deterministic on replay. The gate compares
  // it against task-elapsed time.
  const ttl = ev(2, "blocker_waived", { id: "b-1", reason: "known outage", expires_in_hours: 24 });
  const state3 = reduce([future, ttl]);
  assert.equal(state3.blockers[0]?.waiverExpiresT, ttl.t + 24 * 3_600_000, "task-relative deadline is deterministic");
});
