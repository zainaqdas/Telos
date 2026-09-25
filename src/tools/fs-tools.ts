import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { ToolDefinition, ToolRegistry, ToolResult } from "./registry.ts";
import { lineDiff, safePath, truncateOutput } from "./util.ts";

/**
 * Filesystem tools (Part 44): read_file, write_file, edit_file,
 * list_directory, find_files, search_text. Edits are targeted (Part 45):
 * edit_file replaces exact old_string occurrences and reports what changed.
 */

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".css",
  ".scss", ".html", ".yml", ".yaml", ".toml", ".sh", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".sql", ".env", ".gitignore", ".xml",
]);

async function readTextFile(ctx: Parameters<ToolDefinition["execute"]>[1], path: string, offset?: number, limit?: number): Promise<{ content: string; totalLines: number }> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n");
  const total = lines.length;
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit && limit > 0 ? Math.min(total, start + limit) : Math.min(total, start + 2000);
  const slice = lines.slice(start, end);
  return { content: slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n"), totalLines: total };
}

function ok(output: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: true, output, meta };
}
function fail(output: string, errorCategory = "tool_error"): ToolResult {
  return { ok: false, output, errorCategory };
}

export function registerFilesystemTools(registry: ToolRegistry): void {
  registry.register({
    name: "read_file",
    description: "Read a text file from the workspace. Returns numbered lines; large files are cut off after ~2000 lines unless offset/limit are given.",
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative or absolute path (must stay inside the workspace)" },
        offset: { type: "integer", description: "1-based line to start from" },
        limit: { type: "integer", description: "Max lines to return" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      try {
        const p = safePath(ctx, String(args["path"] ?? ""));
        const st = await stat(p);
        if (st.isDirectory()) return fail(`path is a directory: ${args["path"]}`);
        const { content, totalLines } = await readTextFile(ctx, p, typeof args["offset"] === "number" ? args["offset"] : undefined, typeof args["limit"] === "number" ? args["limit"] : undefined);
        const t = truncateOutput(ctx.redact(content), ctx.maxOutputBytes);
        return ok(t.text, { totalLines, truncated: t.truncated });
      } catch (err) {
        return fail(`read_file failed: ${(err as Error).message}`, "io_error");
      }
    },
  });

  registry.register({
    name: "write_file",
    description: "Create or fully overwrite a text file in the workspace. Prefer edit_file for modifying existing files.",
    permission: "write",
    mutative: true,
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      try {
        const p = safePath(ctx, String(args["path"] ?? ""));
        const before = await readFile(p, "utf8").catch(() => "");
        await mkdir(dirname(p), { recursive: true });
        await writeFile(p, String(args["content"] ?? ""), "utf8");
        const d = lineDiff(before, String(args["content"] ?? ""));
        return ok(`wrote ${relative(ctx.root, p)} (+${d.added}/-${d.removed} lines)`, { path: relative(ctx.root, p) });
      } catch (err) {
        return fail(`write_file failed: ${(err as Error).message}`, "io_error");
      }
    },
  });

  registry.register({
    name: "edit_file",
    description: "Replace an exact string in a file. Fails if old_string is not found or is ambiguous; use count to allow multiple replacements.",
    permission: "write",
    mutative: true,
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string", description: "Exact text to replace (include surrounding lines to disambiguate)" },
        new_string: { type: "string", description: "Replacement text ('' deletes)" },
        count: { type: "integer", description: "Replace up to N occurrences (default: exactly 1)" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const oldStr = String(args["old_string"] ?? "");
      const newStr = String(args["new_string"] ?? "");
      const count = typeof args["count"] === "number" ? args["count"] : 1;
      try {
        const p = safePath(ctx, String(args["path"] ?? ""));
        const before = await readFile(p, "utf8");
        if (!before.includes(oldStr)) return fail("edit_file: old_string not found in file", "edit_not_found");
        const occurrences = before.split(oldStr).length - 1;
        if (count === 1 && occurrences > 1) {
          return fail(`edit_file: old_string matches ${occurrences} times; include more context to disambiguate`, "edit_ambiguous");
        }
        const after = occurrences <= count ? before.split(oldStr).join(newStr) : replaceN(before, oldStr, newStr, count);
        await writeFile(p, after, "utf8");
        const d = lineDiff(before, after);
        return ok(`edited ${relative(ctx.root, p)} (+${d.added}/-${d.removed})\n${d.preview}`, { path: relative(ctx.root, p) });
      } catch (err) {
        return fail(`edit_file failed: ${(err as Error).message}`, "io_error");
      }
    },
  });

  registry.register({
    name: "list_directory",
    description: "List files and subdirectories of a directory (one level).",
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path, '.' for workspace root" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      try {
        const p = safePath(ctx, String(args["path"] ?? "."));
        const entries = await readdir(p, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return ok(lines.length ? lines.join("\n") : "(empty directory)", { count: entries.length });
      } catch (err) {
        return fail(`list_directory failed: ${(err as Error).message}`, "io_error");
      }
    },
  });

  registry.register({
    name: "find_files",
    description: "Find files by glob-style name pattern (e.g. *.test.ts, package.json). Matches name, not content.",
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob like '*.ts' or 'package.json'" },
        subdir: { type: "string", description: "Restrict to a subdirectory" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const pattern = String(args["pattern"] ?? "");
      if (!pattern) return fail("find_files: pattern required", "bad_args");
      let regex: RegExp;
      try {
        regex = globToRegExp(pattern);
      } catch {
        return fail(`find_files: bad pattern ${pattern}`, "bad_args");
      }
      let base: string;
      try {
        base = args["subdir"] ? safePath(ctx, String(args["subdir"])) : ctx.root;
      } catch (err) {
        return fail(`find_files: ${(err as Error).message}`, "io_error");
      }
      const results: string[] = [];
      const IGNORE = new Set(["node_modules", ".git", ".project-agent", "dist", "build", "coverage", ".next", "__pycache__"]);
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (results.length >= 200 || depth > 12) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (!IGNORE.has(e.name)) await walk(full, depth + 1);
          } else if (regex.test(e.name)) {
            results.push(relative(ctx.root, full));
            if (results.length >= 200) return;
          }
        }
      };
      await walk(base, 0);
      return ok(results.length ? results.join("\n") : "(no matches)", { count: results.length });
    },
  });

  registry.register({
    name: "search_text",
    description: "Search file contents with a literal or regex pattern. Respects common ignore dirs. Prefer narrow patterns and subdirs.",
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Literal text or regex" },
        subdir: { type: "string", description: "Restrict to a subdirectory" },
        is_regex: { type: "boolean", description: "Treat pattern as regex (default false)" },
        max_results: { type: "integer", description: "Default 50" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const pattern = String(args["pattern"] ?? "");
      if (!pattern) return fail("search_text: pattern required", "bad_args");
      let regex: RegExp;
      try {
        regex = args["is_regex"] === true ? new RegExp(pattern, "i") : new RegExp(escapeRe(pattern), "i");
      } catch (err) {
        return fail(`search_text: invalid regex: ${(err as Error).message}`, "bad_args");
      }
      let base: string;
      try {
        base = args["subdir"] ? safePath(ctx, String(args["subdir"])) : ctx.root;
      } catch (err) {
        return fail(`search_text: ${(err as Error).message}`, "io_error");
      }
      const max = typeof args["max_results"] === "number" ? args["max_results"] : 50;
      const out: string[] = [];
      const IGNORE = new Set(["node_modules", ".git", ".project-agent", "dist", "build", "coverage", ".next", "__pycache__"]);
      const MAX_BYTES = 400_000;
      let filesScanned = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (out.length >= max || depth > 14) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (!IGNORE.has(e.name)) await walk(full, depth + 1);
          } else {
            filesScanned++;
            if (filesScanned > 3000) return;
            let isText = TEXT_EXTENSIONS.has(extname(e.name).toLowerCase()) || e.name.startsWith(".") || !extname(e.name);
            if (!isText) continue;
            let content: string;
            try {
              const st = await stat(full);
              if (st.size > MAX_BYTES) continue;
              content = await readFile(full, "utf8");
            } catch {
              continue;
            }
            const lines = content.split("\n");
            for (let i = 0; i < lines.length && out.length < max; i++) {
              const line = lines[i];
              if (line && regex.test(line)) {
                out.push(`${relative(ctx.root, full)}:${i + 1}: ${line.trim().slice(0, 240)}`);
              }
            }
            if (out.length >= max) return;
          }
        }
      };
      await walk(base, 0);
      const t = truncateOutput(ctx.redact(out.join("\n")), ctx.maxOutputBytes);
      return ok(t.text || "(no matches)", { count: out.length, filesScanned });
    },
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function replaceN(text: string, oldStr: string, newStr: string, n: number): string {
  let out = "";
  let rest = text;
  for (let i = 0; i < n; i++) {
    const idx = rest.indexOf(oldStr);
    if (idx === -1) break;
    out += rest.slice(0, idx) + newStr;
    rest = rest.slice(idx + oldStr.length);
  }
  return out + rest;
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
