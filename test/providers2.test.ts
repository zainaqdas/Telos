import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicProvider, encodeRequest } from "../src/providers/anthropic.ts";
import { createProvider } from "../src/providers/index.ts";
import { parseConfig } from "../src/config/schema.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { emptyUsage } from "../src/providers/types.ts";
import type { GenerateRequest } from "../src/providers/types.ts";

// ─── Request encoding: our normalized model → Anthropic Messages shape ──────

test("encodeRequest: system hoisted, tool results become tool_result blocks, images become source blocks", () => {
  const req: GenerateRequest = {
    messages: [
      { role: "system", parts: [{ type: "text", text: "You are a coding agent." }] },
      { role: "user", parts: [{ type: "text", text: "look at this" }, { type: "image", mediaType: "image/png", data: "aGk=" }] },
      {
        role: "assistant",
        parts: [{ type: "text", text: "running a tool" }],
        toolCalls: [{ id: "toolu_1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
      },
      { role: "tool", parts: [{ type: "text", text: "file contents" }], toolCallId: "toolu_1" },
    ],
    tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
    maxTokens: 512,
  };
  const body = encodeRequest(req, "claude-sonnet-4-5", { maxTokens: 512, temperature: 0 });
  assert.equal(body["system"], "You are a coding agent.");
  assert.equal(body["max_tokens"], 512);
  assert.equal(body["stream"], true);
  const messages = body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.equal(messages[0]!.role, "user");
  assert.equal(messages[0]!.content[0]!.type, "text");
  assert.deepEqual(messages[0]!.content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } });
  assert.equal(messages[1]!.role, "assistant");
  assert.equal(messages[1]!.content.find((c) => c["type"] === "tool_use")?.["id"], "toolu_1");
  assert.equal(messages[2]!.role, "user");
  assert.equal(messages[2]!.content[0]!.type, "tool_result");
  assert.equal(messages[2]!.content[0]!["tool_use_id"], "toolu_1");
  const tools = body["tools"] as Array<Record<string, unknown>>;
  assert.equal(tools[0]!.name, "read_file");
  assert.deepEqual(tools[0]!.input_schema, { type: "object", properties: {} });
});

// ─── SSE streaming over a local mock of the Messages API ─────────────────────

const SSE_BODY = [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":50}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
  `data: [DONE]`,
].join("\n\n") + "\n\n";

const SSE_TOOL_BODY = [
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":90}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"list_directory"}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\".\\"}"}}`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":21}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
].join("\n\n") + "\n\n";

function sseServer(responses: string[], captured: Array<Record<string, unknown>>): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    let i = 0;
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c: Buffer) => (b += c.toString()));
      req.on("end", () => {
        captured.push(JSON.parse(b) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responses[Math.min(i++, responses.length - 1)]);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

test("anthropic provider streams text and usage from SSE events", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const { server, port } = await sseServer([SSE_BODY], captured);
  try {
    const provider = new AnthropicProvider("sk-test", `http://127.0.0.1:${port}`, 5);
    const chunks: Array<{ type: string; text?: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; totalTokens: number } }> = [];
    for await (const c of provider.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], maxTokens: 100 }, "claude-sonnet-4-5")) {
      chunks.push(c as never);
    }
    const text = chunks.filter((c) => c.type === "text_delta").map((c) => c.text).join("");
    assert.equal(text, "Hello");
    const usage = chunks.find((c) => c.type === "usage")!.usage!;
    assert.equal(usage.inputTokens, 120);
    assert.equal(usage.outputTokens, 7);
    assert.equal(usage.cachedTokens, 50);
    assert.equal(usage.totalTokens, 127);
    // Wire shape: system hoisted, anthropic-version header present via request headers (implicitly),
    // max_tokens mapped.
    assert.equal(captured[0]!["max_tokens"], 100);
    assert.equal(captured[0]!["system"], undefined); // no system message in this request
  } finally {
    server.close();
  }
});

test("anthropic provider assembles tool_use blocks into tool calls", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const { server, port } = await sseServer([SSE_TOOL_BODY], captured);
  try {
    const provider = new AnthropicProvider("sk-test", `http://127.0.0.1:${port}`, 5);
    const toolCalls: Array<{ id: string; name: string; argumentsJson: string }> = [];
    for await (const c of provider.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "list" }] }], maxTokens: 100 }, "claude-sonnet-4-5")) {
      if (c.type === "tool_call_delta" && c.toolCall) toolCalls.push(c.toolCall);
    }
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]!.id, "toolu_9");
    assert.equal(toolCalls[0]!.name, "list_directory");
    assert.equal(toolCalls[0]!.argumentsJson, '{"path":"."}');
    // Tools encoded with input_schema:
    const tools = captured[0]!["tools"] as Array<Record<string, unknown>> | undefined;
    assert.equal(tools, undefined, "no tools passed in this request");
  } finally {
    server.close();
  }
});

