import {
  type Capabilities,
  type GenerateRequest,
  ProviderError,
  type Provider,
  type StreamChunk,
  type ToolCall,
} from "./types.ts";

/**
 * OpenAI-compatible provider path: works against api.openai.com, OpenRouter,
 * Ollama (/v1), vLLM, or any base_url implementing chat completions.
 * SSE streaming, incremental tool-call assembly, abort propagation.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai-compatible";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  capabilities(_model: string): Capabilities {
    void _model;
    return { supportsTools: true, supportsVision: true, supportsStreaming: true, supportsStructuredOutput: true, contextLimit: 128_000 };
  }

  async *stream(req: GenerateRequest, model: string): AsyncIterable<StreamChunk> {
    const url = joinUrl(this.baseUrl, "/chat/completions");
    const body = {
      model,
      messages: encodeMessages(req.messages),
      tools: req.tools?.length ? encodeTools(req.tools) : undefined,
      temperature: req.temperature ?? 0,
      max_tokens: req.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`provider HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, retryable);
    }

    // Assemble streamed tool calls keyed by index.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finished = false;

    for await (const payload of sseEvents(res.body, req.signal)) {
      if (payload === "[DONE]") {
        finished = true;
        break;
      }
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue; // tolerate keepalives/fragmented lines
      }
      const choices = Array.isArray(chunk["choices"]) ? (chunk["choices"] as Array<Record<string, unknown>>) : [];
      const choice = choices[0];
      if (choice) {
        const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
        const content = delta["content"];
        if (typeof content === "string" && content.length > 0) {
          yield { type: "text_delta", text: content };
        }
        const toolChunks = delta["tool_calls"];
        if (Array.isArray(toolChunks)) {
          for (const [i, raw] of toolChunks.entries()) {
            const tc = raw as Record<string, unknown>;
            const idx = typeof tc["index"] === "number" ? tc["index"] : i;
            const slot = pending.get(idx) ?? { id: "", name: "", args: "" };
            if (typeof tc["id"] === "string") slot.id = tc["id"];
            if (typeof tc["function"] === "object" && tc["function"] !== null) {
              const fn = tc["function"] as Record<string, unknown>;
              if (typeof fn["name"] === "string") slot.name += fn["name"];
              if (typeof fn["arguments"] === "string") slot.args += fn["arguments"];
            }
            pending.set(idx, slot);
          }
        }
        const finish = choice["finish_reason"];
        if (typeof finish === "string" && finish.length > 0) {
          for (const slot of pending.values()) {
            if (slot.name) {
              const call: ToolCall = { id: slot.id || `call_${slot.name}`, name: slot.name, argumentsJson: slot.args };
              yield { type: "tool_call_delta", toolCall: call };
            }
          }
          pending.clear();
          yield { type: "finish", stopReason: finish };
        }
      }
      const usage = chunk["usage"];
      if (usage && typeof usage === "object") {
        const u = usage as Record<string, unknown>;
        const prompt = numberOr(u["prompt_tokens"], 0);
        const cached = details(u)["cached_tokens"] ?? 0;
        yield {
          type: "usage",
          usage: {
            inputTokens: prompt,
            outputTokens: numberOr(u["completion_tokens"], 0),
            cachedTokens: typeof cached === "number" ? cached : 0,
            totalTokens: numberOr(u["total_tokens"], prompt + numberOr(u["completion_tokens"], 0)),
            modelCalls: 1,
            toolCalls: 0,
            costUsd: null,
          },
        };
      }
    }
    if (!finished) yield { type: "finish", stopReason: "stream_end" };
  }
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function encodeMessages(messages: GenerateRequest["messages"]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
      };
    }
    const content = m.parts.map((p) =>
      p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data}` } },
    );
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content,
        tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: tc.argumentsJson } })),
      };
    }
    return { role: m.role, content };
  });
}

function encodeTools(tools: NonNullable<GenerateRequest["tools"]>): Array<Record<string, unknown>> {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

// ─── SSE parsing ──────────────────────────────────────────────────────────────

async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new ProviderError("aborted", undefined, false);
      const { done, value } = await reader.read();
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

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  return b + path;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function details(u: Record<string, unknown>): Record<string, unknown> {
  const d = u["prompt_tokens_details"];
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}
