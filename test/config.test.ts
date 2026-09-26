import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml } from "../src/config/toml.ts";
import { parseConfig } from "../src/config/schema.ts";
import { loadConfig } from "../src/config/loader.ts";

test("toml parser handles sections, values, arrays, comments", () => {
  const t = parseToml(`
# comment
[model]
provider = "openai"   # inline comment
name = "gpt-test"
temperature = 0

[runtime]
max_total_tokens = 5000
autonomy = "balanced"
tags = ["a", "b"]
flag = true
`);
  const m = t["model"] as Record<string, unknown>;
  const r = t["runtime"] as Record<string, unknown>;
  assert.equal(m["provider"], "openai");
  assert.equal(m["temperature"], 0);
  assert.equal(r["max_total_tokens"], 5000);
  assert.deepEqual(r["tags"], ["a", "b"]);
  assert.equal(r["flag"], true);
});

test("config defaults apply and validation rejects bad enums", () => {
  const ok = parseConfig({});
  assert.equal(ok.runtime.maxTotalTokens, 80_000);
  assert.equal(ok.runtime.autonomy, "balanced");
  assert.equal(ok.model.apiKeyEnv, "OPENAI_API_KEY");

  assert.throws(() => parseConfig({ model: { provider: "warp-drive" } }), /expected one of/);
  assert.throws(() => parseConfig({ runtime: { max_total_tokens: 5 } }), /must be >=/);
  assert.throws(() => parseConfig({ runtime: { autonomy: "chaos" } }), /expected one of/);
});

test("environment overrides layer over file config", () => {
  const saved = { ...process.env };
  try {
    process.env["TELOS_MODEL"] = "env-model";
    process.env["TELOS_MAX_TOKENS"] = "1234";
    process.env["TELOS_PROVIDER"] = "openrouter";
    const cfg = loadConfig(process.cwd()); // no file in repo root → defaults
    assert.equal(cfg.model.name, "env-model");
    assert.equal(cfg.runtime.maxTotalTokens, 1234);
    assert.equal(cfg.model.provider, "openrouter");
  } finally {
    process.env = saved;
  }
});
