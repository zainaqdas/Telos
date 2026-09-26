/**
 * Interactive setup wizard — the "type telos, answer three questions" path.
 *
 * Asks for: provider / base URL, API key (hidden input), model name. Writes
 * `.project-agent/config.toml` in the project and stores the API key in the
 * machine-scoped credential store (`~/.telos/credentials.json`, mode 0600).
 * The user never edits a file or exports anything by hand.
 *
 * Input machinery: one raw-mode pipeline handles every question (visible and
 * hidden) instead of mixing readline with a raw listener — two consumers on
 * the same stdin desync (typed characters leak into readline's line buffer
 * and surface as later answers). The pipeline is paste-safe: characters
 * arriving after a line terminator are queued for the next question, and the
 * queue is drained synchronously before a question waits on new events
 * (otherwise buffered type-ahead is missed and the prompt hangs).
 *
 * Design rules:
 * - Only runs on a TTY. Piped stdin (tests, CI, `curl … | telos`) falls back
 *   to the old scaffold-and-hint behavior instead of hanging.
 * - The API key is never echoed, logged, or written anywhere except the
 *   0600 credential store.
 * - Empty input accepts the shown default at every step.
 */

import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { STATE_DIRNAME } from "../config/loader.ts";
import { saveCredential } from "../config/credentials.ts";
import { inferProviderFromBaseUrl, PROVIDER_PRESETS, type ProviderPreset } from "./presets.ts";

export interface SetupResult {
  provider: string;
  baseUrl: string;
  model: string;
  /** The env-var name under which the key was stored (also in config). */
  apiKeyEnv: string;
  /** Where the project config was written. */
  configPath: string;
}

/** True when stdin and stdout are both an interactive terminal. */
export function isInteractive(): boolean {
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

type RawStdin = NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };

/** Characters typed ahead of the current question (paste bursts). */
let queued = "";
let reading = false;

/** Process one character. Returns a verdict; mutates chars. */
function feedChar(
  ch: string,
  chars: string[],
  hidden: boolean,
  escSkip: { n: number },
): "none" | "line" | "cancel" | "eof" {
  if (escSkip.n > 0) {
    escSkip.n -= 1;
    return "none"; // inside a terminal escape sequence (arrow keys etc.)
  }
  if (ch === "\x1b") {
    escSkip.n = 2; // swallow the next two bytes: CSI (ESC [ <l>) and SS3 (ESC O <x>)
    return "none";
  }
  if (ch === "\r" || ch === "\n") return "line";
  if (ch === "\x03") return "cancel"; // Ctrl+C
  if (ch === "\x04") return "eof"; // Ctrl+D
  if (ch === "\x7f" || ch === "\b") {
    if (chars.length > 0) {
      chars.pop();
      if (!hidden) stdout.write("\b \b");
    }
    return "none";
  }
  if (ch === "\t" || (ch >= " " && ch !== "\x7f")) {
    chars.push(ch);
    if (!hidden) stdout.write(ch);
    return "none";
  }
  return "none"; // other control characters are ignored
}

/** One question, one line. Raw mode always on so echo is fully controlled. */
async function readInput(prompt: string, opts: { hidden?: boolean } = {}): Promise<string> {
  if (reading) throw new Error("concurrent input read");
  reading = true;
  stdout.write(prompt);
  const anyStdin = stdin as RawStdin;
  if (!anyStdin.setRawMode) {
    // Non-TTY fallback (unreachable through normal flows: the wizard is
    // TTY-gated) — plain readline without terminal massaging.
    const rl = createInterface({ input: stdin, terminal: false });
    try {
      return (await rl.question("")).trim();
    } finally {
      rl.close();
    }
  }
  const hidden = opts.hidden === true;
  const decoder = new StringDecoder("utf8");
  const chars: string[] = [];
  const escSkip = { n: 0 };
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let listening = false;
      const cleanup = (): void => {
        if (listening) {
          stdin.removeListener("data", onData);
          listening = false;
        }
        stdin.pause();
        anyStdin.setRawMode(false);
      };
      const done = (value: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        stdout.write("\n");
        resolve(value);
      };
      const abort = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        stdout.write("\n");
        reject(err);
      };
      const pump = (): void => {
        while (!settled && queued.length > 0) {
          const ch = queued[0]!;
          queued = queued.slice(1);
          const verdict = feedChar(ch, chars, hidden, escSkip);
          if (verdict === "line") {
            done(chars.join("").trim());
            return;
          }
          if (verdict === "cancel") {
            queued = "";
            abort(new Error("cancelled"));
            return;
          }
          if (verdict === "eof") {
            queued = "";
            abort(new Error("input ended unexpectedly (Ctrl+D)"));
            return;
          }
        }
        if (!settled && !listening) {
          // Queue exhausted: only now wait for more keystrokes.
          listening = true;
          stdin.resume();
          anyStdin.setRawMode(true);
          stdin.on("data", onData);
        }
      };
      const onData = (b: Buffer): void => {
        queued += decoder.write(b);
        pump();
      };
      stdin.once("error", (err) => abort(err));
      pump(); // drain type-ahead synchronously before waiting on events
    });
  } finally {
    reading = false;
  }
}

function printChoices(): void {
  console.log("\nChoose a provider:");
  PROVIDER_PRESETS.forEach((p, i) => {
    const hint = p.requiresBaseUrl ? " (custom endpoint)" : "";
    console.log(`  ${i + 1}. ${p.label}${hint}`);
  });
}

