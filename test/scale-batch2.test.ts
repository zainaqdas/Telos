import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveModelLimits, compactionThreshold, noteObservedCap, effectiveMaxOutput } from "../src/providers/catalog.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";

/**
 * Scale Batch 2 tests (docs/SCALE_ROADMAP.md): model catalog, compaction
 * thresholds from real limits, tool-output spill, prompt-cache stability.
 */

test("catalog: known models resolve from the table; unknown models get conservative defaults", () => {
  const ds = resolveModelLimits("deepseek-v4.1");
  assert.equal(ds.source, "catalog");
  assert.equal(ds.contextWindow, 128_000);
  assert.equal(ds.reasoningField, true);

  const gpt5 = resolveModelLimits("gpt-5-mini");
  assert.equal(gpt5.contextWindow, 400_000);

  const unknown = resolveModelLimits("mystery-gateway-model");
  assert.equal(unknown.source, "defaults");
  assert.ok(unknown.contextWindow <= 64_000, "unknown models assume a small context");
});

test("compaction threshold derives from the context window and output reserve", () => {
  const small = compactionThreshold(resolveModelLimits("mystery-model"));
  const big = compactionThreshold(resolveModelLimits("gpt-5-mini"));
  assert.ok(small >= 8_000, "floor: threshold never tiny");
  assert.ok(big > small, "bigger context → later compaction");
  assert.ok(big < 400_000, "threshold keeps a reserve below the window");
});

test("observed cap learning: truncation tightens effectiveMaxOutput exactly once", () => {
  const limits = resolveModelLimits("deepseek-v4.1");
  const before = effectiveMaxOutput(limits);
  const after = noteObservedCap(limits, 4095);
  assert.equal(effectiveMaxOutput(after), 4096);
  assert.equal(after.source, "observed");
  // A later, larger observation does not loosen the cap; a smaller one can.
  const notLoosened = noteObservedCap(after, 32_000);
  assert.equal(effectiveMaxOutput(notLoosened), 4096);
  const tightened = noteObservedCap(after, 2_000);
  assert.equal(effectiveMaxOutput(tightened), 2_048);
  assert.ok(effectiveMaxOutput(limits) === before, "input object is not mutated");
});

test("registry disable keeps specs() stable: same tools, same order, byte-identical after restore", () => {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const before = JSON.stringify(registry.specs());
  const beforeNames = registry.specs().map((s) => s.name);

  // Disable two write tools mid-run.
  registry.setDisabled("write_file", true);
  registry.setDisabled("edit_file", true);
  assert.equal(registry.get("write_file"), undefined, "disabled tools resolve as absent");

  // Same tool list in the same order (the tools prefix is position-stable;
  // only the description text is swapped for a disabled notice).
  const duringNames = registry.specs().map((s) => s.name);
  assert.deepEqual(duringNames, beforeNames);
  const specDuring = registry.specs().find((s) => s.name === "write_file")!;
  assert.match(specDuring.description, /disabled/);

  // Re-enable: exact original serialization returns (order never changed).
  registry.setDisabled("write_file", false);
  registry.setDisabled("edit_file", false);
  assert.equal(JSON.stringify(registry.specs()), before);
});
