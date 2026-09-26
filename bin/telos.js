#!/usr/bin/env node
/**
 * telos launcher.
 *
 * npm install (or npm link) makes `telos` this file. Type stripping is a
 * Node 24+ feature (stable in 23.9+/22.18+ under its previous flag name),
 * so the wrapper re-execs with the right flag when the runtime needs it
 * instead of failing with a SyntaxError on .ts imports.
 *
 * A sibling local checkout (bin/../src) wins if present — the git-clone
 * install path uses that without going through node_modules.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entryTs = join(here, "..", "src", "index.ts");

// Source checkout (curl installer path): bin/../src/index.ts.
// npm package path: the package ships src/, so the same relative path holds.
const entry = existsSync(entryTs) ? entryTs : join(here, "..", "dist", "index.js");
if (!existsSync(entry)) {
  console.error("telos: entry point not found — installation appears broken.");
  process.exit(1);
}

const [major] = process.versions.node.split(".").map(Number);
const needsStrip = major < 24;
const needsFlag = major < 23 || (major === 23 && process.versions.node.split(".")[1] < 9);

if (needsStrip) {
  const flag = needsFlag ? "--experimental-strip-types" : "--experimental-strip-types";
  const r = spawnSync(process.execPath, [flag, "--no-warnings", entry, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const r = spawnSync(process.execPath, ["--no-warnings", entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
