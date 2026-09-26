/**
 * Search engine for large repositories (Scale Batch 1).
 *
 * Strategy: spawn `rg` (ripgrep) when it is on PATH — it respects .gitignore,
 * streams results incrementally, and handles huge trees in milliseconds. When
 * rg is absent, fall back to the pure-Node walker (zero deps preserved: we
 * never bundle or download binaries). Both paths return the same result shape
 * so tool output is identical for the model.
 *
 * Every entry point is time-capped: a search on a pathological tree must
 * return *something useful* within the deadline rather than hang the turn.
 */

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** How the search ran ("ripgrep" | "node-fallback"), for events/telemetry. */
  engine: "ripgrep" | "node-fallback";
  truncated: boolean;
  filesScanned: number;
}

const DEFAULT_TIME_BUDGET_MS = 8_000;

/** Locate rg once per process; absent PATH means the Node fallback is used. */
let rgPath: string | null | undefined;
async function resolveRg(): Promise<string | null> {
  if (rgPath !== undefined) return rgPath;
  rgPath = await new Promise<string | null>((resolve) => {
    const child = spawn("rg", ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? "rg" : null));
  });
  return rgPath;
}

/**
 * ripgrep path. `rg --json` gives structured match events; we ask it to
 * respect the default ignore rules (.gitignore) — that is the entire point of
 * using it on large repos.
 */
async function ripgrepSearch(
  root: string,
  regex: string,
  opts: { maxResults: number; timeBudgetMs: number; glob?: string },
): Promise<SearchResult | null> {
  const rg = await resolveRg();
  if (!rg) return null;
  const args = [
    "--json",
    "--max-count", "3", // up to 3 hits per file keeps one file from saturating
    "--no-messages",
    ...(opts.glob ? ["--glob", opts.glob] : []),
    regex,
    root,
  ];
  return new Promise<SearchResult | null>((resolve) => {
    const child = spawn(rg, args, { stdio: ["ignore", "pipe", "ignore"] });
    const hits: SearchHit[] = [];
    let truncated = false;
    let finished = false;
    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGKILL");
    }, opts.timeBudgetMs);
    let buffer = "";
    child.stdout!.on("data", (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (finished || hits.length >= opts.maxResults) continue;
        try {
          const evt = JSON.parse(line) as {
            type: string;
            data?: {
              path?: { text?: string };
              number?: number;
              lines?: { text?: string };
            };
          };
          if (evt.type === "match" && evt.data?.path?.text && evt.data.lines?.text && typeof evt.data.number === "number") {
            const file = relative(root, evt.data.path.text) || evt.data.path.text;
            hits.push({ file, line: evt.data.number, text: evt.data.lines.text.replace(/\r?\n$/, "").slice(0, 240) });
            if (hits.length >= opts.maxResults) {
              truncated = true;
              child.kill("SIGKILL");
            }
          }
        } catch {
          /* non-JSON line — ignore */
        }
      }
    });
    const done = (fallback: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ hits, engine: "ripgrep", truncated, filesScanned: -1 });
      void fallback;
    };
    child.on("exit", () => done(false));
    child.on("error", () => {
      finished = true;
      clearTimeout(timer);
      resolve(null); // signal caller to use the fallback
    });
  });
}

// ─── Node fallback walker (shared by search and find) ─────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".project-agent", "dist", "build", "coverage",
  ".next", "__pycache__", "target", ".venv", "vendor", ".turbo", ".cache",
  "out", ".output", "tmp", ".idea", ".vscode-test",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".css",
  ".scss", ".html", ".yml", ".yaml", ".toml", ".sh", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".sql", ".env", ".xml", ".vue", ".svelte",
]);

/** Walk with .gitignore support (top-level patterns only — the common 90%). */
async function collectFiles(root: string, opts: { timeBudgetMs: number }): Promise<{ files: string[]; gitignore: (relDir: string, name: string) => boolean; truncated: boolean }> {
  const ignorePatterns = await readGitignore(root);
  const files: string[] = [];
  let truncated = false;
  const deadline = Date.now() + opts.timeBudgetMs;
  const matchesIgnore = (relPath: string, name: string): boolean => {
    for (const p of ignorePatterns) {
      if (p === name || relPath === p || relPath.startsWith(p + "/")) return true;
    }
    return false;
  };
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (truncated || files.length > 60_000 || Date.now() > deadline || depth > 16) {
      if (Date.now() > deadline || files.length > 60_000) truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || matchesIgnore(childRel, e.name)) continue;
        await walk(join(dir, e.name), childRel, depth + 1);
      } else {
        files.push(childRel);
      }
    }
  };
  await walk(root, "", 0);
  return { files, gitignore: matchesIgnore, truncated };
}

