/**
 * Config schema — runtime-validated, human-editable.
 * Lives at .project-agent/config.toml. Runtime guards consume the normalized
 * form; the model never sets its own limits (Part 22/23).
 * Hand-rolled validators keep the dependency set at zero (Part 5).
 */

// ─── Validation helpers ───────────────────────────────────────────────────────

export class ConfigError extends Error {}

export function expectObject(v: unknown, path: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${path}: expected table`);
  return v as Record<string, unknown>;
}

export function expectString(v: unknown, path: string, opts: { optional?: boolean; fallback?: string } = {}): string {
  if (v === undefined) {
    if (opts.fallback !== undefined) return opts.fallback;
    if (opts.optional) return "";
    throw new ConfigError(`${path}: expected string`);
  }
  if (typeof v !== "string") throw new ConfigError(`${path}: expected string`);
  return v;
}

/**
 * api_key_env is the NAME of an environment variable, not the key itself.
 * A common real-world mistake is pasting the raw key ("sk-...") into the
 * config; that yields a 401 from the provider with no actionable hint.
 * Reject it at load time with a clear message instead.
 */
export function expectEnvVarName(v: unknown, path: string, opts: { optional?: boolean; fallback?: string } = {}): string {
  const name = expectString(v, path, opts);
  if (name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) === false) {
    throw new ConfigError(
      `${path}: "${name.slice(0, 8)}…" does not look like an environment variable name — it looks like the key itself. ` +
      `Set api_key_env to the NAME of an env var (e.g. "TELOS_API_KEY"), and put the key value in that variable. ` +
      `Or delete the [model] section and run telos again to configure interactively.`,
    );
  }
  return name;
}

export function expectEnum<T extends string>(v: unknown, path: string, allowed: readonly T[], fallback: T): T {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new ConfigError(`${path}: expected one of ${allowed.join(", ")}`);
  }
  return v as T;
}

export function expectInt(v: unknown, path: string, opts: { min?: number; max?: number; fallback?: number } = {}): number {
  if (v === undefined) {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new ConfigError(`${path}: expected integer`);
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ConfigError(`${path}: expected integer`);
  if (opts.min !== undefined && v < opts.min) throw new ConfigError(`${path}: must be >= ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw new ConfigError(`${path}: must be <= ${opts.max}`);
  return v;
}

