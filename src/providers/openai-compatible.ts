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
  /** Seconds of stream inactivity before aborting (0 disables). */
  private readonly streamTimeoutSeconds: number;

  constructor(apiKey: string, baseUrl: string, streamTimeoutSeconds = 120) {
    this.streamTimeoutSeconds = streamTimeoutSeconds;
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
      // Retry v2: surface the provider's own timing hint (retry-after in
      // seconds or retry-after-ms in milliseconds) so the loop's backoff
      // honors it instead of guessing.
      const hint = parseRetryAfter(res.headers.get("retry-after"), res.headers.get("retry-after-ms"));
      throw new ProviderError(`provider HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, retryable, hint);
    }

    // Inactivity watchdog: if no chunk arrives for streamTimeoutSeconds,
    // abort and surface a retryable timeout instead of hanging the session.
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
      // Never hold the process open just to enforce a timeout.
      if (typeof watchdog.unref === "function") watchdog.unref();
    };
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) onExternalAbort();
      else req.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      // Assemble streamed tool calls keyed by index.
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let finished = false;

      for await (const payload of sseEvents(res.body, controller.signal)) {
        sawAnyChunk = true;
        armWatchdog();
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
          // Reasoning models (DeepSeek thinking mode, vLLM reasoning outputs,
          // and other OpenAI-compatible providers) stream their chain of
          // thought on a separate field, sibling of `content`. Surfaces it so
          // the terminal shows progress instead of appearing hung while the
          // model thinks.
          const reasoning = delta["reasoning_content"];
          if (typeof reasoning === "string" && reasoning.length > 0) {
            yield { type: "thinking_delta", text: reasoning };
          }
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
    } catch (err) {
      // Watchdog aborts surface as retryable timeouts; genuine user cancels
      // (external signal) keep their AbortError identity.
      if (req.signal?.aborted) throw err;
      const isWatchdogAbort = controller.signal.aborted && !req.signal?.aborted;
      if (isWatchdogAbort) {
        throw new ProviderError(
          `provider stream stalled: no data for ${this.streamTimeoutSeconds}s${sawAnyChunk ? " (mid-stream)" : " before first chunk"}`,
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
      // Race the read against the abort signal so a watchdog abort (or user
      // cancel) interrupts even when the socket is silent.
      const readPromise = reader.read();
      const result = signal
        ? await Promise.race([readPromise, abortPromise(signal)])
        : await readPromise;
      if (!result) {
        void readPromise.catch(() => undefined); // loser of the race: swallow its rejection
        try {
          await reader.cancel();
        } catch {
          /* socket already gone */
        }
        throw new ProviderError("aborted", undefined, false);
      }
      const { done, value } = result;
      if (done) {
        // Flush a final event not terminated by a newline — servers that end
        // the body without it would otherwise have their last data line
        // silently dropped (the classic truncated-tool-arguments bug).
        buffer += decoder.decode();
        const tail = buffer.replace(/\r$/, "");
        if (tail.startsWith("data:")) yield tail.slice(5).trim();
        break;
      }
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

/** Resolves null when the signal aborts; used to race an in-flight read. */
function abortPromise(signal: AbortSignal): Promise<null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const onAbort = (): void => resolve(null);
    if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    } else {
      // Undici's AbortSignal polyfills used in some runtimes lack addEventListener.
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

/** Retry v2: parse retry-after (seconds; may be an HTTP-date we ignore) or retry-after-ms. */
function parseRetryAfter(secondsHeader: string | null, msHeader: string | null): number | undefined {
  if (msHeader) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  if (secondsHeader) {
    const s = Number(secondsHeader);
    if (Number.isFinite(s) && s >= 0) return s * 1000;
  }
  return undefined;
}

function details(u: Record<string, unknown>): Record<string, unknown> {
  const d = u["prompt_tokens_details"];
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}
