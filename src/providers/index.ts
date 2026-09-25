import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import {
  type Capabilities,
  ProviderError,
  type Provider,
  type GenerateRequest,
  type StreamChunk,
} from "./types.ts";

/**
 * Provider factory for Phase 0: resolve credentials from the environment
 * (BYOK), construct the one provider path, and hand a `Provider` to later
 * phases' task loop. Adding a provider = implementing the interface (Part 53).
 */

export function createProvider(opts: { provider: string; apiKey?: string; baseUrl: string; streamTimeoutSeconds?: number }): Provider {
  const apiKey = opts.apiKey ?? "";
  const t = opts.streamTimeoutSeconds ?? 120;
  switch (opts.provider) {
    case "openai":
      return new OpenAICompatibleProvider(apiKey, opts.baseUrl || "https://api.openai.com/v1", t);
    case "openrouter":
      return new OpenAICompatibleProvider(apiKey, opts.baseUrl || "https://openrouter.ai/api/v1", t);
    case "ollama":
      return new OpenAICompatibleProvider(apiKey, opts.baseUrl || "http://localhost:11434/v1", t);
    case "openai-compatible":
      return new OpenAICompatibleProvider(apiKey, opts.baseUrl, t);
    case "anthropic":
      // Anthropic's public API is not OpenAI-shaped; Phase 9 adds a native path.
      throw new ProviderError("anthropic native provider lands in Phase 9; use an openai-compatible endpoint for now");
    default:
      throw new ProviderError(`unknown provider: ${opts.provider}`);
  }
}

/** Resolve the BYOK key from the configured env var; never log or persist it. */
export function resolveApiKey(apiKeyEnv: string): string {
  const key = process.env[apiKeyEnv];
  return typeof key === "string" ? key : "";
}

export { OpenAICompatibleProvider };
export type { Provider, Capabilities, GenerateRequest, StreamChunk } from "./types.ts";
