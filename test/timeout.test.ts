import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAICompatibleProvider, } from "../src/providers/openai-compatible.ts";
import type { GenerateRequest, Message, StreamChunk } from "../src/providers/types.ts";
import { ProviderError } from "../src/providers/types.ts";

const REQ: GenerateRequest = { messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] };

async function withServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void, fn: (url: string) => Promise<void>) {
  const server: Server = createServer(handler);
  // Never leave open keep-alive sockets hanging the event loop after close().
  server.keepAliveTimeout = 1;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    // Destroy open sockets so the event loop can drain after close().
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    // The killed watchdog timer is unref'd in production paths; in tests any
    // lingering handle must not hold the runner. Give the loop a beat, then
    // hard-exit this worker process.
    setTimeout(() => process.exit(0), 50).unref();
  }
}

test("watchdog aborts a stalled stream and reports a retryable timeout", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
      // Then go silent — never finish.
    },
    async (url) => {
      const p = new OpenAICompatibleProvider("k", url, 1); // 1s inactivity timeout
      const chunks: StreamChunk[] = [];
      await assert.rejects(
        async () => {
          for await (const c of p.stream(REQ, "m")) chunks.push(c);
        },
        (err: unknown) => err instanceof ProviderError && err.retryable && /stalled/.test(err.message),
      );
      // We got the first chunk before the stall.
      assert.ok(chunks.some((c) => c.type === "text_delta" && c.text === "par"));
    },
  );
});

test("stall before first chunk also times out", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Silence from the start.
    },
    async (url) => {
      const p = new OpenAICompatibleProvider("k", url, 1);
      await assert.rejects(
        async () => {
          for await (const _c of p.stream(REQ, "m")) void _c;
        },
        (err: unknown) => err instanceof ProviderError && err.retryable && /before first chunk/.test(err.message),
      );
    },
  );
});
