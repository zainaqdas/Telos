import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { ToolDefinition, ToolRegistry, ToolResult } from "./registry.ts";
import { lineDiff, safePath, truncateOutput } from "./util.ts";
import { searchText as engineSearch, findFiles as engineFind } from "./search-engine.ts";

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
  // Per-line cap (OpenCode parity): one minified 5MB line must not eat the
  // whole output budget. A visible marker tells the model the line was cut.
  const MAX_LINE = 2_000;
  const content = slice
    .map((l, i) => {
      const line = l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated to ${MAX_LINE} chars]` : l;
      return `${start + i + 1}\t${line}`;
    })
    .join("\n");
  return { content, totalLines: total };
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
    description:
      "Read a text file from the workspace. Returns numbered lines. Default window: 2000 lines from the start (or from offset). To continue a large file, call again with a larger offset. Lines longer than 2000 chars are truncated. Prefer search_text/find_files to locate targets instead of reading blindly.",
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
        // Binary guard: reading a binary as utf8 floods the output budget with
        // replacement garbage. Detect the NUL byte early and say what to do.
        if (await looksBinary(p)) {
          return fail(`binary file (${st.size} bytes) — not shown as text. If you need its contents, use run_shell with an appropriate tool (strings, base64, xxd).`, "binary_file");
        }
        const { content, totalLines } = await readTextFile(ctx, p, typeof args["offset"] === "number" ? args["offset"] : undefined, typeof args["limit"] === "number" ? args["limit"] : undefined);
        const t = truncateOutput(ctx.redact(content), ctx.maxOutputBytes);
        const continueHint = totalLines > 2000 && (typeof args["offset"] !== "number") ? `\n[${totalLines} lines total — call again with offset to continue]` : "";
        return ok(t.text + continueHint, { totalLines, truncated: t.truncated });
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
    name: "append_file",
    description:
      "Append text to the end of a file (created if missing) in the workspace. Use for chunked writing when a file is too long for one write_file call: write_file the first chunk, then append_file the rest in order.",
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
        const addition = String(args["content"] ?? "");
        await writeFile(p, before + addition, "utf8");
        return ok(
          `appended ${addition.length} bytes to ${relative(ctx.root, p)} (file now ${before.length + addition.length} bytes)`,
          { path: relative(ctx.root, p), appendedBytes: addition.length, totalBytes: before.length + addition.length },
        );
      } catch (err) {
        return fail(`append_file failed: ${(err as Error).message}`, "io_error");
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

        // ── Edit resolution ladder (Aider's, ported; Scale Batch 3) ──
        // 1. exact match (count-aware)
        // 2. whitespace-normalized match (indentation drift)
        // 3. blank-line-tolerant match
        // 4. failure with the nearest-match line so the model can retry once.
        let after: string | null = null;
        let via = "exact";
        if (before.includes(oldStr)) {
          const occurrences = before.split(oldStr).length - 1;
          if (count === 1 && occurrences > 1) {
            return fail(`edit_file: old_string matches ${occurrences} times; include more surrounding lines to disambiguate`, "edit_ambiguous");
          }
          after = occurrences <= count ? before.split(oldStr).join(newStr) : replaceN(before, oldStr, newStr, count);
        }
        if (after === null && oldStr.trim().length > 0) {
          const ws = matchWhitespace(before, oldStr);
          if (ws) {
            after = applyReplacement(before, ws.matchText, newStr); // keep old indentation? new_string is used verbatim
            via = "whitespace-normalized";
          }
        }
        if (after === null && oldStr.trim().length > 0) {
          const blank = matchBlankLineTolerant(before, oldStr);
          if (blank) {
            after = applyReplacement(before, blank.matchText, newStr);
            via = "blank-line-tolerant";
          }
        }
        if (after === null) {
          const hint = nearestMatchHint(before, oldStr);
          return fail(`edit_file: old_string not found in file.${hint ? ` Closest match is at line ${hint.line} (${hint.delta} chars differ) — read that region with read_file offset ${Math.max(1, hint.line - 5)} and retry with the exact current text.` : " Read the file and retry with the exact current text."}`, "edit_not_found");
        }

        await writeFile(p, after, "utf8");
        const d = lineDiff(before, after);
        const viaNote = via === "exact" ? "" : ` (matched via ${via})`;
        const syntax = await syntaxCheck(p, after);
        const syntaxNote = syntax === null ? "" : syntax.ok ? "\nsyntax: OK" : `\nsyntax: SUSPECT — ${syntax.detail}`;
        return ok(`edited ${relative(ctx.root, p)} (+${d.added}/-${d.removed})${viaNote}${syntaxNote}\n${d.preview}`, { path: relative(ctx.root, p), matchedVia: via, syntax: syntax?.ok });
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
    description: "Find files by glob-style name pattern (e.g. *.test.ts, package.json). Matches name, not content. Honors .gitignore and skips dependency/build dirs. Preferred over guessing paths in a large repo.",
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
      let base = ctx.root;
      if (args["subdir"]) {
        try {
          base = safePath(ctx, String(args["subdir"]));
        } catch (err) {
          return fail(`find_files: ${(err as Error).message}`, "io_error");
        }
      }
      const res = await engineFind(base, pattern, { maxResults: 200 });
      const files = res.hits.map((h) => h.file);
      const note = res.truncated ? `\n… [truncated at ${res.hits.length} results — narrow the pattern]` : "";
      return ok(files.length ? files.join("\n") + note : "(no matches)", { count: files.length });
    },
  });

  registry.register({
    name: "search_text",
    description: "Search file contents with a literal or regex pattern. Uses ripgrep when available (fast on huge repos, honors .gitignore); otherwise a built-in scanner. Up to 3 matches per file. Prefer narrow patterns and a subdir in very large repos.",
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Literal text or regex" },
        subdir: { type: "string", description: "Restrict to a subdirectory" },
        is_regex: { type: "boolean", description: "Treat pattern as regex (default false)" },
        max_results: { type: "integer", description: "Default 200" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const pattern = String(args["pattern"] ?? "");
      if (!pattern) return fail("search_text: pattern required", "bad_args");
      const regexSource = args["is_regex"] === true ? pattern : escapeRe(pattern);
      let base = ctx.root;
      if (args["subdir"]) {
        try {
          base = safePath(ctx, String(args["subdir"]));
        } catch (err) {
          return fail(`search_text: ${(err as Error).message}`, "io_error");
        }
      }
      const max = typeof args["max_results"] === "number" ? args["max_results"] : 200;
      const res = await engineSearch(base, regexSource, { maxResults: max });
      if (res.regexError) return fail(`search_text: invalid regex: ${res.regexError}`, "bad_args");
      const out = res.hits.map((h) => `${h.file}:${h.line}: ${h.text}`);
      const note = res.truncated ? `\n… [truncated at ${res.hits.length} results — narrow the pattern or add a subdir]` : "";
      const t = truncateOutput(ctx.redact(out.join("\n")) + note, ctx.maxOutputBytes);
      return ok(t.text || "(no matches)", { count: res.hits.length, engine: res.engine, truncated: res.truncated });
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

// ─── Edit ladder helpers (Scale Batch 3; Aider's ladder, ported) ─────────────

/** Replace the FIRST occurrence of matchText with newStr (count>1 not needed on fuzzy paths). */
function applyReplacement(text: string, matchText: string, newStr: string): string {
  const idx = text.indexOf(matchText);
  if (idx === -1) return text;
  return text.slice(0, idx) + newStr + text.slice(idx + matchText.length);
}

/**
 * Whitespace-normalized match: find oldStr ignoring per-line leading/trailing
 * whitespace differences. Returns the actual matched text from the file (so
 * the replacement splices out the real region), or null. Refuses ambiguous
 * multi-matches on the exact-one path.
 */
function matchWhitespace(before: string, oldStr: string): { matchText: string } | null {
  const norm = (s: string): string =>
    s
      .split("\n")
      .map((l) => l.trim())
      .join("\n");
  const target = norm(oldStr);
  if (!target) return null;
  const fileLines = before.split("\n");
  const needleLines = oldStr.split("\n");
  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + needleLines.length <= fileLines.length; i++) {
    let j = 0;
    while (j < needleLines.length && fileLines[i + j]!.trim() === needleLines[j]!.trim()) j++;
    if (j === needleLines.length) {
      matches.push({ start: i, end: i + needleLines.length });
      if (matches.length > 1) return null; // ambiguous even fuzzily
    }
  }
  if (matches.length !== 1) return null;
  const { start, end } = matches[0]!;
  return { matchText: fileLines.slice(start, end).join("\n") };
}

/** Blank-line-tolerant match: like whitespace match but empty needle lines match any line gap. */
function matchBlankLineTolerant(before: string, oldStr: string): { matchText: string } | null {
  const needleLines = oldStr.split("\n");
  if (!needleLines.some((l) => l.trim() === "")) return null; // only helps when blanks exist
  const fileLines = before.split("\n");
  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < fileLines.length; i++) {
    let fi = i;
    let j = 0;
    while (j < needleLines.length && fi < fileLines.length) {
      const want = needleLines[j]!.trim();
      if (want === "") {
        j++;
        continue; // blank needle line: skip (matches zero or more lines)
      }
      if (fileLines[fi]!.trim() === want) {
        fi++;
        j++;
      } else if (fileLines[fi]!.trim() === "") {
        fi++; // skip blank file lines the needle didn't mention
      } else {
        break;
      }
    }
    while (j < needleLines.length && needleLines[j]!.trim() === "") j++;
    if (j === needleLines.length) {
      matches.push({ start: i, end: fi });
      if (matches.length > 1) return null;
    }
  }
  if (matches.length !== 1) return null;
  const { start, end } = matches[0]!;
  return { matchText: fileLines.slice(start, end).join("\n") };
}

/** Line of the closest match (by Levenshtein on trimmed lines) for the retry hint. */
function nearestMatchHint(before: string, oldStr: string): { line: number; delta: number } | null {
  const needle = oldStr.split("\n")[0]!.trim();
  if (needle.length < 8) return null; // too short to hint meaningfully
  const lines = before.split("\n");
  let best: { line: number; delta: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const cand = lines[i]!.trim();
    if (!cand) continue;
    const delta = levenshtein(cand, needle);
    if (best === null || delta < best.delta) best = { line: i + 1, delta };
  }
  if (!best) return null;
  // Only hint when it is plausibly the same line (edit distance below 40%).
  return best.delta <= Math.max(12, needle.length * 0.4) ? best : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

export interface SyntaxCheckResult {
  ok: boolean;
  detail: string;
}

/**
 * Post-edit syntax check (Scale Batch 3; Aider lint_edited / OpenCode LSP
 * diagnostics, zero-dep edition). node --check for JS-family files, JSON.parse
 * for .json, brace-balance heuristic (warning-grade) for other text files.
 * Returns null for non-checkable files.
 */
export async function syntaxCheck(path: string, content: string): Promise<SyntaxCheckResult | null> {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { ok: true, detail: "json parse ok" };
    } catch (err) {
      return { ok: false, detail: `json parse failed: ${(err as Error).message.slice(0, 120)}` };
    }
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const { writeFile, rm } = await import("node:fs/promises");
    const { spawnSync } = await import("node:child_process");
    const tmpFile = `${path}.telos-check-${Date.now().toString(36)}.js`;
    try {
      await writeFile(tmpFile, content, "utf8");
      const res = spawnSync("node", ["--check", tmpFile], { encoding: "utf8", timeout: 5_000 });
      if (res.status === 0) return { ok: true, detail: "node --check ok" };
      const msg = (res.stderr || res.stdout || "syntax error").split("\n").slice(0, 3).join(" ").slice(0, 160);
      return { ok: false, detail: msg };
    } catch (err) {
      return { ok: false, detail: `check failed: ${(err as Error).message.slice(0, 120)}` };
    } finally {
      await rm(tmpFile, { force: true }).catch(() => {});
    }
  }
  // .ts/.tsx cannot be node --check'd without a compiler; brace-balance is a
  // cheap suspect-detector (warning-grade, never blocks the edit).
  if (ext === ".ts" || ext === ".tsx" || ext === ".jsx") {
    return balanceCheck(content, ["(", ")", "{", "}", "[", "]"]);
  }
  if (ext === ".css" || ext === ".scss") return balanceCheck(content, ["{", "}"]);
  return null;
}

function balanceCheck(content: string, pairs: string[]): SyntaxCheckResult | null {
  // Strip line comments, block comments and string literals crudely — enough
  // for a balance heuristic without pulling in a parser.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '"')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "'")
    .replace(/`(?:\\.|[^`\\])*`/g, "`");
  const opens: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const closes: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  const stack: string[] = [];
  for (const ch of stripped) {
    if (opens[ch]) stack.push(ch);
    else if (closes[ch]) {
      if (pairs.includes(ch) && stack.pop() !== closes[ch]) {
        return { ok: false, detail: "unbalanced delimiters (possible truncated edit)" };
      }
    }
  }
  if (stack.length > 0) return { ok: false, detail: `${stack.length} unclosed "${stack[stack.length - 1]}" (possible truncated edit)` };
  return { ok: true, detail: "balanced" };
}

/** NUL-byte sniff on the first 8KB — cheap binary detection. */
async function looksBinary(path: string): Promise<boolean> {
  const { open } = await import("node:fs/promises");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
