import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { STEERING_MARK, markSteering, partitionSteering } from "../src/manager/steering.ts";
import { buildSystemPrompt } from "../src/manager/system-prompt.ts";
import type { TelosConfig } from "../src/config/schema.ts";

/** Mid-turn steering precedence: the user's newest word wins (runtime rule). */

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

class FakeProvider implements Provider {
  readonly name = "fake";
  requests: Array<GenerateRequest> = [];
  private turn = 0;
  private readonly turns: Array<Array<StreamChunk>>;
  constructor(turns: Array<Array<StreamChunk>>) {
    this.turns = turns;
  }
  capabilities(): import("../src/providers/types.ts").Capabilities {
    return { supportsTools: "supported", supportsVision: "unsupported", supportsStreaming: "supported", supportsStructuredOutput: "unsupported", contextLimit: 10_000 };
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

test("markSteering wraps lines in the deterministic precedence marker", () => {
  const marked = markSteering("also run extra4");
  assert.ok(marked.startsWith(STEERING_MARK));
  assert.ok(marked.endsWith("also run extra4"));
  // Deliberately non-adversarial wording: aligned models (observed live on
  // deepseek-family) refuse imperative "OVERRIDES EVERYTHING" markers as a
  // prompt-injection attempt; the marker instead states what it is.
  assert.match(marked, /Live message from the user/);
  assert.match(marked, /newest instruction/);
});

test("partitionSteering: plain lines steer, slash commands defer", () => {
  const { steer, deferred } = partitionSteering(["run extra too", "/undo", "/status now", "and this"]);
  assert.deepEqual(steer, ["run extra too", "and this"]);
  assert.deepEqual(deferred, ["/undo", "/status now"]);
});

test("system prompt documents the steering precedence rule", () => {
  assert.match(buildSystemPrompt(fakeConfig()), /\[STEERING\] Live message from the user/);
  assert.match(buildSystemPrompt(fakeConfig()), /user's newest instruction/);
});

test("injected steering lines carry the marker and the injection is event-logged", async () => {
  const provider = new FakeProvider([
    [callChunk("c1", "read_file", JSON.stringify({ path: "p1.txt" }))],
    [textChunk("done")],
  ]);
  const dir = mkdtempSync(join(tmpdir(), "telos-steer-"));
  try {
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const events = new EventLog(join(dir, "ev"), "t");
    events.append("task_started", { title: "x", limits: { max_total_tokens: 200000, max_tool_calls: 20, max_worker_spawns: 0, max_parallel_workers: 0, max_wall_time_seconds: 60 } });
    let polled = false;
    const loop = new ManagerLoop({
      provider, model: "fake-1", config: fakeConfig(), registry, events,
      budget: new BudgetEnforcer({ maxTotalTokens: 200_000, maxToolCalls: 20, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 }),
      cancellation: new CancellationController(), ctx: makeContext(dir, { shellTimeoutSeconds: 15 }),
      gate: new CompletionGate(() => events.readAll()),
      steering: {
        drain: () => {
          if (polled) return [];
          polled = true;
          return ["user typed this mid-run"];
        },
      },
    });
    await loop.run("original instruction");
    assert.ok(polled, "steering queue was drained at the tool boundary");

    // Second request must contain the marked steering line as a user message.
    const turn2 = provider.requests[1]!;
    const last = turn2.messages[turn2.messages.length - 1]!;
    assert.equal(last.role, "user");
    const body = last.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    assert.ok(body.startsWith(STEERING_MARK), `marked line expected, got: ${body.slice(0, 120)}`);
    assert.ok(body.endsWith("user typed this mid-run"));

    // Injection visible in the event log.
    const notices = events.readAll().filter((e) => e.kind === "task_updated").map((e) => String(e.data["notice"] ?? ""));
    assert.ok(notices.some((n) => /steering: 1 line\(s\) injected mid-run/.test(n)), notices.join(" | "));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
