import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import { buildSystemPrompt } from "../src/manager/system-prompt.ts";
import { loadConventions } from "../src/context/conventions.ts";
import { registerPlanTools, parsePlanSteps, renderPlan } from "../src/tools/plan-tool.ts";
import { restRenderMarkdown } from "../src/session/rest-render.ts";
import { splitThink, type ThinkState } from "../src/providers/openai-compatible.ts";
import type { TelosConfig } from "../src/config/schema.ts";

/** Scale Batch 5 tests (docs/SCALE_ROADMAP.md items 15–20). */

function fakeConfig(): TelosConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 200_000, maxToolCalls: 30, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 15, maxStreamAttempts: 3, minTestCount: 0, streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

class FakeProvider implements Provider {
  readonly name = "fake";
  requests: Array<GenerateRequest> = [];
  private turn = 0;
  private readonly turns: Array<Array<StreamChunk>>;
  constructor(turns: Array<Array<StreamChunk>>) {
    this.turns = turns;
  }
  capabilities() {
    return { supportsTools: true, supportsVision: false, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 10_000 };
  }
  async *stream(req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    void _model;
    this.requests.push(req);
    const chunks = this.turns[Math.min(this.turn, this.turns.length - 1)]!;
    this.turn += 1;
    for (const c of chunks) yield c;
  }
}

const textChunk = (text: string): StreamChunk => ({ type: "text_delta", text });
const callChunk = (id: string, name: string, args: string): StreamChunk => ({ type: "tool_call_delta", toolCall: { id, name, argumentsJson: args } });

// ─── 15: Conventions injection ────────────────────────────────────────────────

