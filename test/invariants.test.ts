import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import type { GenerateRequest, Provider, StreamChunk, Usage } from "../src/providers/types.ts";
import type { AgentEvent } from "../src/events/types.ts";
import { safePath, truncateOutput, summarizeLineChanges, makeContext } from "../src/tools/util.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { registerMcpServer, classifyMcpTool } from "../src/mcp/tools.ts";
import { EventLog } from "../src/events/log.ts";
import { reduce } from "../src/events/state.ts";
import { StateStore } from "../src/events/state-store.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { FailureLearner } from "../src/memory/pipeline.ts";
import { panelLines } from "../src/session/panel.ts";
import { markSteering, STEERING_MARK } from "../src/manager/steering.ts";
import type { TelosConfig } from "../src/config/schema.ts";

/**
 * Cross-subsystem invariant suite (hardening pass). Each test pins a
 * non-negotiable invariant that spans subsystems — the exact regression
 * class the hardening prompt demands:
 *
 *   security / completion gate / correction / provider concurrency /
 *   worker budgets / cost honesty / reducer determinism / memory keys /
 *   UTF-8 output safety / terminal rendering
 */

// ─── Shared harness ───────────────────────────────────────────────────────────

const textChunk = (text: string): StreamChunk => ({ type: "text_delta", text });
const callChunk = (id: string, name: string, args: string): StreamChunk => ({ type: "tool_call_delta", toolCall: { id, name, argumentsJson: args } });
const usageChunk = (o: number, i = 100, cached = 0): StreamChunk => ({
  type: "usage",
  usage: { inputTokens: i, outputTokens: o, cachedTokens: cached, totalTokens: i + o, modelCalls: 1, toolCalls: 0, costUsd: null } as Usage,
});

function fakeConfig(): TelosConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 4096 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 1_000_000, maxToolCalls: 50, maxWorkerSpawns: 4,
      maxParallelWorkers: 2, maxWallTimeSeconds: 120, shellTimeoutSeconds: 15, maxStreamAttempts: 3, minTestCount: 0, streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

function ev(seq: number, kind: AgentEvent["kind"], data: Record<string, unknown> = {}): AgentEvent {
  return { seq, t: seq * 1000, taskId: "t-invariants", kind, data };
}

// ─── Security: workspace symlink escape ──────────────────────────────────────

