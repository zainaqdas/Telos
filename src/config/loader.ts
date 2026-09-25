import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseToml } from "./toml.ts";
import { parseConfig, type SynergonConfig } from "./schema.ts";

export const STATE_DIRNAME = ".project-agent";

/** Locate the enclosing project root (the dir containing .project-agent), else cwd. */
export function findProjectRoot(startDir = process.cwd()): string {
  let dir = resolve(startDir);
  while (true) {
    try {
      const st = BunStat(dir);
      if (st) return dir;
    } catch {
      /* keep walking */
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir);
}

function BunStat(dir: string): boolean {
  try {
    readFileSync(join(dir, STATE_DIRNAME, "config.toml"));
    return true;
  } catch {
    return false;
  }
}

/** Layer: built-in defaults → config file → environment overrides. */
export function loadConfig(projectRoot: string): SynergonConfig {
  const configPath = join(projectRoot, STATE_DIRNAME, "config.toml");
  let fileRoot: Record<string, unknown> = {};
  try {
    fileRoot = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const config = parseConfig(fileRoot);

  // Environment overrides (env > file > defaults). Also BYOK defaults so a
  // bare environment works without editing config.
  const env = process.env;
  const m = config.model;
  if (!m.name && env["SYNERGON_MODEL"]) m.name = env["SYNERGON_MODEL"];
  if (!m.baseUrl && env["SYNERGON_BASE_URL"]) m.baseUrl = env["SYNERGON_BASE_URL"];
  if (env["SYNERGON_PROVIDER"] && ["openai", "anthropic", "openai-compatible", "openrouter", "ollama"].includes(env["SYNERGON_PROVIDER"])) {
    m.provider = env["SYNERGON_PROVIDER"] as typeof m.provider;
  }
  const r = config.runtime;
  const intOverrides: Array<[keyof RuntimeConfig, string]> = [
    ["maxTotalTokens", "SYNERGON_MAX_TOKENS"],
    ["maxToolCalls", "SYNERGON_MAX_TOOL_CALLS"],
    ["maxWallTimeSeconds", "SYNERGON_MAX_WALL_TIME"],
    ["minTestCount", "SYNERGON_MIN_TEST_COUNT"],
  ];
  for (const [key, envName] of intOverrides) {
    const v = Number(env[envName]);
    if (Number.isInteger(v) && v > 0) (r[key] as number) = v;
  }
  return config;
}

type RuntimeConfig = import("./schema.ts").RuntimeConfig;

/** Default config file contents written on first run. */
export function defaultConfigToml(): string {
  return `# Synergon configuration. Overrides via environment: SYNERGON_* variables.

[model]
provider = "openai"            # openai | anthropic | openai-compatible | openrouter | ollama
name = ""                      # e.g. gpt-5-mini; or set SYNERGON_MODEL
base_url = ""                  # optional override; or set SYNERGON_BASE_URL
api_key_env = "OPENAI_API_KEY" # BYOK: name of env var holding the key

[runtime]
autonomy = "balanced"
max_total_tokens = 80000
max_tool_calls = 40
max_worker_spawns = 3
max_parallel_workers = 2
max_wall_time_seconds = 900
shell_timeout_seconds = 120
max_stream_attempts = 2
min_test_count = 1             # exit-0 test runs reporting fewer tests are not verification; 0 disables

[security]
confirm_destructive = true
block_secrets = true
`;
}

/** Home directory for global skills (used in later phases). */
export function globalConfigDir(): string {
  return join(homedir(), ".synergon");
}