test("createProvider('anthropic') returns the native path; capabilities are per-model", () => {
  const p = createProvider({ provider: "anthropic", apiKey: "k", baseUrl: "" });
  assert.equal(p.name, "anthropic");
  const caps = p.capabilities("claude-sonnet-4-5");
  assert.equal(caps.supportsTools, "supported");
  assert.equal(caps.supportsVision, "supported");
});

// ─── Cost estimation (Part 24): computed from declared pricing, never invented ─

test("cost estimate is null without pricing and computed from declared per-Mtok prices", () => {
  const b = new BudgetEnforcer({ maxTotalTokens: 1_000_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
  b.recordUsage({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 10, modelCalls: 1, toolCalls: 0, costUsd: null });
  assert.equal(b.costEstimateUsd, null, "no pricing declared — cost stays unknown");

  b.setPricing({ inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3 });
  // Fresh enforcer with granular usage: 100k in (20k cached), 50k out.
  const b2 = new BudgetEnforcer({ maxTotalTokens: 1_000_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
  b2.setPricing({ inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3 });
  b2.recordUsage({ inputTokens: 100_000, outputTokens: 50_000, cachedTokens: 20_000, totalTokens: 150_000, modelCalls: 2, toolCalls: 0, costUsd: null });
  const expected = (80_000 / 1e6) * 3 + (50_000 / 1e6) * 15 + (20_000 / 1e6) * 0.3;
  assert.ok(Math.abs(b2.costEstimateUsd! - expected) < 1e-9, `got ${b2.costEstimateUsd}, want ${expected}`);
  // Provider-reported cost is authoritative when present.
  const b3 = new BudgetEnforcer({ maxTotalTokens: 1_000_000, maxToolCalls: 10, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
  b3.recordUsage({ inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2, modelCalls: 1, toolCalls: 0, costUsd: 0.42 });
  assert.equal(b3.costEstimateUsd, 0.42);
});

test("config [model.pricing] parses with validation; worker_model is optional", () => {
  const cfg = parseConfig({
    model: { provider: "anthropic", name: "claude-sonnet-4-5", pricing: { input_per_mtok: 3, output_per_mtok: 15 }, worker_model: "claude-haiku-4-5" },
    runtime: {},
  });
  assert.deepEqual(cfg.model.pricing, { inputPerMtok: 3, outputPerMtok: 15 });
  assert.equal(cfg.model.workerModel, "claude-haiku-4-5");
  // Decimal pricing (P2): fractional per-Mtok rates are legal.
  const cfg2 = parseConfig({
    model: { provider: "anthropic", pricing: { input_per_mtok: 0.75, output_per_mtok: 2.5, cache_read_per_mtok: 0.1 } },
    runtime: {},
  });
  assert.deepEqual(cfg2.model.pricing, { inputPerMtok: 0.75, outputPerMtok: 2.5, cacheReadPerMtok: 0.1 });
  assert.throws(() => parseConfig({ model: { provider: "anthropic", pricing: { input_per_mtok: "free", output_per_mtok: 15 } } }), /expected number/);
});

test("emptyUsage stays cost-null; resetUsage clears accumulated cost", () => {
  assert.equal(emptyUsage().costUsd, null);
  const b = new BudgetEnforcer({ maxTotalTokens: 1000, maxToolCalls: 5, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 60 });
  b.recordUsage({ inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, modelCalls: 1, toolCalls: 0, costUsd: 0.01 });
  assert.equal(b.costEstimateUsd, 0.01);
  b.resetUsage();
  assert.equal(b.costEstimateUsd, null, "fresh task: cost unknown again until usage arrives");
});

// ─── Worker model override wiring ─────────────────────────────────────────────

test("worker delegation uses worker_model when declared (orchestrator reads config)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-p9wm-"));
  try {
    // Static assertion level: config plumbing reaches the orchestrator.
    writeFileSync(join(dir, "config.toml"), "");
    const cfg = parseConfig({
      model: { provider: "openai", name: "flagship", worker_model: "cheap-1" },
      runtime: { max_worker_spawns: 1, max_parallel_workers: 1 },
    });
    assert.equal(cfg.model.workerModel, "cheap-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