test("invariant: write under an outside symlink is denied (nonexistent leaf)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-sec-"));
  const outside = mkdtempSync(join(tmpdir(), "telos-inv-out-"));
  try {
    symlinkSync(outside, join(dir, "linked"), "dir");
    const ctx = makeContext(dir, { shellTimeoutSeconds: 5 });

    // The exploit from the audit: nonexistent leaf under an outside symlink.
    assert.throws(() => safePath(ctx, "linked/new.txt"), /escapes workspace/);

    // Nested nonexistent path under the symlink: same rejection.
    assert.throws(() => safePath(ctx, "linked/deeper/new.txt"), /escapes workspace/);

    // Registry-level: write_file refuses and nothing is written outside.
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const wf = registry.get("write_file")!;
    const res = await wf.execute({ path: "linked/escape.txt", content: "pwned" }, ctx);
    assert.equal(res.ok, false);
    let escaped = true;
    try {
      readFileSync(join(outside, "escape.txt"), "utf8");
    } catch {
      escaped = false;
    }
    assert.equal(escaped, false, "no file may appear in the symlink target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("invariant: safePath containment matrix (existing leaf, .., absolute, root)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-sec2-"));
  const outside = mkdtempSync(join(tmpdir(), "telos-inv-out2-"));
  try {
    writeFileSync(join(dir, "real.txt"), "x", "utf8");
    symlinkSync(outside, join(dir, "lnk"), "dir");
    writeFileSync(join(outside, "target.txt"), "x", "utf8");
    const ctx = makeContext(dir, { shellTimeoutSeconds: 5 });

    // Allowed: normal paths, nested creation in a safe dir, the root itself.
    assert.doesNotThrow(() => safePath(ctx, "real.txt"));
    assert.doesNotThrow(() => safePath(ctx, "sub/dir/new.txt"));
    assert.doesNotThrow(() => safePath(ctx, "."));
    assert.doesNotThrow(() => safePath(ctx, dir));

    // Rejected: traversal, absolute outside, existing symlink target,
    // nonexistent leaf under an outside symlink.
    assert.throws(() => safePath(ctx, "../outside.txt"), /escapes workspace/);
    assert.throws(() => safePath(ctx, join(outside, "abs.txt")), /escapes workspace/);
    assert.throws(() => safePath(ctx, "lnk/target.txt"), /escapes workspace/);
    assert.throws(() => safePath(ctx, "lnk/brand-new.txt"), /escapes workspace/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ─── Completion Gate: stale verification ─────────────────────────────────────

test("invariant: edit → test → edit cannot complete from the OLD test run", () => {
  const events: AgentEvent[] = [
    ev(1, "task_started", { title: "x" }),
    ev(2, "tool_completed", { name: "write_file" }),
    ev(3, "test_result", { ok: true, observation: "3 passing" }),
    ev(4, "tool_completed", { name: "edit_file" }), // mutation AFTER verification
    ev(5, "user_instruction", { text: "done?" }),
  ];
  const state = reduce(events);
  assert.equal(state.workspaceVersion, 2, "two mutator completions counted");
  const gate = new CompletionGate(() => events);
  const report = gate.evaluate();
  assert.equal(report.verdict, "INCOMPLETE", "stale verification must not complete a modified workspace");
  assert.match(report.summary, /modified after the last verification/);
});

test("invariant: edit → test(pending run) → gate COMPLETE (fresh verification order)", () => {
  const events: AgentEvent[] = [
    ev(1, "task_started", { title: "x" }),
    ev(2, "tool_completed", { name: "write_file" }),
    ev(3, "test_result", { ok: true, observation: "5 passing" }),
    ev(4, "user_instruction", { text: "done?" }),
  ];
  const state = reduce(events);
  assert.equal(state.workspaceVersion, 1);
  const report = new CompletionGate(() => events).evaluate();
  assert.equal(report.verdict, "COMPLETE");
});

test("invariant: no workspace mutation at all → no stale-verification complaint", () => {
  const events: AgentEvent[] = [
    ev(1, "task_started", { title: "x" }),
    ev(2, "test_result", { ok: true, observation: "2 passing" }),
    ev(3, "user_instruction", { text: "investigate only" }),
  ];
  const report = new CompletionGate(() => events).evaluate();
  assert.equal(report.verdict, "COMPLETE");
  assert.ok(!report.summary.includes("verification"));
});

// ─── Correction semantics: steering ≡ /correct ───────────────────────────────

test("invariant: mid-run steering becomes a user_correction (same state machinery)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-steer-"));
  try {
    writeFileSync(join(dir, "a.txt"), "A\n", "utf8");
    const provider: Provider = {
      name: "fake",
      capabilities: () => ({ supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100_000 }),
      async *stream(req: GenerateRequest) {
        // After the first tool result, the steering line must already be a
        // user_correction in the state the gate will derive.
        if (req.messages.some((m) => m.role === "tool")) {
          yield textChunk("adjusted course");
        } else {
          yield callChunk("c1", "read_file", JSON.stringify({ path: "a.txt" }));
          yield usageChunk(10);
        }
      },
    };
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    let drained = false;
    const loop = new ManagerLoop({
      provider, model: "fake-1", config: fakeConfig(), registry, events,
      budget: new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
      cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
      steering: {
        drain: () => {
          if (drained) return [];
          drained = true;
          return ["do not use tailwind"];
        },
      },
    });
    await loop.run("style the page");
    const corrections = events.readAll().filter((e) => e.kind === "user_correction");
    assert.equal(corrections.length, 1, "steering line recorded as user_correction");
    assert.equal(corrections[0]!.data["source"], "steering");

    // Reducer applies the SAME invalidation semantics as a /correct event.
    const state = reduce(events.readAll());
    assert.equal(state.instructions.filter((i) => i.isCorrection).length, 1);
    // And the in-context line still carries the precedence marker.
    assert.ok(markSteering("x").startsWith(STEERING_MARK));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Provider concurrency: Anthropic usage isolation ─────────────────────────

class AnthropicSseServer {
  readonly server: http.Server;
  readonly url: string;
  constructor(usageA: { input: number; output: number }, usageB: { input: number; output: number }) {
    let n = 0;
    this.server = http.createServer((req, res) => {
      const u = n === 0 ? usageA : usageB;
      n += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: u.input, cache_read_input_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } })}\n\n`);
      // Hold the stream open so both run CONCURRENTLY before message_delta.
      setTimeout(() => {
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: u.output } })}\n\n`);
        res.end();
      }, 120);
    });
    this.server.listen(0);
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}/v1`;
  }
  close(): void {
    this.server.close();
    // Keep-alive sockets would hold the test process open past the tests.
    this.server.closeAllConnections?.();
  }
}

test("invariant: concurrent Anthropic streams keep usage isolated (no cross-contamination)", async () => {
  const srv = new AnthropicSseServer({ input: 1111, output: 22 }, { input: 333_333, output: 444 });
  try {
    const p = new AnthropicProvider("k", srv.url, 10);
    const collect = async (): Promise<Usage> => {
      let usage: Usage | undefined;
      for await (const c of p.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }, "claude-fake")) {
        if (c.type === "usage") usage = c.usage;
      }
      return usage!;
    };
    const [a, b] = await Promise.all([collect(), collect()]);
    assert.deepEqual([a.inputTokens, a.outputTokens], [1111, 22], "stream A usage stays A");
    assert.deepEqual([b.inputTokens, b.outputTokens], [333333, 444], "stream B usage stays B");
  } finally {
    srv.close();
  }
});

test("invariant: OpenAI-compatible capability honesty (vision unknown ⇒ not sent)", () => {
  const caps = new OpenAICompatibleProvider("k", "http://127.0.0.1:1").capabilities("some-unknown-model");
  assert.equal(caps.supportsVision, "unknown", "unknown model must not claim vision");
  assert.equal(new OpenAICompatibleProvider("k", "http://127.0.0.1:1").capabilities("gpt-4o").supportsVision, "supported");
  assert.equal(new OpenAICompatibleProvider("k", "http://127.0.0.1:1").capabilities("gpt-4o").supportsStructuredOutput, "unknown");
});

// ─── Observed output cap reaches the runtime ─────────────────────────────────

test("invariant: observed truncation clamps the next request's max_tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-cap-"));
  try {
    const requests: Array<GenerateRequest> = [];
    const provider: Provider = {
      name: "fake",
      capabilities: () => ({ supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100_000 }),
      async *stream(req: GenerateRequest) {
        requests.push(req);
        // First turn pretends to truncate at 4096 output tokens.
        yield textChunk("truncated...");
        yield usageChunk(4096);
        yield { type: "finish", stopReason: "length" };
      },
    };
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const cfg = fakeConfig();
    let observedCap: number | undefined;
    const manager = new ManagerLoop({
      provider, model: "fake-1", config: cfg, registry, events,
      budget: new BudgetEnforcer({ maxTotalTokens: 1_000_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
      cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 5 }),
      observedOutputCap: () => observedCap,
    });
    await manager.run("write something long");
    assert.equal(requests[0]!.maxTokens, cfg.model.maxTokens, "first request uses the configured cap");

    // Session learns the cap (noteObservedCap round-to-64 at ≥1000).
    observedCap = 4096;
    await manager.run("write something long again");
    assert.ok(requests[1]!.maxTokens! <= 4096 + 256, `learned cap must clamp the wire request, got ${requests[1]!.maxTokens}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Workers: resume obeys the parallel ceiling; billable sub-budget ─────────

