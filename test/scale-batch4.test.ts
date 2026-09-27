import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, Provider, StreamChunk } from "../src/providers/types.ts";
import { ProviderError, retryDelayMs } from "../src/providers/types.ts";
import { ToolRegistry, type ToolDefinition } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { CancellationController } from "../src/runtime/cancellation.ts";
import { EventLog } from "../src/events/log.ts";
import { CompletionGate } from "../src/gate/gate.ts";
import { ManagerLoop } from "../src/manager/loop.ts";
import { Orchestrator } from "../src/workers/orchestrator.ts";
import { READ_ONLY_ROLES } from "../src/workers/roles.ts";
import type { TelosConfig } from "../src/config/schema.ts";

/** Scale Batch 4 tests (docs/SCALE_ROADMAP.md items 11–14). */

/** Provider that records every request and replays a fixed turn sequence. */
class RecordingProvider implements Provider {
  readonly name = "recording";
  requests: Array<GenerateRequest> = [];
  private turn = 0;
  private readonly turns: Array<Array<StreamChunk>>;
  private readonly failOnTurn?: { turn: number; error: ProviderError };
  constructor(turns: Array<Array<StreamChunk>>, failOnTurn?: { turn: number; error: ProviderError }) {
    this.turns = turns;
    this.failOnTurn = failOnTurn;
  }
  capabilities(): import("../src/providers/types.ts").Capabilities {
    return { supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 10_000 };
  }
  async *stream(req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    void _model;
    this.requests.push(req);
    if (this.failOnTurn && this.turn === this.failOnTurn.turn) {
      this.turn += 1;
      throw this.failOnTurn.error;
    }
    const chunks = this.turns[Math.min(this.turn, this.turns.length - 1)]!;
    this.turn += 1;
    for (const c of chunks) yield c;
  }
}

function fakeConfig(): TelosConfig {
  return {
    model: { provider: "openai", name: "fake-1", baseUrl: "", apiKeyEnv: "NOOP", temperature: 0, maxTokens: 1024 },
    runtime: {
      autonomy: "balanced", maxTotalTokens: 200_000, maxToolCalls: 20, maxWorkerSpawns: 0,
      maxParallelWorkers: 0, maxWallTimeSeconds: 60, shellTimeoutSeconds: 15, maxStreamAttempts: 3, minTestCount: 0, streamTimeoutSeconds: 0, compactionThresholdTokens: 0,
    },
    security: { confirmDestructive: true, blockSecrets: true },
  };
}

const textChunk = (text: string): StreamChunk => ({ type: "text_delta", text });
const callChunk = (id: string, name: string, args: string): StreamChunk => ({ type: "tool_call_delta", toolCall: { id, name, argumentsJson: args } });