export function expectBool(v: unknown, path: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new ConfigError(`${path}: expected boolean`);
  return v;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export const PROVIDERS = ["openai", "anthropic", "openai-compatible", "openrouter", "ollama"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type AutonomyMode = "ask" | "balanced" | "autonomous";

export interface ModelConfig {
  provider: ProviderName;
  name: string;
  baseUrl: string;
  /** BYOK: resolved from environment at task start, never persisted. */
  apiKeyEnv: string;
  temperature: number;
  maxTokens: number;
  /**
   * User-declared pricing in USD per million tokens (Part 23): cost is
   * COMPUTED, never invented — null until the user supplies prices.
   */
  pricing?: { inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok?: number };
  /** Optional cheaper model for worker delegations (Part 7: elastic staffing). */
  workerModel?: string;
}

export interface RuntimeConfig {
  autonomy: AutonomyMode;
  maxTotalTokens: number;
  maxToolCalls: number;
  maxWorkerSpawns: number;
  maxParallelWorkers: number;
  maxWallTimeSeconds: number;
  shellTimeoutSeconds: number;
  maxStreamAttempts: number;
  /** Minimum tests a passing suite must report to count as verification (0 disables the guard). */
  minTestCount: number;
  /** Seconds of stream inactivity before a model call is aborted (0 disables). */
  streamTimeoutSeconds: number;
  /** Estimated-token threshold that triggers transcript compaction (0 disables). */
  compactionThresholdTokens: number;
}

export interface SecurityConfig {
  confirmDestructive: boolean;
  blockSecrets: boolean;
}

export interface TelosConfig {
  model: ModelConfig;
  runtime: RuntimeConfig;
  security: SecurityConfig;
}

// ─── Normalization ────────────────────────────────────────────────────────────

/** Optional [model.pricing] table: USD per million tokens, user-declared. */
function parsePricing(model: Record<string, unknown>): { pricing?: { inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok?: number } } {
  const raw = model["pricing"];
  if (raw === undefined) return {};
  const p = expectObject(raw, "model.pricing");
  const input = expectInt(p["input_per_mtok"], "model.pricing.input_per_mtok", { min: 0 });
  const output = expectInt(p["output_per_mtok"], "model.pricing.output_per_mtok", { min: 0 });
  if (p["cache_read_per_mtok"] === undefined) return { pricing: { inputPerMtok: input, outputPerMtok: output } };
  const cache = expectInt(p["cache_read_per_mtok"], "model.pricing.cache_read_per_mtok", { min: 0 });
  return { pricing: { inputPerMtok: input, outputPerMtok: output, cacheReadPerMtok: cache } };
}

export function parseConfig(root: Record<string, unknown>): TelosConfig {
  const model = expectObject(root["model"], "[model]");
  const runtime = expectObject(root["runtime"], "[runtime]");
  const security = expectObject(root["security"], "[security]");

  return {
    model: {
      provider: expectEnum(model["provider"], "model.provider", PROVIDERS, "openai"),
      name: expectString(model["name"], "model.name", { fallback: "" }),
      baseUrl: expectString(model["base_url"], "model.base_url", { fallback: "" }),
      apiKeyEnv: expectEnvVarName(model["api_key_env"], "model.api_key_env", { fallback: "TELOS_API_KEY" }),
      temperature: expectInt(model["temperature"], "model.temperature", { min: 0, max: 2, fallback: 0 }),
      maxTokens: expectInt(model["max_tokens"], "model.max_tokens", { min: 256, fallback: 32_768 }),
      ...parsePricing(model),
      workerModel: expectString(model["worker_model"], "model.worker_model", { optional: true }),
    },
    runtime: {
      autonomy: expectEnum(runtime["autonomy"], "runtime.autonomy", ["ask", "balanced", "autonomous"] as const, "balanced"),
      // ALL budgets default to UNLIMITED (0 where 0 is meaningful): the user
      // opts INTO any limit. The safety rules that are not budgets — refusal
      // of destructive/system-level commands, repetition guard, evidence-based
      // gate — are unchanged and always on.
      // Token ceiling: counts BILLABLE tokens (cache reads excluded).
      maxTotalTokens: expectInt(runtime["max_total_tokens"], "runtime.max_total_tokens", { min: 0, fallback: 0 }),
      // 0 = unlimited tool calls.
      maxToolCalls: expectInt(runtime["max_tool_calls"], "runtime.max_tool_calls", { min: 0, fallback: 0 }),
      // 0 = unlimited worker spawns / parallel workers.
      maxWorkerSpawns: expectInt(runtime["max_worker_spawns"], "runtime.max_worker_spawns", { min: 0, fallback: 0 }),
      maxParallelWorkers: expectInt(runtime["max_parallel_workers"], "runtime.max_parallel_workers", { min: 0, fallback: 0 }),
      // 0 = no wall-clock limit.
      maxWallTimeSeconds: expectInt(runtime["max_wall_time_seconds"], "runtime.max_wall_time_seconds", { min: 0, fallback: 0 }),
      shellTimeoutSeconds: expectInt(runtime["shell_timeout_seconds"], "runtime.shell_timeout_seconds", { min: 1, fallback: 120 }),
      maxStreamAttempts: expectInt(runtime["max_stream_attempts"], "runtime.max_stream_attempts", { min: 1, max: 5, fallback: 5 }),
      minTestCount: expectInt(runtime["min_test_count"], "runtime.min_test_count", { min: 0, fallback: 1 }),
      streamTimeoutSeconds: expectInt(runtime["stream_timeout_seconds"], "runtime.stream_timeout_seconds", { min: 0, fallback: 120 }),
      compactionThresholdTokens: expectInt(runtime["compaction_threshold_tokens"], "runtime.compaction_threshold_tokens", { min: 0, fallback: 60_000 }),
    },
    security: {
      confirmDestructive: expectBool(security["confirm_destructive"], "security.confirm_destructive", true),
      blockSecrets: expectBool(security["block_secrets"], "security.block_secrets", true),
    },
  };
}