test("invariant: continue_worker respects maxParallelWorkers (resume is not a bypass)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-wait-"));
  try {
    const provider: Provider = {
      name: "fake",
      capabilities: () => ({ supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 100_000 }),
      async *stream(_req: GenerateRequest) {
        yield textChunk("WAITING: need the fix applied");
        yield usageChunk(10);
      },
    };
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x" });
    const budget = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 4, maxParallelWorkers: 2, maxWallTimeSeconds: 60 });
    const { Orchestrator } = await import("../src/workers/orchestrator.ts");
    const orch = new Orchestrator({ provider, model: "fake-1", config: fakeConfig(), registry, events, budget, cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 5 }) });

    const r1 = await orch.runDelegation({ role: "explorer", question: "q1" });
    assert.ok(r1.waitingFor, "worker went waiting");
    // Fill both parallel slots with two waiting-but-resumed-style claims:
    // simulate a full house by recording spawns without finishing them.
    budget.record("worker_spawn");
    budget.record("worker_spawn");
    const blocked = await orch.continueWorker(r1.workerId, "the fix is applied");
    assert.match(blocked.error ?? "", /parallel workers/, "resume must be refused when the ceiling is full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invariant: worker sub-budget counts BILLABLE tokens and is a hard ceiling", () => {
  const b = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 2, maxParallelWorkers: 2, maxWallTimeSeconds: 60 });
  b.setWorkerBudget("w1", { maxToolCalls: 5, maxTokens: 100 });
  // 150 total tokens but 60 of them cached → billable 90: under the ceiling.
  b.recordWorkerUsage("w1", 150, 60);
  assert.equal(b.workerTokensExhausted("w1"), false, "cached reads must not count against the sub-budget");
  b.recordWorkerUsage("w1", 60, 50); // billable +10 → 100 = max
  assert.equal(b.workerTokensExhausted("w1"), true, "AT the ceiling the worker is exhausted (>= semantics)");
});

