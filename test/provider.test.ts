import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { addUsage, emptyUsage } from "../src/providers/types.ts";

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, fn: (url: string) => Promise<void>) {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("usage accounting keeps cost null until reported and sums correctly", () => {
  const a = emptyUsage();
  const b = { ...emptyUsage(), inputTokens: 10, outputTokens: 5, totalTokens: 15, modelCalls: 1 };
  const sum = addUsage(a, b);
  assert.equal(sum.totalTokens, 15);
  assert.equal(sum.costUsd, null); // never invented

  const withCost = { ...b, costUsd: 0.02 };
  const sum2 = addUsage(withCost, withCost);
  assert.equal(sum2.costUsd, 0.04);
});

test("streaming provider parses text, tool calls, usage from SSE", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\": \\"a.ts\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: {"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46,"prompt_tokens_details":{"cached_tokens":4}}}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n";

  await withServer(
    (req, res) => {
      assert.equal(req.url, "/chat/completions");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    },
    async (url) => {
      const p = new OpenAICompatibleProvider("test-key", url);
      const chunks = [];
      for await (const c of p.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }, "test-model")) {
        chunks.push(c);
      }
      const text = chunks.filter((c) => c.type === "text_delta").map((c) => c.text).join("");
      assert.equal(text, "Hello");
      const toolCall = chunks.find((c) => c.type === "tool_call_delta")?.toolCall;
      assert.equal(toolCall?.name, "read_");
      assert.equal(toolCall?.argumentsJson, '{"path": "a.ts"}');
      const usage = chunks.find((c) => c.type === "usage")?.usage;
      assert.equal(usage?.totalTokens, 46);
      assert.equal(usage?.cachedTokens, 4);
      assert.equal(usage?.costUsd, null);
      assert.ok(chunks.some((c) => c.type === "finish" && c.stopReason === "tool_calls"));
    },
  );
});

test("provider errors surface HTTP status and retryability", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":{"message":"slow down"}}');
    },
    async (url) => {
      const p = new OpenAICompatibleProvider("k", url);
      await assert.rejects(
        () => {
          const it = p.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }] }, "m")[Symbol.asyncIterator]();
          return it.next();
        },
        (err: unknown) => err instanceof Error && (err as { status?: number }).status === 429 && (err as { retryable?: boolean }).retryable === true,
      );
    },
  );
});

test("SSE final data line without trailing newline is not dropped (tail flush)", async () => {
  // Regression: servers that end the body without a newline lost their last
  // data line — the classic truncated-tool-arguments failure.
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"write_file","arguments":"{\\"path\\": \\"s.html\\", \\"content\\": \\"<html>"}}]}}]}\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n' +
    'data: {"usage":{"prompt_tokens":5,"completion_tokens":9,"total_tokens":14}}'; // no trailing \n
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    },
    async (url) => {
      const p = new OpenAICompatibleProvider("k", url);
      const chunks = [];
      for await (const c of p.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }, "m")) {
        chunks.push(c);
      }
      const usage = chunks.find((c) => c.type === "usage")?.usage;
      assert.ok(usage, "final usage line without trailing newline must be parsed");
      assert.equal(usage?.totalTokens, 14);
      assert.ok(chunks.some((c) => c.type === "finish" && c.stopReason === "tool_calls"));
    },
  );
});

test("reasoning_content deltas surface as thinking_delta chunks", async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"Let me think step by step"}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":" about the layout."}}]}',
    'data: {"choices":[{"delta":{"content":"Here is the plan."}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ].join("\n\n") + "\n\n";
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
    },
    async (url) => {
      const p = new OpenAICompatibleProvider("k", url);
      const chunks = [];
      for await (const c of p.stream({ messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] }, "m")) {
        chunks.push(c);
      }
      const thinking = chunks.filter((c) => c.type === "thinking_delta").map((c) => c.text).join("");
      assert.equal(thinking, "Let me think step by step about the layout.");
      const text = chunks.filter((c) => c.type === "text_delta").map((c) => c.text).join("");
      assert.equal(text, "Here is the plan.");
    },
  );
});
