/**
 * Telos — terminal-native agentic coding CLI.
 * CLI arg parsing (Part 5), phase-0 entry: launch, load config, status, exit.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, defaultConfigToml, STATE_DIRNAME, globalConfigDir } from "./config/loader.ts";
import { ConfigError } from "./config/schema.ts";
import { injectStoredCredential, credentialsPath } from "./config/credentials.ts";
import { isInteractive, runSetupWizard, printSetupSummary } from "./setup/wizard.ts";

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

const HELP = `Telos — terminal-native agentic coding CLI

USAGE
  telos [command] [options]

COMMANDS
  chat              Start an interactive session (default)
  init              Write .project-agent/config.toml and exit
  setup             Re-run the interactive setup wizard (provider, key, model)
  status            Show configuration and environment readiness
  version           Print version

OPTIONS
  --model <name>        Model name override (also TELOS_MODEL)
  --provider <name>     Provider override (also TELOS_PROVIDER)
  --base-url <url>      API base URL override (also TELOS_BASE_URL)
  --max-tokens <n>      Hard token budget override (also TELOS_MAX_TOKENS)
  --max-tool-calls <n>  Hard tool-call budget override

BYOK
  telos asks for your provider, API endpoint, API key, and model name the
  first time it runs — no file editing needed. The key is stored in
  ~/.telos/credentials.json (mode 600, outside every project). Environment
  variables still win when set (see model.api_key_env). Keys are never
  logged, echoed, or written into a repository.

RUNTIME GUARDS
  Hard budgets (tokens, tool calls, workers, wall time) are enforced by the
  runtime, not the model. Configuration lives in .project-agent/config.toml.
`;

function cmdStatus(): void {
  const root = process.cwd();
  const cfg = loadConfig(root);
  const hasState = existsSync(join(root, STATE_DIRNAME, "config.toml"));
  const keyEnv = cfg.model.apiKeyEnv;
  const keyInEnv = Boolean(process.env[keyEnv]);
  const keyInStore = Boolean(injectStoredCredential(keyEnv, cfg.model.provider)) || existsSync(credentialsPath());
  const hasKey = keyInEnv || keyInStore;
  const lines = [
    `project      ${root}`,
    `state        ${hasState ? `${STATE_DIRNAME}/config.toml` : "not initialized (run: telos init)"}`,
    `provider     ${cfg.model.provider}`,
    `model        ${cfg.model.name || "(unset)"}`,
    `base_url     ${cfg.model.baseUrl || "(provider default)"}`,
    `credentials  env:${keyEnv} ${keyInEnv ? "present" : "absent"} · store ~/.telos/credentials.json ${keyInStore ? "present" : "absent"} → ${hasKey ? "key available" : "MISSING"}`,
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

async function main(): Promise<number> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));

  const applyFlagOverrides = (): void => {
    if (typeof flags.get("model") === "string") process.env["TELOS_MODEL"] = flags.get("model") as string;
    if (typeof flags.get("provider") === "string") process.env["TELOS_PROVIDER"] = flags.get("provider") as string;
    if (typeof flags.get("base-url") === "string") process.env["TELOS_BASE_URL"] = flags.get("base-url") as string;
    const mt = Number(flags.get("max-tokens"));
    if (Number.isInteger(mt) && mt > 0) process.env["TELOS_MAX_TOKENS"] = String(mt);
    const mtc = Number(flags.get("max-tool-calls"));
    if (Number.isInteger(mtc) && mtc > 0) process.env["TELOS_MAX_TOOL_CALLS"] = String(mtc);
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
        console.log(`telos ${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string}`);
        return 0;
      case "init":
        cmdInit();
        return 0;
      case "status":
        applyFlagOverrides();
        cmdStatus();
        return 0;
      case "setup":
        if (!isInteractive()) {
          console.error("setup needs an interactive terminal (tty). Re-run `telos setup` in your terminal.");
          return 2;
        }
        await runSetupWizard().then(printSetupSummary);
        return 0;
      case "chat": {
        applyFlagOverrides();
        const configPath = join(process.cwd(), STATE_DIRNAME, "config.toml");
        const cfg = loadConfig(process.cwd());
        const needsSetup = !existsSync(configPath) || !cfg.model.name;
        if (needsSetup) {
          if (isInteractive()) {
            // The primary UX: bare `telos` in a fresh project walks the user
            // through provider/key/model and drops them straight into the
            // session. No file editing, no shell exports.
            const result = await runSetupWizard();
            printSetupSummary(result);
            // Reload: the wizard wrote both the project config and the key store.
            const fresh = loadConfig(process.cwd());
            injectStoredCredential(fresh.model.apiKeyEnv, fresh.model.provider);
            const { runSession } = await import("./session/session.ts");
            return await runSession({ projectRoot: process.cwd() });
          }
          // Non-interactive fallback (CI, pipes): old scaffold-and-hint path.
          if (!existsSync(configPath)) {
            cmdInit();
            console.error(
              "\nNo model configured. Either run `telos` in an interactive terminal to configure, or set:\n" +
                "  TELOS_MODEL, TELOS_BASE_URL (optional), and export the API key named by api_key_env\n" +
                "  (default OPENAI_API_KEY). Then run `telos` again.",
            );
            return 2;
          }
          console.error("No model configured. Set TELOS_MODEL or [model] name in .project-agent/config.toml.");
          return 2;
        }
        // Configured project: make stored credentials visible to the session.
        injectStoredCredential(cfg.model.apiKeyEnv, cfg.model.provider);
        const { runSession } = await import("./session/session.ts");
        return await runSession({ projectRoot: process.cwd() });
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

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
