#!/usr/bin/env node
/**
 * telos launcher.
 *
 * - npm install (global or npx): runs the compiled dist/ JavaScript. Node
 *   refuses to strip types from files under node_modules by design
 *   (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the npm package must
 *   ship plain JS — that is what dist/ is for.
 * - git-clone install (install.sh): runs src/index.ts via Node's native
 *   type stripping (Node 22.18+/24); install.sh builds dist/ as well when a
 *   TypeScript compiler is available, and the launcher prefers it.
 *
 * Node < 22.18 lacks native type stripping entirely: the launcher re-execs
 * with --experimental-strip-types as a fallback.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, "..", "dist", "index.js");
const srcEntry = join(here, "..", "src", "index.ts");

let entry;
let mode;
if (existsSync(distEntry)) {
  entry = distEntry;
  mode = "js";
} else if (existsSync(srcEntry)) {
  entry = srcEntry;
  mode = "ts";
} else {
  console.error("telos: entry point not found — installation appears broken.");
  process.exit(1);
}

if (mode === "js") {
  const r = spawnSync(process.execPath, ["--no-warnings", entry, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// Source mode: Node >= 22.18 strips types natively; older runtimes need the
// experimental flag re-exec.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const r = spawnSync(process.execPath, ["--no-warnings", entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
