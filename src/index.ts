/**
 * Synergon — terminal-native agentic coding CLI.
 * CLI arg parsing (Part 5), phase-0 entry: launch, load config, status, exit.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, defaultConfigToml, STATE_DIRNAME, globalConfigDir } from "./config/loader.ts";
import { ConfigError } from "./config/schema.ts";

interface Parsed {
  command: string;
  args: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const [command = "chat", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else flags.set(a.slice(2), true);
      }
    } else args.push(a);
  }
  return { command, args, flags };
}

const HELP = `Synergon — terminal-native agentic coding CLI

USAGE
  synergon [command] [options]

COMMANDS
  chat              Start an interactive session (default)
  init              Write .project-agent/config.toml and exit
  status            Show configuration and environment readiness
  version           Print version

OPTIONS
  --model <name>        Model name override (also SYNERGON_MODEL)
  --provider <name>     Provider override (also SYNERGON_PROVIDER)
  --base-url <url>      API base URL override (also SYNERGON_BASE_URL)
  --max-tokens <n>      Hard token budget override (also SYNERGON_MAX_TOKENS)
  --max-tool-calls <n>  Hard tool-call budget override

BYOK
  API keys are read from the environment variable named by
  model.api_key_env (default OPENAI_API_KEY). Keys are never logged,
  persisted, or echoed.

RUNTIME GUARDS
  Hard budgets (tokens, tool calls, workers, wall time) are enforced by the
  runtime, not the model. Configuration lives in .project-agent/config.toml.
`;

function cmdStatus(): void {
  const root = process.cwd();
  const cfg = loadConfig(root);
  const hasState = existsSync(join(root, STATE_DIRNAME, "config.toml"));
  const keyEnv = cfg.model.apiKeyEnv;
  const hasKey = Boolean(process.env[keyEnv]);
  const lines = [
    `project      ${root}`,
    `state        ${hasState ? `${STATE_DIRNAME}/config.toml` : "not initialized (run: synergon init)"}`,
    `provider     ${cfg.model.provider}`,
    `model        ${cfg.model.name || "(unset — set SYNERGON_MODEL)"}`,
    `credentials  env:${keyEnv} ${hasKey ? "present" : "MISSING"}`,
    `autonomy     ${cfg.runtime.autonomy}`,
    `budgets      tokens=${cfg.runtime.maxTotalTokens} toolCalls=${cfg.runtime.maxToolCalls} workers=${cfg.runtime.maxWorkerSpawns} parallel=${cfg.runtime.maxParallelWorkers} wallTime=${cfg.runtime.maxWallTimeSeconds}s`,
    `security     confirmDestructive=${cfg.security.confirmDestructive} blockSecrets=${cfg.security.blockSecrets}`,
    `globalDir    ${globalConfigDir()}`,
  ];
  console.log(lines.join("\n"));
}

function cmdInit(): void {
  const dir = join(process.cwd(), STATE_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const cfg = join(dir, "config.toml");
  if (!existsSync(cfg)) writeFileSync(cfg, defaultConfigToml(), "utf8");
  console.log(`wrote ${cfg}`);
}

function main(): number {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  const applyFlagOverrides = (): void => {
    if (typeof flags.get("model") === "string") process.env["SYNERGON_MODEL"] = flags.get("model") as string;
    if (typeof flags.get("provider") === "string") process.env["SYNERGON_PROVIDER"] = flags.get("provider") as string;
    if (typeof flags.get("base-url") === "string") process.env["SYNERGON_BASE_URL"] = flags.get("base-url") as string;
    const mt = Number(flags.get("max-tokens"));
    if (Number.isInteger(mt) && mt > 0) process.env["SYNERGON_MAX_TOKENS"] = String(mt);
    const mtc = Number(flags.get("max-tool-calls"));
    if (Number.isInteger(mtc) && mtc > 0) process.env["SYNERGON_MAX_TOOL_CALLS"] = String(mtc);
  };

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      case "version":
      case "--version":
        console.log("synergon 0.1.0");
        return 0;
      case "init":
        cmdInit();
        return 0;
      case "status":
        applyFlagOverrides();
        cmdStatus();
        return 0;
      case "chat": {
        applyFlagOverrides();
        const cfg = loadConfig(process.cwd());
        if (!cfg.model.name) {
          console.error("No model configured. Set SYNERGON_MODEL or [model] name in .project-agent/config.toml.");
          return 2;
        }
        console.error("interactive session: not yet implemented (Phase 1)");
        return 3;
      }
      default:
        console.error(`Unknown command: ${command}\n`);
        console.error(HELP);
        return 2;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      return 2;
    }
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

process.exitCode = main();