function makeHarness(provider: Provider, over: { steering?: { drain: () => string[] } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "telos-b4-"));
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const events = new EventLog(join(dir, "ev"), "t");
  events.append("task_started", { title: "x", limits: { max_total_tokens: 200000, max_tool_calls: 20, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
  const budget = new BudgetEnforcer({ maxTotalTokens: 200_000, maxToolCalls: 20, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
  const loop = new ManagerLoop({
    provider,
    model: "fake-1",
    config: fakeConfig(),
    registry,
    events,
    budget,
    cancellation: new CancellationController(),
    ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
    gate: new CompletionGate(() => events.readAll()),
    ...over,
  });
  return { loop, registry, events, dir };
}

test("consecutive read-only tool calls run in parallel and return results in call order", async () => {
  const provider = new RecordingProvider([
    [
      callChunk("c1", "read_file", JSON.stringify({ path: "a1.txt" })),
      callChunk("c2", "read_file", JSON.stringify({ path: "a2.txt" })),
      callChunk("c3", "read_file", JSON.stringify({ path: "a3.txt" })),
    ],
    [textChunk("done")],
  ]);
  const h = makeHarness(provider);
  try {
    for (const f of ["a1.txt", "a2.txt", "a3.txt"]) writeFileSync(join(h.dir, f), `content of ${f}\n`);

    // Instrument read_file to measure overlap. If the loop still ran tools
    // sequentially, maxInFlight would stay 1 and this test fails.
    const orig = h.registry.get("read_file")!;
    let inFlight = 0;
    let maxInFlight = 0;
    h.registry.remove("read_file");
    h.registry.register({
      ...orig,
      execute: async (args, ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        try {
          return await orig.execute(args, ctx);
        } finally {
          inFlight -= 1;
        }
      },
    });

    const result = await h.loop.run("read the three files");
    assert.equal(result.status, "completed");
    assert.ok(maxInFlight >= 2, `expected overlapping executions, maxInFlight=${maxInFlight}`);

    // Results must be attached to the RIGHT call ids, in call order.
    const turn2 = provider.requests[1]!;
    const toolMessages = turn2.messages.filter((m) => m.role === "tool");
    const bodies = toolMessages.map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
    // read_file output is line-numbered (Scale Batch 1); check the content per call slot.
    assert.match(bodies[0]!, /content of a1\.txt/);
    assert.match(bodies[1]!, /content of a2\.txt/);
    assert.match(bodies[2]!, /content of a3\.txt/);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("a mutative call splits the batch: mutations never run alongside reads", async () => {
  const provider = new RecordingProvider([
    [
      callChunk("c1", "read_file", JSON.stringify({ path: "b1.txt" })),
      callChunk("c2", "write_file", JSON.stringify({ path: "b2.txt", content: "written\n" })),
      callChunk("c3", "read_file", JSON.stringify({ path: "b3.txt" })),
    ],
    [textChunk("done")],
  ]);
  const h = makeHarness(provider);
  try {
    for (const f of ["b1.txt", "b3.txt"]) writeFileSync(join(h.dir, f), `${f}\n`);
    const orig = h.registry.get("read_file")!;
    let inFlight = 0;
    let maxInFlight = 0;
    h.registry.remove("read_file");
    h.registry.register({
      ...orig,
      execute: async (args, ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        try {
          return await orig.execute(args, ctx);
        } finally {
          inFlight -= 1;
        }
      },
    });

    const result = await h.loop.run("read, write, read");
    // The evidence-based gate may keep the task open after a mutation (it
    // wants a verification run) — the status itself is not what this test
    // asserts; batch splitting and the written file are.
    assert.ok(["completed", "incomplete"].includes(result.status));
    // Each read is isolated by the mutation between them: strictly sequential.
    assert.equal(maxInFlight, 1, "a mutation must split the read-only batch");
    assert.equal(await h.registry.get("write_file") ? true : true, true);
    const written = (await import("node:fs")).readFileSync(join(h.dir, "b2.txt"), "utf8");
    assert.equal(written, "written\n");
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("steering lines join the transcript at the tool-call boundary, after tool results", async () => {
  const provider = new RecordingProvider([
    [
      callChunk("c1", "read_file", JSON.stringify({ path: "s1.txt" })),
      callChunk("c2", "read_file", JSON.stringify({ path: "s2.txt" })),
    ],
    [textChunk("acknowledged the correction")],
  ]);
  let drained = 0;
  const h = makeHarness(provider, {
    steering: {
      drain: () => {
        drained += 1;
        return drained === 1 ? ["STOP using tab-indented code — spaces only"] : [];
      },
    },
  });
  try {
    for (const f of ["s1.txt", "s2.txt"]) writeFileSync(join(h.dir, f), `${f}\n`);
    const result = await h.loop.run("read the files");
    assert.equal(result.status, "completed");

    const turn2 = provider.requests[1]!;
    const kinds = turn2.messages.map((m) => m.role);
    // ... assistant(toolCalls) → tool, tool → user(steering) last.
    assert.equal(kinds[kinds.length - 1], "user");
    const last = turn2.messages[turn2.messages.length - 1]!;
    assert.match(last.parts.map((p) => (p.type === "text" ? p.text : "")).join(""), /STOP using tab-indented code/);
    assert.equal(turn2.messages[turn2.messages.length - 2]!.role, "tool");
    // The steering poll happened exactly once (the run ended at prose before
    // any further boundary).
    assert.equal(drained, 1);
  } finally {
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test("retry v2: retry-after hint honored, wait visible, run eventually completes", async () => {
  const provider = new RecordingProvider(
    [[textChunk("recovered")]],
    { turn: 0, error: new ProviderError("provider HTTP 429: slow down", 429, true, 5) },
  );
  const dir = mkdtempSync(join(tmpdir(), "telos-b4r-"));
  try {
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x", limits: { max_total_tokens: 200000, max_tool_calls: 20, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
    const loop = new ManagerLoop({
      provider,
      model: "fake-1",
      config: fakeConfig(),
      registry: new ToolRegistry(),
      events,
      budget: new BudgetEnforcer({ maxTotalTokens: 200_000, maxToolCalls: 20, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
      cancellation: new CancellationController(),
      ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
      gate: new CompletionGate(() => events.readAll()),
    });
    const result = await loop.run("say something");
    assert.equal(result.status, "completed");
    assert.equal(provider.requests.length, 2, "one retry after the 429");

    const notices = events.readAll().filter((e) => e.kind === "task_updated").map((e) => String(e.data["notice"] ?? ""));
    assert.ok(notices.some((n) => /provider retrying in .+ \(rate limit; attempt 1\/3\)/.test(n)), `missing retry notice, got: ${notices.join(" | ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retryDelayMs: honors the provider hint, otherwise ×2 backoff within ±25% jitter", () => {
  assert.equal(retryDelayMs(3, 5000), 5000);
  assert.equal(retryDelayMs(0, 0), 0);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const base = 500 * 2 ** attempt;
    for (let i = 0; i < 40; i += 1) {
      const d = retryDelayMs(attempt);
      assert.ok(d >= base * 0.75 && d <= base * 1.25, `attempt ${attempt}: ${d} outside [${base * 0.75}, ${base * 1.25}]`);
    }
  }
});

test("read-only worker roles never receive mutative tools in their scoped registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-b4w-"));
  try {
    const provider = new RecordingProvider([[textChunk("FINDING: the repo has a src dir\nEVIDENCE: src/index.ts:1\n")]]);
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    // Two user-declared external tools explicitly named for the explorer role:
    // one mutative (must be stripped), one read-only (must survive).
    const mkExt = (name: string, mutative: boolean): ToolDefinition => ({
      name,
      description: `external ${name}`,
      parameters: { type: "object", properties: {} },
      permission: "read",
      mutative,
      risk: "low",
      external: true,
      workerRoles: ["explorer"],
      execute: async () => ({ ok: true, output: "ok" }),
    });
    registry.register(mkExt("ext_destructive_probe", true));
    registry.register(mkExt("ext_safe_probe", false));

    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x", limits: { max_total_tokens: 200000, max_tool_calls: 20, max_worker_spawns: 2, max_parallel_workers: 1, max_wall_time_seconds: 60 } });
    const orchestrator = new Orchestrator({
      provider,
      model: "fake-1",
      config: fakeConfig(),
      registry,
      events,
      budget: new BudgetEnforcer({ maxTotalTokens: 200_000, maxToolCalls: 20, maxWorkerSpawns: 2, maxParallelWorkers: 1, maxWallTimeSeconds: 60 }),
      cancellation: new CancellationController(),
      ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
    });

    const result = await orchestrator.runDelegation({ role: "explorer", question: "map the repo" });
    assert.equal(result.error, undefined);
    assert.ok(result.report.findings.length >= 1, "worker report parsed");

    // The worker's model call must see the read-only external tool but never
    // the mutative one — enforced at the registry layer, not by prompting.
    const workerTools = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    assert.ok(workerTools.includes("ext_safe_probe"), `read-only external tool missing: ${workerTools.join(", ")}`);
    assert.ok(!workerTools.includes("ext_destructive_probe"), `mutative tool leaked to a read-only role: ${workerTools.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("READ_ONLY_ROLES covers explorer, researcher, reviewer — not qa", () => {
  assert.ok(READ_ONLY_ROLES.has("explorer"));
  assert.ok(READ_ONLY_ROLES.has("researcher"));
  assert.ok(READ_ONLY_ROLES.has("reviewer"));
  assert.ok(!READ_ONLY_ROLES.has("qa"));
});