// ─── Cost honesty: actual vs estimated, no double counting ───────────────────

test("invariant: provider-reported cost wins; pricing is only a fallback; never summed", () => {
  const b = new BudgetEnforcer({ maxTotalTokens: 100_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
  b.setPricing({ inputPerMtok: 3, outputPerMtok: 15 });
  b.recordUsage({ inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0, totalTokens: 1_100_000, modelCalls: 1, toolCalls: 0, costUsd: null });
  const est = b.costEstimateUsd!;
  assert.ok(Math.abs(est - (3 + 1.5)) < 1e-9, `estimate from pricing, got ${est}`);
  assert.equal(b.costBasis, "estimated");

  // Provider reports actual cost: it REPLACES the estimate (never 4.5).
  b.recordUsage({ inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, modelCalls: 1, toolCalls: 0, costUsd: 0.42 });
  assert.equal(b.costEstimateUsd, 0.42, "actual wins; estimate must not be added on top");
  assert.equal(b.costBasis, "actual");
});

// ─── Reducer determinism: replay at T1 == replay at T2 ───────────────────────

test("invariant: reduce() twice at different times yields identical state", () => {
  const events: AgentEvent[] = [
    ev(1, "task_started", { title: "x", limits: { max_total_tokens: 100, max_tool_calls: 5, max_worker_spawns: 1, max_parallel_workers: 1, max_wall_time_seconds: 60 } }),
    ev(2, "tool_completed", { name: "write_file" }),
    ev(3, "blocker", { id: "b-1", reason: "stuck" }),
    ev(4, "blocker_waived", { id: "b-1", reason: "ok", expires_in_hours: 24 }),
    ev(5, "requirement_added", { id: "r-1", description: "d", required: true }),
    ev(6, "requirement_satisfied", { id: "r-1", source: "tool", producer: "runtime", observation: "o" }),
  ];
  const s1 = reduce(events);
  const before = Date.now();
  const s2 = reduce(events);
  assert.ok(Date.now() >= before, "sanity: clock moved");
  assert.equal(JSON.stringify(s1.blockers), JSON.stringify(s2.blockers), "waiver deadlines identical across replays");
  assert.equal(JSON.stringify([...s1.requirements.values()]), JSON.stringify([...s2.requirements.values()]), "evidence timestamps identical across replays");
  assert.equal(s2.workspaceVersion, 1);
  assert.equal(s2.task.startedAt, events[0]!.t, "task start derives from the event, not the wall clock");
});

test("invariant: StateStore incremental fold == full replay (workspaceVersion included)", () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-store-"));
  try {
    const log = new EventLog(join(dir, "ev"), "t");
    log.append("task_started", { title: "x" });
    const store = new StateStore(log);
    log.append("tool_completed", { name: "write_file" });
    log.append("tool_completed", { name: "edit_file" });
    log.append("tool_failed", { name: "write_file", tool_call_id: "x", category: "bad_args", message: "no" });
    const folded = store.current();
    const full = reduce(log.readAll());
    assert.equal(folded.workspaceVersion, 2);
    assert.equal(full.workspaceVersion, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Memory: recurrence keys must not merge different failure categories ─────

test("invariant: tool:category:target keys keep distinct failures distinct", () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-mem-"));
  try {
    const learner = new FailureLearner(new MemoryStore(dir));
    const l1 = learner.recordFailure({ tool: "run_shell", category: "port_in_use", observation: "EADDRINUSE :3000", target: "npm run dev" });
    const l2 = learner.recordFailure({ tool: "run_shell", category: "command_not_found", observation: "npm: not found", target: "npm run dev" });
    assert.equal(l1, null);
    assert.equal(l2, null, "same command but DIFFERENT category — must not merge into one recurrence");
    const failures = new MemoryStore(dir).all("failure");
    assert.equal(failures.length, 2, "two distinct failure records");
    const l3 = learner.recordFailure({ tool: "run_shell", category: "port_in_use", observation: "EADDRINUSE :3000", target: "npm run dev" });
    assert.ok(l3, "same tool+category+target recurred → promotes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Memory store: atomic rewrite (no stale .tmp resurrection) ───────────────

test("invariant: rewriteKind truncates the tmp file (crash cannot resurrect stale records)", () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-tmp-"));
  try {
    const store = new MemoryStore(dir);
    store.add({ type: "fact", key: "k1", statement: "one", source: "t", verified: true });
    store.add({ type: "fact", key: "k2", statement: "two", source: "t", verified: true });
    // Simulate a crashed rewrite: a stale .tmp with garbage from a previous run.
    const factsPath = join(dir, ".project-agent", "memory", "facts.jsonl");
    writeFileSync(`${factsPath}.tmp`, "GARBAGE-FROM-A-CRASH\n", "utf8");
    // A dedup hit triggers a rewrite; it must TRUNCATE the tmp, not append.
    store.add({ type: "fact", key: "k1", statement: "one", source: "t", verified: true });
    const fresh = new MemoryStore(dir);
    const facts = fresh.all("fact");
    assert.equal(facts.length, 2, `stale tmp content must not survive: ${JSON.stringify(facts.map((f) => f.statement))}`);
    assert.ok(!facts.some((f) => f.statement.includes("GARBAGE")));
    assert.ok(readFileSync(factsPath, "utf8").includes("k2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Output safety: UTF-8 truncation ─────────────────────────────────────────

test("invariant: truncateOutput never splits a code point (emoji, CJK, accents)", () => {
  const emoji = "x".repeat(50) + "🚀🚀🚀🚀🚀";
  const r1 = truncateOutput(emoji, 55);
  assert.ok(r1.truncated, "note included");
  assert.ok(!r1.text.includes("\uFFFD"), "no replacement chars — no split surrogate");
  assert.ok(r1.text.startsWith("x"));

  const cjk = "你好世界".repeat(20);
  const r2 = truncateOutput(cjk, 20);
  assert.ok(!r2.text.includes("\uFFFD"), "CJK cut stays code-point aligned");
  const accent = "é".repeat(100);
  const r3 = truncateOutput(accent, 30);
  assert.ok(!r3.text.includes("\uFFFD"));
  // Under the limit: untouched.
  assert.equal(truncateOutput("small", 100).truncated, false);
  assert.equal(truncateOutput("small", 100).text, "small");
});

test("invariant: summarizeLineChanges counts a multiset change, not a structural diff", () => {
  const d = summarizeLineChanges("a\nb\nc", "a\nb\nc\nd");
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  const d2 = summarizeLineChanges("a\na\na", "a");
  assert.equal(d2.removed, 2);
});

// ─── MCP: annotation-based classification + read-only worker eligibility ─────

test("invariant: MCP annotations map to policy; read-only tools are parallelizable", async () => {
  assert.deepEqual(classifyMcpTool({ name: "t", inputSchema: {}, annotations: { readOnlyHint: true } }), { permission: "read", mutative: false, risk: "low" });
  assert.deepEqual(classifyMcpTool({ name: "t", inputSchema: {}, annotations: { destructiveHint: true } }), { permission: "shell", mutative: true, risk: "high" });
  // Conservative fallback without annotations.
  assert.deepEqual(classifyMcpTool({ name: "t", inputSchema: {} }), { permission: "shell", mutative: true, risk: "medium" });

  // End-to-end: a server whose tool declares readOnlyHint registers read-only.
  const dir = mkdtempSync(join(tmpdir(), "telos-inv-mcp-"));
  try {
    writeFileSync(join(dir, "server.mjs"), Buffer.from(`
      process.stdin.on('data', () => {});
      const write = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\\n")) !== -1) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.method === 'initialize') write({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'ro' } } });
          else if (msg.method === 'tools/list') write({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'read_thing', description: 'reads', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } });
          else if (msg.id) write({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
      });
    `, "utf8"));
    const registry = new ToolRegistry();
    const reg = await registerMcpServer(registry, { name: "ro", command: process.execPath, args: [join(dir, "server.mjs")], env: {}, timeoutSeconds: 5, workerRoles: [] });
    try {
      assert.equal(reg.started, true, reg.error ?? "");
      const tool = registry.get("mcp_ro_read_thing");
      assert.ok(tool, "read-only MCP tool registered");
      assert.equal(tool!.mutative, false, "readOnlyHint → mutative false → usable by read-only workers");
      assert.equal(tool!.permission, "read");
      assert.equal(tool!.risk, "low");
    } finally {
      reg.client?.stop(); // the child must not hold the test process open
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Terminal rendering: transient state never enters the transcript ─────────

test("invariant: one logical status renders once — activity joins the status row (no second frame)", () => {
  // panelLines is the panel's pure frame builder: the activity label is part
  // of the SAME status row (no separate spinner/box frame exists).
  const idle = panelLines({ width: 60, panelHeight: 3, input: "", cursor: 0, status: "budget 10 · tools 1", busy: false });
  const busy = panelLines({ width: 60, panelHeight: 3, input: "", cursor: 0, status: "budget 10 · tools 1", busy: false, activity: "◐ thinking 8.4s" });
  assert.ok(!idle.status.includes("thinking"));
  assert.ok(busy.status.includes("budget 10 · tools 1"));
  assert.ok(busy.status.includes("◐ thinking 8.4s"), "activity renders inside the one status row");
  // Input row is unchanged by activity: assistant output cannot enter input.
  assert.equal(strip(idle.input[0]!), strip(busy.input[0]!));
});

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
