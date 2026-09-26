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

export interface ProviderCatalogEntry {
  id: string;
  /** Where the key comes from by default (BYOK, Part 54). */
  defaultKeyEnv: string;
  defaultBaseUrl: string;
  /** What this provider path supports today — honest, not aspirational. */
  status: "available" | "planned";
  note?: string;
}

/** The provider catalog (Parts 52–54): capability truth for /provider, /models. */
export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: "openai", defaultKeyEnv: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", status: "available", note: "OpenAI-compatible path; vision depends on the model" },
  { id: "openrouter", defaultKeyEnv: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1", status: "available", note: "OpenAI-compatible path; model string selects the upstream" },
  { id: "ollama", defaultKeyEnv: "OLLAMA_API_KEY", defaultBaseUrl: "http://localhost:11434/v1", status: "available", note: "local; many models ignore tools/vision — capabilities are reported per model" },
  { id: "openai-compatible", defaultKeyEnv: "OPENAI_API_KEY", defaultBaseUrl: "", status: "available", note: "any OpenAI-shaped endpoint (base_url required)" },
  { id: "anthropic", defaultKeyEnv: "ANTHROPIC_API_KEY", defaultBaseUrl: "https://api.anthropic.com/v1", status: "planned", note: "native path lands in spec Phase 9; use an openai-compatible endpoint meanwhile" },
];

/** Known models per provider for /models (curated, not exhaustive). */
const MODEL_CATALOG: Record<string, string[]> = {
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "o4-mini"],
  openrouter: ["anthropic/claude-sonnet-4", "openai/gpt-4.1", "google/gemini-2.5-pro", "meta-llama/llama-4-maverick"],
  ollama: ["llama3.2", "qwen3", "devstral"],
  "openai-compatible": [],
};

export function providerCatalog(): Array<ProviderCatalogEntry & { models: string[] }> {
  return PROVIDER_CATALOG.map((p) => ({ ...p, models: MODEL_CATALOG[p.id] ?? [] }));
}

export { OpenAICompatibleProvider };
export type { Provider, Capabilities, GenerateRequest, StreamChunk } from "./types.ts";
