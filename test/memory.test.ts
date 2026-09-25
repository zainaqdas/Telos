import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk } from "../src/providers/types.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { FailureLearner, classifyRootCause } from "../src/memory/pipeline.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { registerShellTools } from "../src/tools/shell-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import { reduce } from "../src/events/state.ts";
import type { SynergonConfig } from "../src/config/schema.ts";

// ─── Store basics ─────────────────────────────────────────────────────────────

test("store appends JSONL, dedups on key, persists across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mem-"));
  try {
    const s1 = new MemoryStore(dir);
    assert.equal(s1.add({ type: "user_rule", key: "no tailwind", statement: "Do not use tailwind.", source: "user_instruction", verified: true }), true);
    assert.equal(s1.add({ type: "user_rule", key: "no tailwind", statement: "Do not use tailwind.", source: "user_instruction", verified: true }), false, "duplicate should dedup");

    // Fresh instance reads the same file — persistence.
    const s2 = new MemoryStore(dir);
    assert.equal(s2.all("user_rule").length, 1);
    assert.equal(s2.all("user_rule")[0]?.statement, "Do not use tailwind.");
    assert.ok(existsSync(join(dir, ".project-agent", "memory", "user-rules.jsonl")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retrieval is trust-ordered, topic-gated, and capped", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mem2-"));
  try {
    const s = new MemoryStore(dir);
    s.add({ type: "fact", key: "ts strict", statement: "The repo uses strict TypeScript.", source: "context", verified: true });
    s.add({ type: "lesson", key: "run_shell:npm run dev", statement: "Before running `npm run dev`, check for an existing server on port 3000.", cause: "port in use", correction: "reuse or kill the existing process", source: "failure_pipeline", verified: true });
    s.add({ type: "rejected_approach", key: "tailwind", statement: "Rejected approach: tailwind", reason: "user prefers plain css", source: "user", verified: true });
    s.add({ type: "user_rule", key: "plain css", statement: "Use plain CSS, not frameworks.", source: "user_instruction", verified: true });

    // Topic "css" should surface user_rule (trust 0) before rejected (trust 5), and skip the server lesson.
    const hits = s.query("styling with css", ["user_rule", "lesson", "rejected_approach", "fact"], 5);
    assert.equal(hits[0]?.type, "user_rule");
    assert.ok(hits.some((h) => h.type === "rejected_approach" && h.key === "tailwind"));
    assert.ok(!hits.some((h) => h.key === "run_shell:npm run dev"));

    // Cap works.
    const capped = s.query("css styling tailwind server dev", ["user_rule", "lesson", "rejected_approach", "fact"], 2);
    assert.equal(capped.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Failure learning pipeline ────────────────────────────────────────────────

test("root-cause classification is deterministic and specific", () => {
  const p1 = classifyRootCause("port_in_use", "EADDRINUSE: address already in use :::3000");
  assert.match(p1.cause, /already occupied/);
  assert.match(p1.correction, /terminate the existing process/);
  const p2 = classifyRootCause("mystery", "weird crash");
  assert.match(p2.cause, /not yet classified/);
});

test("first failure records; recurrence promotes to verified lesson", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mem3-"));
  try {
    const learner = new FailureLearner(new MemoryStore(dir));

    const l1 = learner.recordFailure({ tool: "run_shell", category: "port_in_use", observation: "EADDRINUSE :3000", target: "npm run dev" });
    assert.equal(l1, null, "first occurrence must not promote");
    assert.equal(new MemoryStore(dir).all("failure").length, 1);

    const l2 = learner.recordFailure({ tool: "run_shell", category: "port_in_use", observation: "EADDRINUSE :3000", target: "npm run dev" });
    assert.ok(l2, "recurrence must promote");
    assert.match(l2!.statement, /Before running `npm run dev`/);
    assert.match(l2!.correction, /terminate the existing process/);

    // Lesson is persisted and verified.
    const s = new MemoryStore(dir);
    const lessons = s.all("lesson");
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0]?.verified, true);
    assert.equal(lessons[0]?.key, "run_shell:npm run dev");

    // Formatting for context.
    const text = learner.formatForContext(learner.retrieveFor("npm run dev keeps failing with port in use"));
    assert.match(text, /LESSON \(run_shell:npm run dev\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejections and user rules are recorded and retrievable", () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mem4-"));
  try {
    const learner = new FailureLearner(new MemoryStore(dir));
    learner.recordRejection("JWT authentication", "existing architecture depends on session cookies", "requirements change");
    learner.recordUserRule("Use plain CSS.");

    const hits = learner.retrieveFor("should we add jwt authentication for the api?");
    assert.ok(hits.some((h) => h.type === "rejected_approach" && h.key === "JWT authentication"));
    const text = learner.formatForContext(hits);
    assert.match(text, /REJECTED: JWT authentication/);
    assert.match(text, /Do not resurrect without new justification/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Loop integration ─────────────────────────────────────────────────────────

class FakeProvider implements Provider {
  readonly name = "fake";
  private turn = 0;
  private readonly turns: Array<Array<StreamChunk>>;
  constructor(turns: Array<Array<StreamChunk>>) {
    this.turns = turns;
  }
  capabilities() {
    return { supportsTools: true, supportsVision: false, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 10_000 };
  }
  async *stream(_req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    const chunks = this.turns[Math.min(this.turn, this.turns.length - 1)]!;
    this.turn += 1;
    for (const c of chunks) yield c;
  }
}

function fakeConfig(): SynergonConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 200_000, maxToolCalls: 10, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 15, maxStreamAttempts: 2, minTestCount: 1, streamTimeoutSeconds: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

function harness(dir: string, learner: FailureLearner, turns: Array<Array<StreamChunk>>): ManagerLoop {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });
  const events = new EventLog(join(dir, "ev"), "t");
  events.append("task_started", { title: "x" });
  return new ManagerLoop({
    provider: new FakeProvider(turns),
    model: "fake-1",
    config: fakeConfig(),
    registry,
    events,
    budget: new BudgetEnforcer({ maxTotalTokens: 200_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
    cancellation,
    ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
    gate: new CompletionGate(() => events.readAll()),
    learner,
  });
}

test("loop: corrections become user rules + rejection memory (propagation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mem5-"));
  try {
    const learner = new FailureLearner(new MemoryStore(dir));
    const loop = harness(dir, learner, [[{ type: "text_delta", text: "Understood, plain CSS it is." }]]);
    await loop.run("CORRECTION: do not use tailwind, use plain CSS", { isCorrection: true });

    const store = learner.store;
    assert.ok(store.all("rejected_approach").some((r) => r.key === "tailwind"));
    assert.ok(store.all("user_rule").some((r) => /plain CSS/i.test(r.statement) || /tailwind/i.test(r.statement)));
    // Reducer also records the correction on the event stream.
    const events = new EventLog(join(dir, "ev"), "t");
    const state = reduce(events.readAll());
    assert.equal(state.instructions.at(-1)?.isCorrection, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop: repeated tool failure across runs promotes a verified lesson", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mem6-"));
  try {
    writeFileSync(join(dir, "server.js"), "// server\n", "utf8");
    const learner = new FailureLearner(new MemoryStore(dir));
    const failTurn: Array<StreamChunk> = [
      { type: "tool_call_delta", toolCall: { id: "c1", name: "run_shell", argumentsJson: JSON.stringify({ command: "npm run dev" }) } },
      { type: "text_delta", text: "Trying to start the server." },
    ];
    const loop1 = harness(dir, learner, [failTurn, [{ type: "text_delta", text: "Failed." }]]);
    await loop1.run("start the dev server");
    assert.equal(learner.store.all("lesson").length, 0, "no lesson on first occurrence");

    const loop2 = harness(dir, learner, [failTurn, [{ type: "text_delta", text: "Failed again." }]]);
    await loop2.run("start the dev server again");
    const lessons = learner.store.all("lesson");
    assert.equal(lessons.length, 1, "recurrence promotes");
    assert.match(lessons[0]!.key, /run_shell:npm run dev/);

    // lesson_verified event recorded.
    const events = new EventLog(join(dir, "ev"), "t");
    assert.ok(events.readAll().some((e) => e.kind === "lesson_verified"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loop: memory relevant to the instruction is injected into the transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-mem7-"));
  try {
    const learner = new FailureLearner(new MemoryStore(dir));
    learner.recordUserRule("Use plain CSS, never Tailwind.");
    learner.recordRejection("tailwind", "user rule");
    const loop = harness(dir, learner, [[{ type: "text_delta", text: "Noted." }]]);
    await loop.run("add some styling with tailwind to the page");
    const injected = loop["messages"].filter((m) => m.role === "system").map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
    const joined = injected.join("\n");
    assert.match(joined, /PROJECT MEMORY/);
    assert.match(joined, /REJECTED: tailwind/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