async function chooseProvider(): Promise<ProviderPreset> {
  printChoices();
  for (;;) {
    const raw = await readInput(`Provider [1]: `);
    if (raw === "") return PROVIDER_PRESETS[0]!;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= PROVIDER_PRESETS.length) return PROVIDER_PRESETS[n - 1]!;
    console.log(`  enter a number 1–${PROVIDER_PRESETS.length}`);
  }
}

async function askBaseUrl(preset: ProviderPreset, defaultUrl: string): Promise<string> {
  const shown = defaultUrl === "" ? "e.g. https://your-gateway.example.com/v1" : defaultUrl;
  for (;;) {
    const raw = await readInput(`API endpoint URL [${shown}]: `);
    const url = raw === "" ? defaultUrl : raw;
    if (/^https?:\/\//.test(url)) return url.replace(/\/+$/, "");
    console.log("  URL must start with http:// or https://");
  }
}

async function askApiKey(): Promise<string> {
  for (;;) {
    const key = await readInput(`API key (input hidden, stored at ~/.telos/credentials.json): `, { hidden: true });
    if (key === "") return ""; // defer: proceed without a key
    if (key.length >= 8) return key;
    console.log("  that looks too short for an API key — try again, or press Enter to skip");
  }
}

async function askModel(preset: ProviderPreset): Promise<string> {
  for (;;) {
    const raw = await readInput(`Model name [${preset.model === "" ? "(required)" : preset.model}]: `);
    if (raw !== "") return raw;
    if (preset.model !== "") return preset.model;
    console.log("  a model name is required for this provider");
  }
}

/**
 * Ask "use the default endpoint?" for preset providers; answering no lets the
 * user point the provider id at a compatible endpoint. Presets with no
 * default (custom endpoint) skip the question — there is nothing to accept.
 */
async function maybeCustomEndpoint(preset: ProviderPreset): Promise<boolean> {
  if (preset.requiresBaseUrl) return false;
  const raw = (await readInput(`Use ${preset.label}'s default endpoint (${preset.baseUrl})? [Y/n]: `)).trim().toLowerCase();
  return raw === "" || raw === "y" || raw === "yes";
}

function writeProjectConfig(provider: string, baseUrl: string, model: string, apiKeyEnv: string): string {
  const dir = join(process.cwd(), STATE_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.toml");
  if (existsSync(path)) return path; // never clobber an existing project config
  writeFileSync(
    path,
    `# Telos configuration — written by the interactive setup wizard.\n` +
      `# Edit freely; re-run \`telos setup\` to redo this.\n\n` +
      `[model]\nprovider = "${provider}"\nname = "${model}"\nbase_url = "${baseUrl}"\napi_key_env = "${apiKeyEnv}"\n\n` +
      `[runtime]\nautonomy = "balanced"\nmax_total_tokens = 80000\nmax_tool_calls = 40\nmax_worker_spawns = 3\nmax_parallel_workers = 2\nmax_wall_time_seconds = 900\nshell_timeout_seconds = 120\nmax_stream_attempts = 2\nmin_test_count = 1\nstream_timeout_seconds = 120\n\n` +
      `[security]\nconfirm_destructive = true\nblock_secrets = true\n`,
    { mode: 0o644 },
  );
  return path;
}

/** Run the wizard. Caller guarantees a TTY (see isInteractive). */
export async function runSetupWizard(): Promise<SetupResult> {
  try {
    console.log("\nTelos setup — three questions and you're running.\n");
    let preset = await chooseProvider();

    // A custom endpoint that clearly belongs to another provider switches the
    // preset automatically (e.g. choosing OpenAI then typing an OpenRouter URL).
    let baseUrl = preset.baseUrl;
    if (!(await maybeCustomEndpoint(preset))) {
      baseUrl = await askBaseUrl(preset, preset.baseUrl);
      const inferred = inferProviderFromBaseUrl(baseUrl);
      if (inferred && inferred.id !== preset.id) {
        console.log(`  → that endpoint looks like ${inferred.label}; using it.`);
        preset = inferred;
        baseUrl = preset.baseUrl;
      }
    }

    // The provider id stays whatever preset the user settled on — every
    // custom endpoint speaks the OpenAI-compatible wire format with a
    // baseUrl override, so the id is about display and defaults, not behavior.
    const provider = preset.id;
    const finalBaseUrl = baseUrl;

    // Keys for well-known endpoints live under the provider's conventional
    // env-var name; keys for custom endpoints get a neutral name so they
    // never collide with a real OpenAI/Anthropic key stored for another
    // project.
    const isDefaultEndpoint = finalBaseUrl === preset.baseUrl && !preset.requiresBaseUrl;
    const apiKeyEnv = isDefaultEndpoint ? preset.keyEnv : "TELOS_API_KEY";

    const apiKey = await askApiKey();
    const model = await askModel(preset);

    const configPath = writeProjectConfig(provider, finalBaseUrl, model, apiKeyEnv);
    if (apiKey !== "") saveCredential(apiKeyEnv, apiKey);

    return { provider, baseUrl: finalBaseUrl, model, apiKeyEnv, configPath };
  } finally {
    stdin.pause();
  }
}

/** Post-setup summary. Only the env-var NAME is printed, never the key. */
export function printSetupSummary(r: SetupResult): void {
  console.log(
    `\nReady.\n` +
      `  project   ${r.configPath}\n` +
      `  provider  ${r.provider} → ${r.baseUrl}\n` +
      `  model     ${r.model}\n` +
      `  key       stored under ${r.apiKeyEnv} in ~/.telos/credentials.json (mode 600)\n` +
      `Starting your session…\n`,
  );
}
