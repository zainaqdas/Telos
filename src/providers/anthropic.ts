import {
  type Capabilities,
  type GenerateRequest,
  ProviderError,
  type Provider,
  type StreamChunk,
  type ToolCall,
} from "./types.ts";

/**
 * Native Anthropic provider (spec Phase 9 / Part 52). The Messages API is not
 * OpenAI-shaped: system is a top-level parameter, tool results travel inside
 * user messages as tool_result blocks, tool calls are tool_use content
 * blocks, and usage uses input_tokens/output_tokens with cache read/write
 * token fields. SSE events arrive as typed deltas (content_block_delta etc.).
 *
 * Capabilities are honest per model family: Claude 3+ supports tools, vision,
 * and streaming; structured output is emulated by prompting, not native.
 */

const ANTHROPIC_VERSION = "2023-06-01";

interface EncoderDeps {
  signal?: AbortSignal;
  maxTokens: number;
  temperature: number;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  /** Seconds of stream inactivity before aborting (0 disables). */
  private readonly streamTimeoutSeconds: number;

  constructor(apiKey: string, baseUrl: string, streamTimeoutSeconds = 120) {
    this.streamTimeoutSeconds = streamTimeoutSeconds;
    this.apiKey = apiKey;
    // Default to the real API; tests/local proxies override via base_url.
    this.baseUrl = baseUrl || "https://api.anthropic.com/v1";
  }

  capabilities(model: string): Capabilities {
    const m = model.toLowerCase();
    // Anthropic family defaults (P1: provider default + model honesty). All
    // Claude 3+/4.x models are tool- and streaming-capable, and vision is
    // family-wide — but an UNKNOWN model string gets `unknown` rather than
    // an invented guarantee; only recognized families assert support.
    const knownClaude = /claude/.test(m);
    const claude3Plus = /claude-(?:3|4|opus|sonnet|haiku)/.test(m);
    return {
      supportsTools: knownClaude ? "supported" : "unknown",
      supportsVision: claude3Plus ? "supported" : knownClaude ? "unknown" : "unknown",
      supportsStreaming: knownClaude ? "supported" : "unknown",
      supportsStructuredOutput: "unsupported",
      contextLimit: 200_000,
    };
  }

