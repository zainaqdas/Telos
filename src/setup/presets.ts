/**
 * Provider presets for the setup wizard: known endpoints, default key-env
 * names, and a sensible starter model each. The list is intentionally short
 * — any other OpenAI-compatible endpoint works via the "custom endpoint"
 * path, and the URL often identifies the provider on its own (inference).
 */

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  /** Env-var name under which the wizard stores the key. */
  keyEnv: string;
  /** Starter model; "" when the user must type one (no known default). */
  model: string;
  /** Custom endpoints require user input when this preset is chosen. */
  requiresBaseUrl: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", model: "gpt-5-mini", requiresBaseUrl: false },
  { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com", keyEnv: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-5", requiresBaseUrl: false },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", model: "openrouter/auto", requiresBaseUrl: false },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", keyEnv: "OLLAMA_API_KEY", model: "", requiresBaseUrl: false },
  { id: "openai-compatible", label: "Custom OpenAI-compatible endpoint", baseUrl: "", keyEnv: "CUSTOM_API_KEY", model: "", requiresBaseUrl: true },
];

/** Match a URL against known endpoints; returns the preset or null. */
export function inferProviderFromBaseUrl(url: string): ProviderPreset | null {
  const u = url.replace(/\/+$/, "");
  for (const p of PROVIDER_PRESETS) {
    if (p.baseUrl !== "" && u === p.baseUrl.replace(/\/+$/, "")) return p;
  }
  // Substring heuristics for common compatible endpoints.
  if (u.includes("anthropic")) return PROVIDER_PRESETS.find((p) => p.id === "anthropic") ?? null;
  if (u.includes("openrouter")) return PROVIDER_PRESETS.find((p) => p.id === "openrouter") ?? null;
  if (u.includes("localhost") || u.includes("127.0.0.1")) return PROVIDER_PRESETS.find((p) => p.id === "ollama") ?? null;
  return null;
}
