/**
 * Machine-scoped credential store (BYOK without editing files).
 *
 * Keys live in `~/.telos/credentials.json` with mode 0600, outside every
 * project, so a key entered once works in all projects and is never written
 * into a repository. Environment variables always win over the store, so
 * CI/shell exports keep the higher-priority contract (env > store > none).
 *
 * The store holds only provider API keys, under names that are either plain
 * provider ids ("openai") or the user's own env-var names ("VYCEAI_API_KEY")
 * as chosen by the setup wizard.
 *
 * Secrets must never be echoed or logged; the public API returns values only
 * to the process that asked, and exportView() exists exclusively for the
 * session boot path to inject into process.env (in-memory only).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CREDENTIALS_FILENAME = "credentials.json";

export function credentialsPath(): string {
  return join(homedir(), ".telos", CREDENTIALS_FILENAME);
}

interface StoreShape {
  version: 1;
  keys: Record<string, string>;
}

function emptyStore(): StoreShape {
  return { version: 1, keys: {} };
}

function readStore(): StoreShape {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf8")) as Partial<StoreShape>;
    if (!raw || typeof raw !== "object" || typeof raw.keys !== "object" || raw.keys === null) return emptyStore();
    const keys: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.keys)) {
      if (typeof k === "string" && typeof v === "string" && k.length > 0 && v.length > 0) keys[k] = v;
    }
    return { version: 1, keys };
  } catch {
    // Missing or corrupt store behaves as empty — setup can rewrite it.
    return emptyStore();
  }
}

function writeStore(store: StoreShape): void {
  const path = credentialsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // belt and braces if umask intervened
  } catch {
    /* chmod failure is not fatal on odd filesystems */
  }
}

/** Persist one key under the given name. Overwrites silently by design. */
export function saveCredential(name: string, value: string): void {
  const clean = name.trim();
  if (clean.length === 0) throw new Error("credential name must not be empty");
  if (value.trim().length === 0) throw new Error("credential value must not be empty");
  const store = readStore();
  store.keys[clean] = value.trim();
  writeStore(store);
}

/** Remove one stored key. Safe to call when absent. */
export function deleteCredential(name: string): void {
  const store = readStore();
  delete store.keys[name];
  const empty = Object.keys(store.keys).length === 0;
  try {
    if (empty) unlinkSync(credentialsPath());
    else writeStore(store);
  } catch {
    /* already gone */
  }
}

/** Stored value for a name, or undefined. */
export function getCredential(name: string): string | undefined {
  const v = readStore().keys[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Names of stored keys (values are never exposed here). */
export function listCredentials(): string[] {
  return Object.keys(readStore().keys).sort();
}

/**
 * Single resolution point for the BYOK contract: the env var named
 * `apiKeyEnv` first, then a stored credential under that same name, then
 * under the bare provider id written by the wizard. Returns "" when unset —
 * the caller decides how to surface a missing key.
 */
export function resolveApiKeyWithStore(apiKeyEnv: string, provider: string): string {
  const fromEnv = process.env[apiKeyEnv];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const stored = getCredential(apiKeyEnv) ?? getCredential(provider);
  return stored ?? "";
}

/**
 * Session boot convenience: resolve and inject into process.env under
 * `apiKeyEnv` when nothing is already set there. In-memory only; the key
 * reaches the provider through the normal env-var path.
 */
export function injectStoredCredential(apiKeyEnv: string, provider: string): boolean {
  const existing = process.env[apiKeyEnv];
  if (typeof existing === "string" && existing.length > 0) return false;
  const stored = resolveApiKeyWithStore(apiKeyEnv, provider);
  if (!stored) return false;
  process.env[apiKeyEnv] = stored;
  return true;
}