async function readGitignore(root: string): Promise<string[]> {
  try {
    const raw = await readFile(join(root, ".gitignore"), "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"))
      .map((l) => l.replace(/^\//, "").replace(/\/$/, ""));
  } catch {
    return [];
  }
}

async function nodeSearch(
  root: string,
  regex: RegExp,
  opts: { maxResults: number; timeBudgetMs: number },
): Promise<SearchResult> {
  const { files, truncated: walkTruncated } = await collectFiles(root, { timeBudgetMs: opts.timeBudgetMs });
  const hits: SearchHit[] = [];
  let truncated = walkTruncated;
  const deadline = Date.now() + opts.timeBudgetMs;
  let filesScanned = 0;
  // Small worker pool: sequential stat+read over 10k+ files is 3-4s; 8-way
  // concurrency on the same event loop lands well under 2s without spawning.
  const CONCURRENCY = 8;
  let cursor = 0;
  const truncatedHit = () => hits.length >= opts.maxResults;
  const scanOne = async (rel: string): Promise<void> => {
    if (truncatedHit() || Date.now() > deadline) {
      truncated = true;
      return;
    }
    const ext = rel.slice(rel.lastIndexOf("."));
    if (!TEXT_EXTENSIONS.has(ext) && !rel.startsWith(".")) return;
    let content: string;
    try {
      const st = await stat(join(root, rel));
      if (st.size > 800_000) return;
      content = await readFile(join(root, rel), "utf8");
    } catch {
      return;
    }
    filesScanned++;
    const lines = content.split("\n");
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 3 && hits.length < opts.maxResults; i++) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 240) });
        perFile++;
      }
    }
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (!truncatedHit() && Date.now() <= deadline) {
        const i = cursor++;
        if (i >= files.length) return;
        await scanOne(files[i]!);
      }
      if (Date.now() > deadline) truncated = true;
    }),
  );
  return { hits, engine: "node-fallback", truncated, filesScanned };
}

/**
 * Search file contents. `pattern` is a literal string or regex source;
 * compilation is the caller's job (it owns the error message).
 */
export async function searchText(
  root: string,
  regexSource: string,
  opts: { maxResults?: number; timeBudgetMs?: number; caseInsensitive?: boolean; glob?: string } = {},
): Promise<SearchResult & { regexError?: string }> {
  const maxResults = opts.maxResults ?? 200;
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  let regex: RegExp;
  try {
    regex = new RegExp(regexSource, opts.caseInsensitive === false ? "" : "i");
  } catch (err) {
    return { hits: [], engine: "node-fallback", truncated: false, filesScanned: 0, regexError: (err as Error).message };
  }
  // rg wants its own syntax; for a literal we escape nothing (rg treats the
  // pattern as regex too), so pass the source through — Node and rg regexes
  // agree on the common subset we care about.
  const viaRg = await ripgrepSearch(root, regexSource, { maxResults, timeBudgetMs, glob: opts.glob });
  if (viaRg) return viaRg;
  const res = await nodeSearch(root, regex, { maxResults, timeBudgetMs });
  return res;
}

/** Find files by glob-style name pattern (e.g. *.test.ts). */
export async function findFiles(
  root: string,
  glob: string,
  opts: { maxResults?: number; timeBudgetMs?: number } = {},
): Promise<SearchResult> {
  const maxResults = opts.maxResults ?? 200;
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const viaRg = await ripgrepSearch(root, "^$", { maxResults: 0, timeBudgetMs: 1, glob: undefined }); // probe only
  void viaRg;
  const { files, truncated } = await collectFiles(root, { timeBudgetMs });
  const re = globToRegExp(glob);
  const hits = files.filter((f) => re.test(f.split(sep).pop() ?? f)).slice(0, maxResults);
  return {
    hits: hits.map((f) => ({ file: f, line: 0, text: "" })),
    engine: (await resolveRg()) ? "ripgrep" : "node-fallback",
    truncated: truncated || files.length > maxResults,
    filesScanned: files.length,
  };
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}
