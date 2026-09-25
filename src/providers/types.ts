/**
 * Provider abstraction (Part 52). One interface, explicit capabilities,
 * normalized message/content-part model (Part 51), streaming tool calls.
 * cost_usd stays null until a provider actually reports it (Part 24).
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }; // base64

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON-Schema-shaped object; validated by the tool itself on invocation. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as sent by the model; parsed by the runtime. */
  argumentsJson: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: number;
  /** Null until a provider reports a real cost — never invented (Part 24). */
  costUsd: number | null;
}

export interface Message {
  role: Role;
  parts: ContentPart[];
  /** For assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** For role=tool responses. */
  toolCallId?: string;
  toolName?: string;
}

export interface StreamChunk {
  type: "text_delta" | "tool_call_delta" | "finish" | "usage";
  text?: string;
  toolCall?: ToolCall;
  usage?: Usage;
  stopReason?: string;
}

export interface GenerateRequest {
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Capabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  contextLimit: number;
}

export interface ModelRef {
  provider: string;
  name: string;
  baseUrl?: string;
  apiKeyEnv: string;
  temperature: number;
  maxTokens: number;
}

export interface Provider {
  readonly name: string;
  capabilities(model: string): Capabilities;
  /** Stream a completion. Implementations must respect request.signal. */
  stream(req: GenerateRequest, model: string): AsyncIterable<StreamChunk>;
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, modelCalls: 0, toolCalls: 0, costUsd: null };
}

export function addUsage(a: Usage, b: Usage): Usage {
  const costUsd = a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    modelCalls: a.modelCalls + b.modelCalls,
    toolCalls: a.toolCalls + b.toolCalls,
    costUsd,
  };
}