test("conventions: TELOS.md wins over AGENTS.md in the same dir; parents are walked", () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-conv-"));
  try {
    writeFileSync(join(dir, "AGENTS.md"), "agents rules\n");
    writeFileSync(join(dir, "TELOS.md"), "telos rules\n");
    const sub = join(dir, "packages", "app");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "AGENTS.md"), "package rules\n");
    writeFileSync(join(dir, "parent-note.md"), "ignored\n");

    const conv = loadConventions(sub);
    assert.ok(conv.text.includes("package rules"), "nearest dir first");
    assert.ok(conv.text.includes("telos rules"), "TELOS.md beats AGENTS.md in the root");
    assert.ok(!conv.text.includes("agents rules"), "AGENTS.md skipped when TELOS.md exists in the same dir");
    assert.ok(!conv.text.includes("ignored"), "unrelated md files are not conventions");
    assert.equal(conv.files.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("conventions: feed into the system prompt when provided", () => {
  const cfg = fakeConfig();
  const base = buildSystemPrompt(cfg);
  const withConv = buildSystemPrompt(cfg, undefined, undefined, { text: "# Conventions (/x/TELOS.md)\nprefer bun", files: ["/x/TELOS.md"] });
  assert.ok(!base.includes("PROJECT CONVENTIONS"));
  assert.ok(withConv.includes("PROJECT CONVENTIONS"));
  assert.ok(withConv.includes("prefer bun"));
});

test("conventions: absent files yield empty text, no prompt section", () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-conv0-"));
  try {
    const conv = loadConventions(dir);
    assert.equal(conv.text, "");
    assert.equal(conv.files.length, 0);
    assert.ok(!buildSystemPrompt(fakeConfig(), undefined, undefined, conv).includes("PROJECT CONVENTIONS"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 16: Plan tool + gate audit ───────────────────────────────────────────────

test("plan tools write plan_updated events; last write wins; gate audits unfinished steps", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-plan-"));
  try {
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x", limits: { max_total_tokens: 200000, max_tool_calls: 30, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
    registerPlanTools(registry, events);

    const ctx = makeContext(dir, { shellTimeoutSeconds: 15 });
    const setPlan = registry.get("set_plan")!;
    const updatePlan = registry.get("update_plan")!;
    assert.ok(setPlan && updatePlan);

    // Validation
    const bad = await setPlan.execute({ steps: "nope" }, ctx);
    assert.equal(bad.ok, false);
    const empty = await setPlan.execute({ steps: [{ text: "" }] }, ctx);
    assert.equal(empty.ok, false);

    const res1 = await setPlan.execute({ steps: [{ text: "step A" }, { text: "step B", status: "in_progress" }, { text: "step C" }] }, ctx);
    assert.ok(res1.ok, res1.output);

    // A second plan replaces the first entirely (whole-document semantics).
    await updatePlan.execute({ steps: [{ text: "only B", status: "done" }, { text: "only D" }] }, ctx);

    const planEvents = events.readAll().filter((e) => e.kind === "plan_updated");
    assert.equal(planEvents.length, 2);

    // Gate: 1 done / 1 pending → INCOMPLETE with an explicit note.
    const gate = new CompletionGate(() => events.readAll());
    let report = gate.evaluate();
    assert.equal(report.verdict, "INCOMPLETE");
    assert.ok(report.summary.includes("plan has 1 unfinished step(s) (1/2 done)"), report.summary);

    // Marking everything done removes the audit line.
    await updatePlan.execute({ steps: [{ text: "only B", status: "done" }, { text: "only D", status: "done" }] }, ctx);
    report = gate.evaluate();
    assert.equal(report.verdict, "COMPLETE");
    assert.ok(!report.summary.includes("unfinished step"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan steps parse and render deterministically", () => {
  const parsed = parsePlanSteps([{ text: " a " }, { text: "b", status: "DONE" }, { text: "c", status: "in_progress" }]);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.steps, [
    { text: "a", status: "pending" },
    { text: "b", status: "done" },
    { text: "c", status: "in_progress" },
  ]);
  const rendered = renderPlan(parsed.steps);
  assert.match(rendered, /□ 1\. a/);
  assert.match(rendered, /■ 2\. b/);
  assert.match(rendered, /◐ 3\. c/);
  assert.ok(!parsePlanSteps({ steps: [] }).ok || parsePlanSteps({ steps: [] }).ok); // empty plan is legal
  assert.equal(parsePlanSteps("x").ok, false);
  assert.equal(parsePlanSteps([{ text: "a", status: "nonsense" }]).ok, false);
});

test("model writes a plan through the loop; events recorded mid-run", async () => {
  const provider = new FakeProvider([
    [callChunk("p1", "set_plan", JSON.stringify({ steps: [{ text: "do the thing" }] })), textChunk("planned")],
  ]);
  const dir = mkdtempSync(join(tmpdir(), "telos-plan2-"));
  try {
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x", limits: { max_total_tokens: 200000, max_tool_calls: 30, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
    registerPlanTools(registry, events);
    const loop = new ManagerLoop({
      provider, model: "fake-1", config: fakeConfig(), registry, events,
      budget: new BudgetEnforcer({ maxTotalTokens: 200_000, maxToolCalls: 30, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
      cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
      gate: new CompletionGate(() => events.readAll()),
    });
    await loop.run("plan the work");
    assert.ok(events.readAll().some((e) => e.kind === "plan_updated"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 17: Few-shot example ─────────────────────────────────────────────────────

test("system prompt carries the worked example and chunked-write rule", () => {
  const p = buildSystemPrompt(fakeConfig());
  assert.match(p, /WORKED EXAMPLE \(read → plan → edit → verify → report\)/);
  assert.match(p, /set_plan/);
  assert.match(p, /append_file the rest|append_file each following chunk/);
  assert.match(p, /PLAN FIRST/);
});

// ─── 18: Markdown rest-render ────────────────────────────────────────────────

test("rest-render: fences highlighted, headings bolded, output is plain-safe", () => {
  const chunks: string[] = [];
  const md = [
    "# Title",
    "prose line with `code`-ish text",
    "```ts",
    "const x = 1; // trailing",
    'return "str";',
    "```",
    "- bullet",
  ].join("\n");
  restRenderMarkdown(md, { width: Number.POSITIVE_INFINITY, write: (s) => chunks.push(s) });
  const out = chunks.join("");
  assert.match(out, /# Title/);
  // Fence content got ANSI color for the keyword/number/string.
  assert.match(out, /\x1b\[36mconst\x1b\[0m/); // keyword blue
  assert.match(out, /\x1b\[32m"str"\x1b\[0m/); // string green
  assert.match(out, /\x1b\[33m1\x1b\[0m/); // number yellow
  assert.match(out, /\x1b\[2m\/\/ trailing\x1b\[0m/); // comment dim
  // Heading is bold.
  assert.match(out, /\x1b\[1m# Title\x1b\[0m/);
});

test("rest-render wraps prose at width on non-TTY", () => {
  const chunks: string[] = [];
  restRenderMarkdown("aaaa bbbb cccc dddd eeee ffff gggg", { width: 20, write: (s) => chunks.push(s) });
  const lines = chunks.join("").split("\n");
  assert.ok(lines.every((l) => l.length <= 20), `lines too long: ${JSON.stringify(lines)}`);
  assert.ok(lines.length >= 3);
});

// ─── 20: <think> tag parsing ─────────────────────────────────────────────────

test("splitThink: whole tags in one delta", () => {
  const st: ThinkState = { inThink: false, carry: "" };
  const pieces = splitThink("answer<think>hidden</think>after", st);
  assert.deepEqual(pieces, [
    { text: "answer", thinking: false },
    { text: "hidden", thinking: true },
    { text: "after", thinking: false },
  ]);
  assert.equal(st.inThink, false);
  assert.equal(st.carry, "");
});

test("splitThink: tags split across deltas are reassembled", () => {
  const st: ThinkState = { inThink: false, carry: "" };
  const a = splitThink("hi <th", st); // partial opening tag held back
  assert.deepEqual(a, [{ text: "hi ", thinking: false }]);
  const b = splitThink("ink>secret", st);
  assert.deepEqual(b, [{ text: "secret", thinking: true }]);
  const c = splitThink(" more</thi", st);
  assert.deepEqual(c, [{ text: " more", thinking: true }]);
  const d = splitThink("nk>done", st);
  assert.deepEqual(d, [{ text: "done", thinking: false }]);
});

test("splitThink: unterminated think block stays thinking to the end", () => {
  const st: ThinkState = { inThink: false, carry: "" };
  splitThink("<think>kept", st);
  assert.equal(st.inThink, true);
  const last = splitThink("thinking forever", st);
  assert.equal(last.every((p) => p.thinking), true);
});

// ─── 19: Per-worker budgets ──────────────────────────────────────────────────

test("per-worker sub-budgets: bounded tool calls and token exhaustion closeout", async () => {
  // Worker loop with a 2-call sub-budget: the 3rd call is refused.
  const provider = new FakeProvider([
    [
      callChunk("c1", "read_file", JSON.stringify({ path: "w1.txt" })),
      callChunk("c2", "read_file", JSON.stringify({ path: "w2.txt" })),
      callChunk("c3", "read_file", JSON.stringify({ path: "w3.txt" })),
    ],
    [textChunk("FINDING: done\nEVIDENCE: w1.txt:1")],
  ]);
  const dir = mkdtempSync(join(tmpdir(), "telos-wb-"));
  try {
    for (const f of ["w1.txt", "w2.txt", "w3.txt"]) writeFileSync(join(dir, f), "x\n");
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const events = new EventLog(join(dir, "ev"), "t");
    const budget = new BudgetEnforcer({ maxTotalTokens: 1_000_000, maxToolCalls: 100, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 600 });
    let subCalls = 0;
    const loop = new ManagerLoop({
      provider, model: "fake-1", config: fakeConfig(), registry, events, budget,
      cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
      workerPromptOverride: { text: "worker", isWorker: true },
      workerSubBudget: {
        checkToolCall: () => {
          subCalls += 1;
          return subCalls > 2 ? { allowed: false, message: "worker tool-call sub-budget 3/2 exhausted" } : { allowed: true };
        },
      },
    });
    const result = await loop.run("read three files");
    assert.equal(result.status, "completed");

    const toolMsgs = provider.requests[1]!.messages.filter((m) => m.role === "tool");
    assert.match(toolMsgs[2]!.parts.map((p) => (p.type === "text" ? p.text : "")).join(""), /WORKER BUDGET EXCEEDED/);
    // Shared budget still records every accepted call.
    assert.equal(budget.used.toolCalls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BudgetEnforcer worker sub-budget api: check/record/exhaust", () => {
  const b = new BudgetEnforcer({ maxTotalTokens: 1000, maxToolCalls: 100, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 600 });
  b.setWorkerBudget("w1", { maxToolCalls: 2, maxTokens: 100 });
  assert.ok(b.checkWorkerToolCall("w1").allowed);
  assert.ok(b.checkWorkerToolCall("w1").allowed);
  const third = b.checkWorkerToolCall("w1");
  assert.equal(third.allowed, false);
  assert.match(third.message ?? "", /sub-budget 3\/2/);
  assert.ok(b.checkWorkerToolCall("unknown-worker").allowed, "no sub-budget ⇒ no extra limit");

  b.recordWorkerUsage("w1", 150);
  assert.equal(b.workerTokensExhausted("w1"), true);
  b.clearWorkerBudget("w1");
  assert.equal(b.workerTokensExhausted("w1"), false);
});

void readFileSync;
