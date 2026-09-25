import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { profileRepository } from "../src/context/profile.ts";

/** Build a synthetic "unfamiliar repository" (Phase 2 acceptance fixture). */
function makeUnfamiliarRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "syn-ctx-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "mystery-app",
      scripts: { test: "vitest run", build: "vite build", lint: "eslint .", dev: "vite" },
      dependencies: { react: "^18.0.0", express: "^4.0.0" },
      devDependencies: { vitest: "^1.0.0", eslint: "^8.0.0", typescript: "^5.0.0" },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), "", "utf8");
  writeFileSync(join(dir, "AGENTS.md"), "# Agent rules\nUse plain CSS. Never touch /legacy.\n", "utf8");
  writeFileSync(join(dir, "tsconfig.json"), "{}", "utf8");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "export const app = 1;\n", "utf8");
  writeFileSync(join(dir, "src", "server.ts"), "export const server = 2;\n", "utf8");
  mkdirSync(join(dir, "src", "components"));
  writeFileSync(join(dir, "src", "components", "Button.tsx"), "export const Button = () => null;\n", "utf8");
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "tests", "app.test.ts"), "import { test } from 'vitest';\n", "utf8");
  return dir;
}

test("profile identifies stack, package manager, and test command", async () => {
  const dir = makeUnfamiliarRepo();
  try {
    const p = await profileRepository(dir);
    const langs = p.languages.map((l) => l.language);
    assert.ok(langs.includes("typescript"), `expected typescript in ${JSON.stringify(langs)}`);
    assert.ok(p.frameworks.includes("React"));
    assert.ok(p.frameworks.includes("Express"));
    assert.match(p.packageManager ?? "", /pnpm/);
    assert.equal(p.scripts["test"], "vitest run");
    assert.match(p.profileText, /test: pnpm test/);
    assert.match(p.profileText, /pnpm \(pnpm-lock\.yaml\)/);
    assert.match(p.profileText, /key dirs: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile discovers project instructions and includes them in text", async () => {
  const dir = makeUnfamiliarRepo();
  try {
    const p = await profileRepository(dir);
    assert.equal(p.instructionFiles[0]?.path, "AGENTS.md");
    assert.match(p.profileText, /project instructions: AGENTS\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile stays within budget and never dumps file contents", async () => {
  const dir = makeUnfamiliarRepo();
  try {
    // Plant a large file; profile must not inline it.
    writeFileSync(join(dir, "src", "big.ts"), "x".repeat(80_000), "utf8");
    const p = await profileRepository(dir, 1500);
    assert.ok(p.profileText.length <= 1600, `profile too long: ${p.profileText.length}`);
    assert.ok(!p.profileText.includes("xxxxxx"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-node ecosystems are recognized (cargo, go)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-ctx2-"));
  try {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = \"x\"\n", "utf8");
    const p = await profileRepository(dir);
    assert.ok(p.languages.some((l) => l.language === "rust"));
    assert.equal(p.scripts["test"], "cargo test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