  async *stream(req: GenerateRequest, model: string): AsyncIterable<StreamChunk> {
    // Request-local usage state (P0): input/cache tokens arrive on
    // message_start and are consumed on message_delta. These MUST live in
    // the stream() frame, not on the provider instance — the same provider
    // object serves concurrent streams (manager + workers, parallel
    // delegations) and instance fields cross-contaminate their usage.
    let pendingInputTokens = 0;
    let pendingCachedTokens = 0;
    const body = encodeRequest(req, model, {
      signal: req.signal,
      maxTokens: req.maxTokens ?? 4096,
      temperature: req.temperature ?? 0,
    });

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) onExternalAbort();
      else req.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let sawAnyChunk = false;
    const armWatchdog = (): void => {
      if (this.streamTimeoutSeconds <= 0) return;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* already aborted */
        }
      }, this.streamTimeoutSeconds * 1000);
      if (typeof watchdog.unref === "function") watchdog.unref();
    };

    try {
      const res = await fetch(joinUrl(this.baseUrl, "/messages"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderError(`anthropic HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
      }

      // Tool-use assembly: content_block_start opens a tool_use block,
      // input_json_deltas accumulate its arguments, content_block_stop closes.
      const toolBlocks = new Map<number, { id: string; name: string; args: string }>();
      let stopReason = "";
      let finished = false;

      for await (const payload of sseEvents(res.body, controller.signal)) {
        sawAnyChunk = true;
        armWatchdog();
        if (payload === "[DONE]") {
          finished = true;
          break;
        }
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = String(ev["type"] ?? "");

        if (type === "content_block_start") {
          const block = (ev["content_block"] ?? {}) as Record<string, unknown>;
          if (block["type"] === "tool_use") {
            toolBlocks.set(Number(ev["index"] ?? 0), {
              id: String(block["id"] ?? ""),
              name: String(block["name"] ?? ""),
              args: "",
            });
          }
        } else if (type === "content_block_delta") {
          const delta = (ev["delta"] ?? {}) as Record<string, unknown>;
          if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
            yield { type: "text_delta", text: delta["text"] };
          } else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
            const slot = toolBlocks.get(Number(ev["index"] ?? 0));
            if (slot) slot.args += delta["partial_json"];
          }
        } else if (type === "content_block_stop") {
          const slot = toolBlocks.get(Number(ev["index"] ?? 0));
          if (slot && slot.name) {
            const call: ToolCall = { id: slot.id || `toolu_${slot.name}`, name: slot.name, argumentsJson: slot.args || "{}" };
            yield { type: "tool_call_delta", toolCall: call };
            toolBlocks.delete(Number(ev["index"] ?? 0));
          }
        } else if (type === "message_delta") {
          const delta = (ev["delta"] ?? {}) as Record<string, unknown>;
          if (typeof delta["stop_reason"] === "string") stopReason = delta["stop_reason"];
          const usage = (ev["usage"] ?? {}) as Record<string, unknown>;
          if (usage["output_tokens"] !== undefined) {
            // Final usage arrives here; input_tokens came on message_start.
            // We emit the combined figure from the stored input count.
            yield {
              type: "usage",
              usage: {
                inputTokens: pendingInputTokens,
                outputTokens: numberOr(usage["output_tokens"], 0),
                cachedTokens: pendingCachedTokens,
                totalTokens: pendingInputTokens + numberOr(usage["output_tokens"], 0),
                modelCalls: 1,
                toolCalls: 0,
                costUsd: null,
              },
            };
          }
        } else if (type === "message_start") {
          const message = (ev["message"] ?? {}) as Record<string, unknown>;
          const usage = (message["usage"] ?? {}) as Record<string, unknown>;
          pendingInputTokens = numberOr(usage["input_tokens"], 0);
          pendingCachedTokens = numberOr(usage["cache_read_input_tokens"], 0);
        } else if (type === "error") {
          const err = (ev["error"] ?? {}) as Record<string, unknown>;
          throw new ProviderError(`anthropic stream error: ${String(err["message"] ?? type)}`, undefined, true);
        } else if (type === "message_stop") {
          finished = true;
          break;
        }
      }
      if (!finished) yield { type: "finish", stopReason: stopReason || "stream_end" };
      else yield { type: "finish", stopReason: stopReason || "stop" };
    } catch (err) {
      if (req.signal?.aborted) throw err;
      const isWatchdogAbort = controller.signal.aborted && !req.signal?.aborted;
      if (isWatchdogAbort) {
        throw new ProviderError(
          `anthropic stream stalled: no data for ${this.streamTimeoutSeconds}s${sawAnyChunk ? " (mid-stream)" : " before first chunk"}`,
          undefined,
          true,
        );
      }
      throw err;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      if (req.signal) req.signal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// ─── Request encoding (our normalized model → Anthropic shape) ──────────────

export function encodeRequest(req: GenerateRequest, model: string, opts: EncoderDeps): Record<string, unknown> {
  let system = "";
  const turns: Array<Record<string, unknown>> = [];

  for (const m of req.messages) {
    if (m.role === "system") {
      system += m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
      continue;
    }
    if (m.role === "tool") {
      // Tool results are user-turn tool_result blocks (Anthropic shape).
      turns.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
      }
      for (const tc of m.toolCalls ?? []) {
        let input: unknown = {};
        try {
          input = tc.argumentsJson.trim() ? JSON.parse(tc.argumentsJson) : {};
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
      }
      turns.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
      continue;
    }
    // user: text + images as source blocks
    const content: Array<Record<string, unknown>> = [];
    for (const p of m.parts) {
      if (p.type === "text") content.push({ type: "text", text: p.text });
      else if (p.type === "image") {
        content.push({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } });
      }
    }
    if (content.length) turns.push({ role: "user", content });
  }

  return {
    model,
    system: system || undefined,
    messages: turns,
    tools: req.tools?.length
      ? req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      : undefined,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    stream: true,
  };
}

// ─── SSE parsing (shared shape with the OpenAI path, Anthropic event names) ──

async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new ProviderError("aborted", undefined, false);
      const readPromise = reader.read();
      const result = signal ? await Promise.race([readPromise, abortPromise(signal)]) : await readPromise;
      if (!result) {
        void readPromise.catch(() => undefined);
        try {
          await reader.cancel();
        } catch {
          /* socket already gone */
        }
        throw new ProviderError("aborted", undefined, false);
      }
      const { done, value } = result;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function abortPromise(signal: AbortSignal): Promise<null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(null);
    if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    } else {
      const timer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(timer);
          resolve(null);
        }
      }, 100);
    }
  });
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b + path;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
