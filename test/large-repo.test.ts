import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { searchText, findFiles } from "../src/tools/search-engine.ts";
import { profileRepository } from "../src/context/profile.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";

/**
 * Scale Batch 1 harness (docs/SCALE_ROADMAP.md): large-repo navigation.
 * Generates a synthetic 3,000+ file tree and asserts the search/profile
 * contract: speed, .gitignore respect, slice reading, binary guard.
 */

function makeBigRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "telos-bigrepo-"));
  // 32 modules × 100 files × ~90 lines ≈ 3,200 files / 290k lines.
  for (let d = 0; d < 32; d++) {
    const dir = join(root, `module${d}`, "src");
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 100; f++) {
      const body = Array.from(
        { length: 90 },
        (_, i) => `export function fn_${d}_${f}_${i}(a: number): number { return a + ${i}; }`,
      ).join("\n");
      writeFileSync(join(dir, `file${f}.ts`), body + "\n");
    }
  }
  // Dependency + gitignored trees that must never leak into results.
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "leak.ts"), "export const UNIQUE_MARKER_NM = 1;\n");
  writeFileSync(join(root, ".gitignore"), "vendored/\n");
  mkdirSync(join(root, "vendored"), { recursive: true });
  writeFileSync(join(root, "vendored", "leak.ts"), "export const UNIQUE_MARKER_GIT = 1;\n");
  // Root manifest + one unique needle in a source file.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "big", scripts: { test: "npm test" } }, null, 2) + "\n");
  writeFileSync(join(root, "module7", "src", "file42.ts"), "export const UNIQUE_MARKER_SRC = 7;\n");
  return root;
}

test("search_text on a 3,200-file tree finds the needle, skips ignored dirs, under 2s", async () => {
  const root = makeBigRepo();
  try {
    const t = Date.now();
    const res = await searchText(root, "UNIQUE_MARKER_SRC", { maxResults: 200 });
    const elapsed = Date.now() - t;
    assert.equal(res.hits.length, 1);
    assert.match(res.hits[0]!.file, /module7\/src\/file42\.ts$/);
    assert.ok(elapsed < 2000, `search took ${elapsed}ms, budget 2000ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node_modules and .gitignore'd dirs never appear in results", async () => {
  const root = makeBigRepo();
  try {
    const res = await searchText(root, "UNIQUE_MARKER", { maxResults: 200 });
    const files = res.hits.map((h) => h.file).join("\n");
    assert.ok(!files.includes("node_modules"), "node_modules leaked");
    assert.ok(!files.includes("vendored"), ".gitignore'd dir leaked");
    assert.equal(res.hits.length, 1, "only the source marker should match");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("find_files locates files by name across the whole tree", async () => {
  const root = makeBigRepo();
  try {
    const res = await findFiles(root, "package.json", { maxResults: 200 });
    assert.ok(res.hits.length >= 1);
    assert.ok(res.hits.some((h) => h.file === "package.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo profile on a big tree: fast, bounded, informative tree + scale line", async () => {
  const root = makeBigRepo();
  try {
    const t = Date.now();
    const p = await profileRepository(root);
    const elapsed = Date.now() - t;
    assert.ok(elapsed < 3000, `profile took ${elapsed}ms`);
    assert.ok(p.totalFiles === null || p.totalFiles >= 3200, `totalFiles=${p.totalFiles}`);
    assert.ok(p.treeText && p.treeText.length > 200 && p.treeText.length <= 3000, `tree size ${(p.treeText ?? "").length}`);
    assert.match(p.treeText!, /module\d+\/  \(\d+ files/);
    assert.ok(p.profileText.length <= 2400, "profile text stays in budget");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read_file: long lines are capped with a visible marker; binary files are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "telos-read-"));
  try {
    writeFileSync(join(root, "long-line.ts"), "const ok = 1;\n" + `const huge = \"${"x".repeat(50_000)}\";\n`);
    writeFileSync(join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
    const registry = new ToolRegistry();
    registerFilesystemTools(registry);
    const ctx = { root, cwd: root, redact: (s: string) => s, maxOutputBytes: 200_000, signal: undefined } as unknown as Parameters<NonNullable<ReturnType<ToolRegistry["get"]>>["execute"]>[1];
    const read = await registry.get("read_file")!.execute({ path: "long-line.ts" }, ctx);
    assert.ok(read.ok);
    assert.ok(read.output.includes("[line truncated to 2000 chars]"), "long line must be capped with a marker");
    assert.ok(read.output.length < 10_000, "output must not contain the full 50k line");
    const bin = await registry.get("read_file")!.execute({ path: "blob.bin" }, ctx);
    assert.equal(bin.ok, false);
    assert.match(bin.output, /binary file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
