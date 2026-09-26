/**
 * Model catalog (Scale Batch 2).
 *
 * Per-model context/output limits from a vendored static table, matched by
 * model-id substring, with two real-world escape hatches:
 *
 *  - `observedOutputCap`: some gateways cap completions below the model's
 *    official limit and ignore `max_tokens` entirely (measured on vyceai:
 *    ~4096). When we observe a truncated response, the cap is remembered for
 *    the session and used for compaction math.
 *  - `ignoresMaxTokens`: gateways that silently drop the `max_tokens` field —
 *    we stop relying on it for output control and rely on the observed cap
 *    plus the task token budget instead.
 *
 * Unknown models get conservative defaults, never invented precision: an
 * unknown model is assumed to have a small-ish context so compaction errs
 * toward firing early rather than letting a session overflow.
 */

export interface ModelLimits {
  /** Total context window (input + output) in tokens. */
  contextWindow: number;
  /** Official max output tokens. */
  maxOutput: number;
  /** Gateway caps output below maxOutput and ignores max_tokens (observed). */
  observedOutputCap?: number;
  /** Provider ignores the max_tokens request field. */
  ignoresMaxTokens?: boolean;
  /** Streams reasoning on delta.reasoning_content (DeepSeek-style). */
  reasoningField?: boolean;
  source: "catalog" | "defaults" | "observed";
}

interface CatalogEntry {
  match: RegExp;
  limits: Omit<ModelLimits, "source">;
}

/** Vendored, hand-maintained. Sorted by specificity; first match wins. */
const CATALOG: CatalogEntry[] = [
  // OpenAI
  { match: /gpt-5/i, limits: { contextWindow: 400_000, maxOutput: 128_000 } },
  { match: /gpt-4\.1/i, limits: { contextWindow: 1_000_000, maxOutput: 32_768 } },
  { match: /gpt-4o/i, limits: { contextWindow: 128_000, maxOutput: 16_384 } },
  { match: /gpt-4-turbo/i, limits: { contextWindow: 128_000, maxOutput: 4_096 } },
  { match: /gpt-4/i, limits: { contextWindow: 8_192, maxOutput: 4_096 } },
  { match: /o[134](?:-mini|-preview)?\b/i, limits: { contextWindow: 200_000, maxOutput: 100_000, reasoningField: true } },
  // Anthropic
  { match: /claude-(?:opus|sonnet|haiku)/i, limits: { contextWindow: 200_000, maxOutput: 64_000 } },
  // DeepSeek
  { match: /deepseek-(?:v4|v3|chat)/i, limits: { contextWindow: 128_000, maxOutput: 8_192, reasoningField: true } },
  { match: /deepseek-r\d/i, limits: { contextWindow: 128_000, maxOutput: 32_768, reasoningField: true } },
  { match: /deepseek/i, limits: { contextWindow: 64_000, maxOutput: 8_192, reasoningField: true } },
  // Google
  { match: /gemini-2/i, limits: { contextWindow: 1_000_000, maxOutput: 65_536 } },
  { match: /gemini/i, limits: { contextWindow: 128_000, maxOutput: 8_192 } },
  // Local / open weights commonly served at small contexts
  { match: /llama-?3\.?[123]?/i, limits: { contextWindow: 128_000, maxOutput: 8_192 } },
  { match: /mistral|mixtral/i, limits: { contextWindow: 128_000, maxOutput: 8_192 } },
  { match: /qwen/i, limits: { contextWindow: 128_000, maxOutput: 8_192, reasoningField: true } },
  { match: /kimi|moonshot/i, limits: { contextWindow: 200_000, maxOutput: 8_192 } },
  { match: /glm/i, limits: { contextWindow: 128_000, maxOutput: 16_384 } },
];

/** Conservative floor for unknown models — compaction fires early, never late. */
const DEFAULTS: Omit<ModelLimits, "source"> = { contextWindow: 32_000, maxOutput: 4_096 };

export function resolveModelLimits(modelName: string): ModelLimits {
  for (const entry of CATALOG) {
    if (entry.match.test(modelName)) return { ...entry.limits, source: "catalog" };
  }
  return { ...DEFAULTS, source: "defaults" };
}

/**
 * Effective output budget for a model/gateway pair: the observed cap when we
 * have one (gateways that ignore max_tokens are exactly the ones that cap),
 * else maxOutput. Used for max_tokens on the wire and compaction reserve.
 */
export function effectiveMaxOutput(limits: ModelLimits): number {
  if (limits.observedOutputCap !== undefined) return limits.observedOutputCap;
  return limits.maxOutput;
}

/**
 * Context tokens at which compaction should fire: real context window minus
 * output reserve and a safety margin (Pi's shouldCompact shape).
 */
export function compactionThreshold(limits: ModelLimits, safetyTokens = 4_096): number {
  const reserve = effectiveMaxOutput(limits) + safetyTokens;
  return Math.max(8_000, limits.contextWindow - reserve);
}

/**
 * Session-observed cap: when a completion comes back truncated
 * (finish_reason=length) at N output tokens, the gateway's real cap is ≥ N
 * and < what we asked for. Record the observed count so compaction math and
 * budget warnings reflect reality for the rest of the session.
 */
export function noteObservedCap(limits: ModelLimits, outputTokens: number): ModelLimits {
  const cap = Math.max(1_000, Math.ceil(outputTokens / 64) * 64); // round to 64
  if (limits.observedOutputCap !== undefined && limits.observedOutputCap <= cap) return limits;
  return { ...limits, observedOutputCap: cap, source: "observed" };
}
