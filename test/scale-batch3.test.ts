import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { EditJournal, journalWriteTools } from "../src/session/journal.ts";
import { gitSnapshot, gitUndoToSnapshot } from "../src/session/session-undo.ts";

/** Scale Batch 3 tests (docs/SCALE_ROADMAP.md): edit reliability + rollback. */

function makeRegistry(dir: string): { registry: ToolRegistry; ctx: Record<string, unknown> } {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const ctx = { root: dir, cwd: dir, redact: (s: string) => s, maxOutputBytes: 100_000, signal: undefined } as unknown as Record<string, unknown>;
  return { registry, ctx };
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "telos-gitundo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "keep.txt"), "original\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

test("edit ladder: whitespace-normalized match applies when exact match fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-edit-"));
  try {
    writeFileSync(join(dir, "a.ts"), "function hello() {\n    return 1;\n}\n");
    const { registry, ctx } = makeRegistry(dir);
    const res = await registry.get("edit_file")!.execute(
      { path: "a.ts", old_string: "function hello() {\n  return 1;\n}", new_string: "function hello() {\n  return 42;\n}" },
      ctx as never,
    );
    assert.ok(res.ok, res.output);
    assert.match(res.output, /whitespace-normalized/);
    assert.match(readFileSync(join(dir, "a.ts"), "utf8"), /return 42/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit ladder: nearest-match hint on a miss gives the line and char delta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-edit-"));
  try {
    writeFileSync(join(dir, "b.ts"), "function computeTotal(items) {\n  return 1;\n}\n");
    const { registry, ctx } = makeRegistry(dir);
    const res = await registry.get("edit_file")!.execute(
      { path: "b.ts", old_string: "function computeTotals(items) {\n  return 1;\n}", new_string: "x" },
      ctx as never,
    );
    assert.equal(res.ok, false);
    assert.match(res.output, /Closest match is at line 1/);
    assert.match(res.output, /read_file offset 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-edit syntax check: node --check failure surfaces on a .js edit that breaks syntax", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-syntax-"));
  try {
    writeFileSync(join(dir, "app.js"), "function f() {\n  return 1;\n}\n");
    const { registry, ctx } = makeRegistry(dir);
    const res = await registry.get("edit_file")!.execute(
      { path: "app.js", old_string: "  return 1;", new_string: "  return {a: [1, 2;\n}" },
      ctx as never,
    );
    assert.ok(res.ok, "the edit itself still applies");
    assert.match(res.output, /syntax: SUSPECT/, `expected suspect note, got: ${res.output}`);
    // And a clean edit reports OK.
    writeFileSync(join(dir, "clean.js"), "const v = 1;\n");
    const res2 = await registry.get("edit_file")!.execute(
      { path: "clean.js", old_string: "const v = 1;", new_string: "const v = 2;" },
      ctx as never,
    );
    assert.match(res2.output, /syntax: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git-backed /undo: workspace restores to snapshot; post-snapshot files removed", async () => {
  const dir = makeGitRepo();
  try {
    const { registry, ctx } = makeRegistry(dir);
    // Wire the same first-write snapshot hook the session uses: write_file →
    // journal hook → gitSnapshot. This exercises the production path end to end.
    journalWriteTools(registry, new EditJournal(), async () => {
      await gitSnapshot(dir);
    });
    // Simulate a session write: modify keep.txt and create new.txt.
    await registry.get("write_file")!.execute({ path: "keep.txt", content: "modified by agent\n" }, ctx as never);
    await registry.get("write_file")!.execute({ path: "new.txt", content: "created by agent\n" }, ctx as never);
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "modified by agent\n");
    assert.ok(existsSync(join(dir, "new.txt")));

    const snap = spawnSync("git", ["rev-parse", "--verify", "refs/telos/snapshot"], { cwd: dir, encoding: "utf8" });
    assert.equal(snap.status, 0, "snapshot ref must exist after the first write");

    const result = await gitUndoToSnapshot(dir);
    assert.equal(result.restored, true);
    assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "original\n", "modification rolled back");
    assert.equal(existsSync(join(dir, "new.txt")), false, "created file removed by undo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git undo is a no-op outside a git repo (journal path stays authoritative)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telos-nogit-"));
  try {
    const { gitUndoToSnapshot } = await import("../src/session/session-undo.ts");
    const result = await gitUndoToSnapshot(dir);
    assert.equal(result.restored, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
