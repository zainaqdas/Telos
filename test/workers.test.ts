import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { registerShellTools } from "../src/tools/shell-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { reduce } from "../src/events/state.ts";
import { FailureLearner } from "../src/memory/pipeline.ts";
import { Orchestrator } from "../src/workers/orchestrator.ts";
import { parseWorkerReport, ROLES } from "../src/workers/roles.ts";
import type { SynergonConfig } from "../src/config/schema.ts";

/** Provider that emits the scripted turn for a marker, then converges to prose. */
class RoleRoutingProvider implements Provider {
  readonly name = "fake";
  private readonly scripted: Array<{ marker: string; chunks: Array<StreamChunk>; after: Array<StreamChunk> }>;
  private readonly calls = new Map<string, number>();
  constructor(scripted: Array<{ marker: string; chunks: Array<StreamChunk>; after?: Array<StreamChunk> }>) {
    this.scripted = scripted.map((s) => ({ ...s, after: s.after ?? [{ type: "text_delta", text: "FINDING: no further action." }] }));
  }
  capabilities() {
    return { supportsTools: true, supportsVision: false, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 100_000 };
  }
  async *stream(req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    void _model;
    const sys = req.messages.find((m) => m.role === "system");
    const sysText = sys ? sys.parts.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
    const entry = this.scripted.find((s) => sysText.includes(s.marker)) ?? this.scripted[this.scripted.length - 1]!;
    const n = (this.calls.get(entry.marker) ?? 0) + 1;
    this.calls.set(entry.marker, n);
    for (const c of (n === 1 ? entry.chunks : entry.after)) yield c;
  }
}

function fakeConfig(): SynergonConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 500_000, maxToolCalls: 40, maxWorkerSpawns: 4,
      maxParallelWorkers: 2, maxWallTimeSeconds: 120, shellTimeoutSeconds: 15, maxStreamAttempts: 2, minTestCount: 1, streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

function fullSetup(dir: string, provider: Provider, over: Partial<{ maxWorkerSpawns: number; maxParallelWorkers: number }> = {}) {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });
  const events = new EventLog(join(dir, "ev"), "t");
  events.append("task_started", { title: "x" });
  const budget = new BudgetEnforcer({
    maxTotalTokens: 500_000, maxToolCalls: 40,
    maxWorkerSpawns: over.maxWorkerSpawns ?? 4, maxParallelWorkers: over.maxParallelWorkers ?? 2, maxWallTimeSeconds: 120,
  });
  const orchestrator = new Orchestrator({ provider, model: "fake-1", config: fakeConfig(), registry, events, budget, cancellation, ctx: makeContext(dir, { shellTimeoutSeconds: 15 }) });
  registry.register(orchestrator.delegateTool());
  registry.register(orchestrator.continueTool());
  return { registry, events, budget, orchestrator, cancellation };
}

const REPORT = [
  "FINDING: session ownership lives in src/auth/session.ts",
  "EVIDENCE: src/auth/session.ts:41-68 session lookup",
  "RISK: the proposed fix bypasses the middleware chain",
  "OBJECTION: fixing the redirect alone ignores the async state race",
  "RECOMMENDATION: fix update ordering first",
  "CONFIDENCE: high",
].join("\n");

const workerTurn = (): Array<StreamChunk> => [{ type: "text_delta", text: REPORT }];

test("report parser extracts structured sections", () => {
  const r = parseWorkerReport(REPORT);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]?.claim, "session ownership lives in src/auth/session.ts");
  assert.match(r.findings[0]?.evidence ?? "", /session\.ts:41-68/);
  assert.equal(r.risks.length, 1);
  assert.equal(r.objections.length, 1);
  assert.equal(r.confidence, "high");
});

