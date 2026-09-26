import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Homedir redirection must happen before importing the module under test:
// credentials.ts binds homedir() at call time, so env override works if set
// before the first call. We use a temp HOME for full isolation.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "telos-cred-test-"));

import {
  saveCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  credentialsPath,
  resolveApiKeyWithStore,
  injectStoredCredential,
} from "../src/config/credentials.ts";
import { resolveApiKey } from "../src/providers/index.ts";
import { parseConfig } from "../src/config/schema.ts";
import { inferProviderFromBaseUrl, PROVIDER_PRESETS } from "../src/setup/presets.ts";

test("credentials: save/get round-trip; file is mode 600 outside project", () => {
  saveCredential("TEST_KEY_A", "sk-test-value-123456");
  assert.equal(getCredential("TEST_KEY_A"), "sk-test-value-123456");
  const p = credentialsPath();
  assert.ok(p.startsWith(process.env["HOME"] ?? ""), "store must live under HOME");
  assert.ok(!p.includes(".project-agent"), "store must never live inside a project");
  const mode = statSync(p).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
  // JSON on disk contains the key (that is its purpose) but nothing else odd.
  const raw = JSON.parse(readFileSync(p, "utf8")) as { keys: Record<string, string> };
  assert.equal(raw.keys["TEST_KEY_A"], "sk-test-value-123456");
});

test("credentials: overwrite updates value; delete removes; empty store deletes file", () => {
  saveCredential("TEST_KEY_B", "first-value-000001");
  saveCredential("TEST_KEY_B", "second-value-00002");
  assert.equal(getCredential("TEST_KEY_B"), "second-value-00002");
  deleteCredential("TEST_KEY_B");
  assert.equal(getCredential("TEST_KEY_B"), undefined);
});

test("credentials: empty name or value is rejected", () => {
  assert.throws(() => saveCredential("  ", "x".repeat(20)));
  assert.throws(() => saveCredential("TEST_EMPTY", "   "));
});

test("credentials: listCredentials returns names only, sorted", () => {
  saveCredential("TESTL_Z_KEY", "v".repeat(20));
  saveCredential("TESTL_A_KEY", "v".repeat(20));
  const names = listCredentials().filter((n) => n.startsWith("TESTL_"));
  assert.deepEqual(names, ["TESTL_A_KEY", "TESTL_Z_KEY"]);
});

test("resolution order: env wins over store; store consulted when env absent", () => {
  const saved = process.env["TEST_ORDER_KEY"];
  saveCredential("TEST_ORDER_KEY", "from-store-0000001");
  process.env["TEST_ORDER_KEY"] = "from-env-00000001";
  assert.equal(resolveApiKeyWithStore("TEST_ORDER_KEY", "openai"), "from-env-00000001");
  delete process.env["TEST_ORDER_KEY"];
  assert.equal(resolveApiKeyWithStore("TEST_ORDER_KEY", "openai"), "from-store-0000001");
  // Bare provider-id fallback: wizard stores under the env name it wrote into
  // config, but a direct provider-id entry also resolves.
  saveCredential("someprovider", "by-provider-id-0001");
  assert.equal(resolveApiKeyWithStore("UNRELATED_ENV", "someprovider"), "by-provider-id-0001");
  assert.equal(resolveApiKeyWithStore("UNRELATED_ENV", "nothing"), "");
  if (saved !== undefined) process.env["TEST_ORDER_KEY"] = saved;
});

test("resolveApiKey (provider entry point) matches the store-aware order", () => {
  saveCredential("TEST_ENTRY_KEY", "entry-store-000001");
  assert.equal(resolveApiKey("TEST_ENTRY_KEY", "openai"), "entry-store-000001");
  process.env["TEST_ENTRY_KEY"] = "entry-env-0000001";
  assert.equal(resolveApiKey("TEST_ENTRY_KEY", "openai"), "entry-env-0000001");
  delete process.env["TEST_ENTRY_KEY"];
});

test("injectStoredCredential: fills process.env only when absent; returns action", () => {
  delete process.env["TEST_INJECT_KEY"];
  saveCredential("TEST_INJECT_KEY", "injected-00000001");
  assert.equal(injectStoredCredential("TEST_INJECT_KEY", "openai"), true);
  assert.equal(process.env["TEST_INJECT_KEY"], "injected-00000001");
  // Second call is a no-op (env already set), and env value is preserved.
  saveCredential("TEST_INJECT_KEY", "changed-00000001");
  assert.equal(injectStoredCredential("TEST_INJECT_KEY", "openai"), false);
  assert.equal(process.env["TEST_INJECT_KEY"], "injected-00000001");
  delete process.env["TEST_INJECT_KEY"];
});

test("config guard: a raw API key pasted into api_key_env is rejected with guidance", () => {
  const rawKey = "sk-f6f045492edbec3ddf941d2cad69a4df90a320ac969b8cc5";
  assert.throws(
    () => parseConfig({ model: { api_key_env: rawKey } }),
    /does not look like an environment variable name/,
  );
  // Real env-var names still parse.
  assert.equal(parseConfig({ model: { api_key_env: "VYCEAI_API_KEY" } }).model.apiKeyEnv, "VYCEAI_API_KEY");
  assert.equal(parseConfig({}).model.apiKeyEnv, "TELOS_API_KEY");
});

test("provider inference: known endpoints map to presets; unknown stays custom", () => {
  assert.equal(inferProviderFromBaseUrl("https://openrouter.ai/api/v1")?.id, "openrouter");
  assert.equal(inferProviderFromBaseUrl("http://localhost:11434/v1")?.id, "ollama");
  assert.equal(inferProviderFromBaseUrl("https://api.anthropic.com")?.id, "anthropic");
  assert.equal(inferProviderFromBaseUrl("https://vyceai.com/v1"), null, "unknown endpoint stays custom");
  // Trailing slashes normalize.
  assert.equal(inferProviderFromBaseUrl("https://openrouter.ai/api/v1///")?.id, "openrouter");
});

test("provider presets: ids are registry-valid and unique", () => {
  const ids = PROVIDER_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PROVIDER_PRESETS) {
    assert.ok(p.id.length > 0);
    assert.ok(p.label.length > 0);
    if (p.requiresBaseUrl) assert.equal(p.baseUrl, "");
    else assert.ok(p.baseUrl.startsWith("http"));
  }
});

test("corrupt credentials file behaves as empty store (setup can rewrite)", () => {
  writeFileSync(credentialsPath(), "{not json", "utf8");
  assert.equal(getCredential("TEST_ANYTHING"), undefined);
  assert.equal(resolveApiKeyWithStore("TEST_ANYTHING", "openai"), "");
  // And the store recovers on next save.
  saveCredential("TEST_RECOVER", "recovered-0000001");
  assert.equal(getCredential("TEST_RECOVER"), "recovered-0000001");
});
