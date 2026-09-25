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
}

export interface SecurityConfig {
  confirmDestructive: boolean;
  blockSecrets: boolean;
}

export interface SynergonConfig {
  model: ModelConfig;
  runtime: RuntimeConfig;
  security: SecurityConfig;
}

// ─── Normalization ────────────────────────────────────────────────────────────

export function parseConfig(root: Record<string, unknown>): SynergonConfig {
  const model = expectObject(root["model"], "[model]");
  const runtime = expectObject(root["runtime"], "[runtime]");
  const security = expectObject(root["security"], "[security]");

  return {
    model: {
      provider: expectEnum(model["provider"], "model.provider", PROVIDERS, "openai"),
      name: expectString(model["name"], "model.name", { fallback: "" }),
      baseUrl: expectString(model["base_url"], "model.base_url", { fallback: "" }),
      apiKeyEnv: expectString(model["api_key_env"], "model.api_key_env", { fallback: "OPENAI_API_KEY" }),
      temperature: expectInt(model["temperature"], "model.temperature", { min: 0, max: 2, fallback: 0 }),
      maxTokens: expectInt(model["max_tokens"], "model.max_tokens", { min: 256, fallback: 16384 }),
    },
    runtime: {
      autonomy: expectEnum(runtime["autonomy"], "runtime.autonomy", ["ask", "balanced", "autonomous"] as const, "balanced"),
      maxTotalTokens: expectInt(runtime["max_total_tokens"], "runtime.max_total_tokens", { min: 1000, fallback: 80_000 }),
      maxToolCalls: expectInt(runtime["max_tool_calls"], "runtime.max_tool_calls", { min: 1, fallback: 40 }),
      maxWorkerSpawns: expectInt(runtime["max_worker_spawns"], "runtime.max_worker_spawns", { min: 0, fallback: 3 }),
      maxParallelWorkers: expectInt(runtime["max_parallel_workers"], "runtime.max_parallel_workers", { min: 0, fallback: 2 }),
      maxWallTimeSeconds: expectInt(runtime["max_wall_time_seconds"], "runtime.max_wall_time_seconds", { min: 10, fallback: 900 }),
      shellTimeoutSeconds: expectInt(runtime["shell_timeout_seconds"], "runtime.shell_timeout_seconds", { min: 1, fallback: 120 }),
      maxStreamAttempts: expectInt(runtime["max_stream_attempts"], "runtime.max_stream_attempts", { min: 1, max: 5, fallback: 2 }),
      minTestCount: expectInt(runtime["min_test_count"], "runtime.min_test_count", { min: 0, fallback: 1 }),
    },
    security: {
      confirmDestructive: expectBool(security["confirm_destructive"], "security.confirm_destructive", true),
      blockSecrets: expectBool(security["block_secrets"], "security.block_secrets", true),
    },
  };
}