test("worker registry view excludes write-capable tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-w1-"));
  try {
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const cancellation = new CancellationController();
    registerShellTools(registry, { cancellation });
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const budget = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 5, maxWorkerSpawns: 2, maxParallelWorkers: 1, maxWallTimeSeconds: 60 });
    const orch = new Orchestrator({ provider: new RoleRoutingProvider([]), model: "f", config: fakeConfig(), registry, events, budget, cancellation, ctx: makeContext(dir, { shellTimeoutSeconds: 15 }) });
    // Probe the scoped views directly through the delegate path setup.
    const spec = orch.delegateTool();
    assert.equal(spec.name, "delegate");
    // The role toolsets come from ROLES; assert the policy, not internals.
    for (const role of Object.values(ROLES)) {
      if (role.role !== "qa") assert.ok(!role.allowedTools.includes("edit_file") && !role.allowedTools.includes("write_file"), `${role.role} must not write`);
    }
    assert.ok(ROLES["qa"]!.allowedTools.includes("run_shell"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel delegation runs workers and reconciles findings + objections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-w2-"));
  try {
    writeFileSync(join(dir, "src.ts"), "export const a = 1;\n", "utf8");
    const provider = new RoleRoutingProvider([
      { marker: "You are explorer", chunks: workerTurn() },
      { marker: "You are reviewer", chunks: workerTurn() },
    ]);
    const { events, orchestrator } = fullSetup(dir, provider);
    const results = await orchestrator.runParallel(
      [
        { role: "explorer", question: "who owns session restore?" },
        { role: "reviewer", question: "review the proposed change" },
      ],
      2,
    );
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => !r.error));
    const state = reduce(events.readAll());
    assert.equal(state.workers.size, 2);
    assert.ok([...state.workers.values()].every((w) => w.status === "completed"));
    assert.equal(state.findings.length, 2, "one finding per worker report");
    assert.equal(state.objections.length, 2, "one objection per worker report");
    // Worker transcripts are isolated: explorer never sees reviewer's question.
    assert.ok(events.readAll().filter((e) => e.kind === "worker_started").length === 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker budget refusal: no spawn beyond maxWorkerSpawns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-w3-"));
  try {
    const provider = new RoleRoutingProvider([{ marker: "You are", chunks: workerTurn() }]);
    const { orchestrator, budget, events } = fullSetup(dir, provider, { maxWorkerSpawns: 1 });
    const first = await orchestrator.runDelegation({ role: "explorer", question: "map the auth flow" });
    assert.ok(!first.error);
    const second = await orchestrator.runDelegation({ role: "explorer", question: "map the billing flow" });
    assert.match(second.error ?? "", /refused by runtime/);
    assert.equal(budget.used.workersSpawned, 1);
    // No second worker_started.
    assert.equal(events.readAll().filter((e) => e.kind === "worker_started").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waiting worker persists, resumes via continue_worker, and reconciles on completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-w5-"));
  try {
    writeFileSync(join(dir, "feature.ts"), "export const feature = () => 1;\n", "utf8");
    // Reviewer's first cycle: nothing to review yet → WAITING. Second cycle: full report.
    const provider = new RoleRoutingProvider([
      { marker: "You are reviewer", chunks: [{ type: "text_delta", text: "WAITING: the fix is not applied yet" }], after: [
        { type: "text_delta", text: "VERDICT: approve\nFINDING: the applied fix is minimal and correct\nEVIDENCE: feature.ts:1\nCONFIDENCE: high" },
      ] },
    ]);
    const { events, orchestrator } = fullSetup(dir, provider);

    const first = await orchestrator.runDelegation({ role: "reviewer", question: "review the feature fix" });
    assert.match(first.error ?? "", /WORKER WAITING/);
    assert.equal(first.waitingFor, "the fix is not applied yet");
    assert.ok(orchestrator.waitingWorkerIds().includes(first.workerId));
    assert.ok(events.readAll().some((e) => e.kind === "worker_waiting"));
    // No premature completion event.
    assert.ok(!events.readAll().some((e) => e.kind === "worker_completed"));

    const second = await orchestrator.continueWorker(first.workerId, "the fix is now applied to feature.ts; review it");
    assert.ok(!second.error);
    assert.equal(second.report.verdict, "approve");
    assert.ok(!orchestrator.waitingWorkerIds().includes(first.workerId), "session cleaned after completion");
    const state = reduce(events.readAll());
    assert.ok(state.workers.get(first.workerId)?.status === "completed");
    assert.ok(events.readAll().some((e) => e.kind === "worker_started" && e.data["resumed"] === true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("continue_worker refuses unknown worker ids and lists waiting ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-w6-"));
  try {
    const provider = new RoleRoutingProvider([{ marker: "You are explorer", chunks: [{ type: "text_delta", text: "WAITING: need db credentials" }] }]);
    const { orchestrator } = fullSetup(dir, provider);
    await orchestrator.runDelegation({ role: "explorer", question: "inspect the migration state" });
    const bad = await orchestrator.continueWorker("wX-nope", "irrelevant");
    assert.match(bad.error ?? "", /no waiting worker 'wX-nope'/);
    assert.match(bad.error ?? "", /w\d+-[0-9a-f]{4}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker findings and objections persist to memory for future sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-w7-"));
  try {
    const { MemoryStore } = await import("../src/memory/store.ts");
    const store = new MemoryStore(dir);
    const learner = new FailureLearner(store);
    const provider = new RoleRoutingProvider([
      { marker: "You are reviewer", chunks: [{ type: "text_delta", text: "VERDICT: request_changes\nFINDING: the shortcut bypasses CSRF binding\nEVIDENCE: login.js:12\nOBJECTION: special-casing admin re-creates the open-redirect bug class" }] },
    ]);
    const { orchestrator } = fullSetup(dir, provider);
    // Attach learner via a fresh orchestrator that has it.
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const cancellation = new CancellationController();
    registerShellTools(registry, { cancellation });
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const budget = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 2, maxParallelWorkers: 1, maxWallTimeSeconds: 60 });
    const orch2 = new Orchestrator({ provider, model: "fake-1", config: fakeConfig(), registry, events, budget, cancellation, ctx: makeContext(dir, { shellTimeoutSeconds: 15 }), learner });
    await orch2.runDelegation({ role: "reviewer", question: "review the login change" });

    const facts = store.all("fact");
    assert.ok(facts.some((f) => /CSRF binding/.test(f.statement) && f.verified));
    const objections = store.all("objection");
    assert.ok(objections.some((o) => /open-redirect/.test(o.statement)));
    // Retrieval surfaces the prior objection for a related instruction.
    const text = learner.formatForContext(learner.retrieveFor("review the admin shortcut in login.js"));
    assert.match(text, /PRIOR OBJECTION/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manager stays primary builder: workers cannot write via scoped loop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-w4-"));
  try {
    writeFileSync(join(dir, "code.ts"), "export const v = 1;\n", "utf8");
    // QA worker whose "model" tries to edit instead of reporting.
    const provider = new RoleRoutingProvider([
      { marker: "You are qa", chunks: [
        { type: "tool_call_delta", toolCall: { id: "c1", name: "edit_file", argumentsJson: JSON.stringify({ path: "code.ts", old_string: "1", new_string: "2" }) } },
      ], after: [{ type: "text_delta", text: "TESTED: attempted edit\nRESULT: unknown" }] },
    ]);
    const { events, orchestrator } = fullSetup(dir, provider);
    const result = await orchestrator.runDelegation({ role: "qa", question: "verify the change" });
    // The edit tool is not in the QA allowlist -> unknown tool inside the loop.
    assert.equal(readFileSync(join(dir, "code.ts"), "utf8"), "export const v = 1;\n");
    const state = reduce(events.readAll());
    assert.ok(state.workers.get(result.workerId)?.status === "completed");
    assert.match(result.report.tested?.join(" ") ?? "", /attempted edit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
