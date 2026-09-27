import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Conventions injection (Scale Batch 5, docs/SCALE_ROADMAP.md item 15):
 * AGENTS.md / TELOS.md from the project root and its parents are loaded into
 * the system prompt — the OpenCode instruction-discovery pattern. Telos treats
 * them as context for the model, not as runtime policy: the runtime still
 * enforces every invariant itself (Part 63: assume the model can be wrong).
 *
 * Precedence: TELOS.md wins over AGENTS.md in the same directory. Closer
 * directories win on conflict (root first, then parents outward). Total
 * injection is hard-capped so a huge conventions file can't eat the context.
 */

const FILE_NAMES = ["TELOS.md", "AGENTS.md"];
const MAX_TOTAL_CHARS = 24_000;
const MAX_FILE_CHARS = 12_000;

export interface Conventions {
  /** Rendered block for the system prompt; "" when nothing was found. */
  text: string;
  /** Files actually loaded (display order: root → outward). */
  files: string[];
}

/**
 * Discover convention files starting at `root` and walking parent directories
 * up to the filesystem root. symlinks resolve before comparison so a linked
 * workspace contributes its real path once, not twice.
 */
export function loadConventions(root: string): Conventions {
  const files: string[] = [];
  const blocks: string[] = [];
  let budget = MAX_TOTAL_CHARS;

  const seen = new Set<string>();
  let dir = resolve(root);
  while (true) {
    const key = dir.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      for (const name of FILE_NAMES) {
        const file = join(dir, name);
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        let content: string;
        try {
          content = readFileSync(file, "utf8");
        } catch {
          continue; // unreadable conventions are skipped, never fatal
        }
        const clipped = content.length > MAX_FILE_CHARS ? `${content.slice(0, MAX_FILE_CHARS)}\n… [${name} truncated at ${MAX_FILE_CHARS} chars]` : content;
        if (clipped.length > budget) {
          blocks.push(`# Conventions (${file}) — omitted: conventions budget exhausted`);
          files.push(file);
          return { text: blocks.length ? blocks.join("\n\n") : "", files };
        }
        budget -= clipped.length;
        blocks.push(`# Conventions (${file})\n${clipped.trim()}`);
        files.push(file);
        break; // TELOS.md/AGENTS.md: one file per directory
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { text: blocks.length ? blocks.join("\n\n") : "", files };
}
