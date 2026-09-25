import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry, validateToolArgs } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { makeContext, makeRedact, truncateOutput, installSecret } from "../src/tools/util.ts";
import { RepetitionGuard } from "../src/runtime/repetition.ts";

async function withTemp(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "syn-tools-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ctx(dir: string) {
  return makeContext(dir, { shellTimeoutSeconds: 10 });
}

function setup(dir: string): ToolRegistry {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  return registry;
}

test("validateToolArgs enforces schema subset", () => {
  const schema = { type: "object", properties: { path: { type: "string" }, n: { type: "integer" } }, required: ["path"], additionalProperties: false };
  assert.equal(validateToolArgs({ path: "a.ts", n: 3 }, schema).ok, true);
  assert.equal(validateToolArgs({}, schema).ok, false);
  assert.equal(validateToolArgs({ path: 5 }, schema).ok, false);
  assert.equal(validateToolArgs({ path: "a", extra: 1 }, schema).ok, false);
});

test("tool paths cannot escape the workspace", async () => {
  await withTemp(async (dir) => {
    const registry = setup(dir);
    const read = registry.get("read_file")!;
    const res = await read.execute({ path: "../../etc/passwd" }, ctx(dir));
    assert.equal(res.ok, false);
    assert.match(res.output, /escapes workspace/);
  });
});

test("edit_file refuses missing and ambiguous targets, applies unique edits", async () => {
  await withTemp(async (dir) => {
    writeFileSync(join(dir, "code.ts"), "const foo = 1;\nconst bar = foo + 1;\n", "utf8");
    const registry = setup(dir);
    const edit = registry.get("edit_file")!;
    const c = ctx(dir);

    const missing = await edit.execute({ path: "code.ts", old_string: "NOT THERE", new_string: "x" }, c);
    assert.equal(missing.ok, false);

    writeFileSync(join(dir, "dup.ts"), "let a = 1;\nlet a = 2;\n", "utf8");
    const ambiguous = await edit.execute({ path: "dup.ts", old_string: "let a", new_string: "let b" }, c);
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.output, /disambiguate/);

    const good = await edit.execute({ path: "code.ts", old_string: "const bar = foo + 1;", new_string: "const bar = foo + 2;" }, c);
    assert.equal(good.ok, true);
    assert.match(good.output, /\+1\/-1/);
    assert.equal(readFileSync(join(dir, "code.ts"), "utf8"), "const foo = 1;\nconst bar = foo + 2;\n");
  });
});

test("write_file creates parent directories and reports the change", async () => {
  await withTemp(async (dir) => {
    const registry = setup(dir);
    const write = registry.get("write_file")!;
    const res = await write.execute({ path: "src/nested/new.ts", content: "export {};\n" }, ctx(dir));
    assert.equal(res.ok, true);
    assert.equal(readFileSync(join(dir, "src/nested/new.ts"), "utf8"), "export {};\n");
  });
});

test("search_text finds matches with line numbers", async () => {
  await withTemp(async (dir) => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/a.ts"), "export const alpha = 1;\nexport const beta = 2;\n", "utf8");
    const registry = setup(dir);
    const search = registry.get("search_text")!;
    const res = await search.execute({ pattern: "beta" }, ctx(dir));
    assert.equal(res.ok, true);
    assert.match(res.output, /src\/a\.ts:2/);
  });
});

test("redaction removes API keys from tool output", () => {
  installSecret("sk-super-secret-value-123456");
  const redact = makeRedact();
  const text = "using key sk-super-secret-value-123456 in prod";
  assert.equal(redact(text), "using key [REDACTED] in prod");
  assert.match(redact("token=abcd1234abcd1234abcd"), /\[REDACTED\]/);
});

test("truncateOutput caps giant tool output", () => {
  const big = "x".repeat(100_000);
  const t = truncateOutput(big, 1000);
  assert.equal(t.truncated, true);
  assert.ok(t.text.length < 2000);
  assert.match(t.text, /truncated/);
});

test("repetition guard blocks identical repeated failures but allows changed state", () => {
  const guard = new RepetitionGuard({ maxIdenticalFailures: 2, maxConsecutiveFailures: 10 });
  const key = "run_shell:{\"command\":\"npm run dev\"}";
  const fp1 = "state-A";

  assert.equal(guard.evaluate(key, fp1).verdict, "NEW");
  guard.record(key, fp1, false, "port_in_use");
  // One grace retry at the same state…
  assert.equal(guard.evaluate(key, fp1).verdict, "CHANGED_RETRY");
  guard.record(key, fp1, false, "port_in_use");
  // …then the runtime refuses blind repetition of an identical failure.
  const third = guard.evaluate(key, fp1);
  assert.equal(third.verdict, "REPEATED_FAILURE");

  // Environment meaningfully changed → the call is NEW again (never observed failing in this state).
  assert.equal(guard.evaluate(key, "state-B").verdict, "NEW");
  guard.record(key, "state-B", true);
  assert.equal(guard.evaluate(key, "state-B").verdict, "SAFE_RETRY");
});
