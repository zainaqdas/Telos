import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * End-to-end acceptance: the real CLI session (raw stdin line mode, event log,
 * budget bar, manager loop, provider streaming, gate) against a local
 * OpenAI-compatible mock. No external network.
 */

test("e2e: chat session completes a read-only instruction via mock provider", async () => {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/chat/completions") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { messages: Array<{ role: string }> };
        const hasUserMsg = parsed.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("read sample.txt"));
        assert.ok(hasUserMsg, "session must send the user instruction to the provider");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          [
            'data: {"choices":[{"delta":{"content":"The file "}}]}',
            'data: {"choices":[{"delta":{"content":"contains a "}}]}',
            'data: {"choices":[{"delta":{"content":"greeting."}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}',
            "data: [DONE]",
          ].join("\n\n") + "\n\n",
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const dir = mkdtempSync(join(tmpdir(), "syn-e2e-"));
  writeFileSync(join(dir, "sample.txt"), "hello world\n", "utf8");

  const child: ChildProcess = spawn(process.execPath, [join(process.cwd(), "src", "index.ts"), "chat"], {
    cwd: dir,
    env: {
      ...process.env,
      SYNERGON_PROVIDER: "openai",
      SYNERGON_MODEL: "mock-1",
      SYNERGON_BASE_URL: `http://127.0.0.1:${port}`,
      OPENAI_API_KEY: "sk-test-key-not-real-000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));

  try {
    // Wait for the prompt, then send the instruction.
    await waitFor(() => stdout.includes(">"), 5000);
    child.stdin!.write("read sample.txt and summarize\n");

    const done = await waitFor(() => stdout.includes("[completed"), 10_000);      assert.ok(done, `session did not reach completed state. stdout:\n${stdout}\nstderr:\n${stderr}`);
      // Deltas must stream contiguously: word-boundary wrapped for non-TTY,
      // never one-line-per-chunk.
      assert.match(stdout, /The file contains a greeting\./);
    assert.match(stdout, /Gate: COMPLETE/);
    assert.match(stdout, /budget: tokens 18\/80000/);
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((r) => child.on("exit", () => r()));
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}
