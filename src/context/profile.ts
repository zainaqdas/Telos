import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Context Engine (Parts 40–42). Discover the repository incrementally and
 * compile a compact, factual profile for the Manager. No huge dumps: the
 * profile has a hard character budget, and file contents stay behind tools.
 */

const IGNORE = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "__pycache__", "target", ".venv", "vendor", ".project-agent"]);

const EXT_LANGUAGE: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".c": "c", ".h": "c", ".cpp": "c++", ".hpp": "c++", ".cs": "c#", ".php": "php", ".swift": "swift",
  ".css": "css", ".scss": "css", ".html": "html", ".sql": "sql", ".sh": "shell", ".lua": "lua",
};

const FRAMEWORK_HINTS: Record<string, string> = {
  react: "React", next: "Next.js", vue: "Vue", svelte: "Svelte", "@angular/core": "Angular",
  express: "Express", fastify: "Fastify", hono: "Hono", nestjs: "NestJS",
  vite: "Vite", webpack: "webpack", eslint: "ESLint", jest: "Jest", vitest: "Vitest",
  "node:test": "", typescript: "TypeScript", tailwindcss: "Tailwind CSS", prisma: "Prisma",
  "@playwright/test": "Playwright", mocha: "Mocha", "graphql-request": "GraphQL",
};

export interface RepoProfile {
  root: string;
  languages: Array<{ language: string; files: number }>;
  frameworks: string[];
  packageManager: string | null;
  scripts: { test?: string; build?: string; lint?: string; dev?: string };
  testCommand: string | null;
  git: { branch: string | null; dirtyFiles: number | null; isRepo: boolean };
  instructionFiles: Array<{ path: string; excerpt: string }>;
  keyDirs: string[];
  entryPoints: string[];
  /** Total tracked files (git ls-files when available); a scale signal for the model. */
  totalFiles: number | null;
  /** Compact directory tree with per-dir file counts, under its own budget. */
  treeText: string | null;
  profileText: string;
}

export async function profileRepository(root: string, budgetChars = 2400): Promise<RepoProfile> {
  const extensions = new Map<string, number>();
  const dirs: string[] = [];
  const files: string[] = [];
  let scanned = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || scanned > 4000) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      scanned++;
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isDirectory()) {
        if (IGNORE.has(e.name)) continue;
        if (depth <= 2) dirs.push(rel);
        await walk(full, depth + 1);
      } else {
        files.push(rel);
        const dot = e.name.lastIndexOf(".");
        if (dot > 0) {
          const ext = e.name.slice(dot).toLowerCase();
          extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
        }
      }
    }
  };
  await walk(root, 0);

  // ── Languages (merge extensions mapping to the same language) ──
  const langMap = new Map<string, number>();
  for (const [ext, count] of extensions) {
    const lang = EXT_LANGUAGE[ext];
    if (lang) langMap.set(lang, (langMap.get(lang) ?? 0) + count);
  }
  const languages = [...langMap.entries()]
    .map(([language, files]) => ({ language, files }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 4);

  // ── package.json: scripts, deps → package manager + frameworks ──
  let pkg: Record<string, unknown> | null = null;
  try {
    pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    /* not a node project or malformed */
  }
  const scripts: RepoProfile["scripts"] = {};
  const scriptNames: Record<string, string> = {};
  if (pkg && typeof pkg["scripts"] === "object" && pkg["scripts"] !== null) {
    const s = pkg["scripts"] as Record<string, string>;
    for (const key of ["test", "build", "lint", "dev"]) {
      const runner = await detectPackageManager(root, files);
      void runner;
      if (typeof s[key] === "string") {
        scripts[key as keyof typeof scripts] = s[key];
        scriptNames[key] = key;
      }
    }
  }

  const deps = new Set<string>();
  if (pkg) {
    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = pkg[key];
      if (typeof block === "object" && block !== null) {
        for (const name of Object.keys(block as Record<string, unknown>)) deps.add(name);
      }
    }
  }
  const frameworks: string[] = [];
  for (const [dep, label] of Object.entries(FRAMEWORK_HINTS)) {
    if (deps.has(dep) && label) frameworks.push(label);
  }

  const packageManager = await detectPackageManager(root, files);
  const pmName = packageManager?.split(" ")[0] ?? "npm"; // strip evidence suffix
  const runner = ["pnpm", "yarn", "bun"].includes(pmName) ? pmName : "npm";
  const testCommand = scriptNames["test"] ? `${runner} test` : null;

  // ── Non-node ecosystems ──
  if (files.includes("Cargo.toml")) {
    if (!languages.some((l) => l.language === "rust")) languages.push({ language: "rust", files: 0 });
    if (!testCommand) scripts["test"] = "cargo test";
  }
  if (files.includes("go.mod")) {
    if (!languages.some((l) => l.language === "go")) languages.push({ language: "go", files: 0 });
    if (!testCommand) scripts["test"] = "go test ./...";
  }
  if (files.includes("pyproject.toml") || files.includes("requirements.txt")) {
    if (!languages.some((l) => l.language === "python")) languages.push({ language: "python", files: 0 });
  }

  // ── Git state ──
  const git = readGitState(root);

  // ── Project instructions (Part 41) ──
  const instructionFiles: RepoProfile["instructionFiles"] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md", "PROJECT.md", "README.md"]) {
    const p = join(root, name);
    try {
      const st = await stat(p);
      if (!st.isFile()) continue;
      const raw = await readFile(p, "utf8");
      instructionFiles.push({ path: name, excerpt: raw.slice(0, 900) });
      if (instructionFiles.length >= 2) break; // top-priority instructions only
    } catch {
      /* absent */
    }
  }

  // ── Key directories / entry points ──
  const keyDirs = dirs.filter((d) => /^(src|lib|app|server|client|test|tests|spec|bin|cmd|internal|packages)/.test(d)).slice(0, 8);
  const entryPoints = files.filter((f) => /^(src\/)?(index|main|app|server|cli)\.(ts|tsx|js|mjs|py|go)$/.test(f)).slice(0, 4);

  // ── Scale: tracked-file count + compact tree (git ls-files when available) ──
  const tracked = listTrackedFiles(root);
  const totalFiles = tracked ? tracked.length : null;
  const treeText = renderTree(tracked ?? files, budgetChars);

  // ── Compile profile text under budget ──
  const lines: string[] = [];
  if (languages.length) lines.push(`languages: ${languages.map((l) => `${l.language}(${l.files})`).join(", ")}`);
  if (frameworks.length) lines.push(`frameworks: ${frameworks.join(", ")}`);
  if (packageManager) lines.push(`package manager: ${packageManager}`);
  const cmds: string[] = [];
  if (testCommand || scripts["test"]) cmds.push(`test: ${testCommand ?? `${runner} run test`}`);
  if (scripts["build"]) cmds.push(`build: ${runner} run build`);
  if (scripts["lint"]) cmds.push(`lint: ${runner} run lint`);
  if (cmds.length) lines.push(`commands: ${cmds.join("; ")}`);
  if (git.isRepo) {
    const dirty = git.dirtyFiles === null ? "" : `, ${git.dirtyFiles} uncommitted files`;
    lines.push(`git: branch ${git.branch ?? "?"}${dirty}`);
  } else {
    lines.push("git: not a repository");
  }
  if (keyDirs.length) lines.push(`key dirs: ${keyDirs.join(", ")}`);
  if (entryPoints.length) lines.push(`entry points: ${entryPoints.join(", ")}`);
  if (totalFiles !== null) lines.push(totalFiles > 500 ? `scale: ${totalFiles} tracked files — use search_text/find_files to locate code; read slices of large files` : `scale: ${totalFiles} files`);
  if (instructionFiles.length) lines.push(`project instructions: ${instructionFiles.map((f) => f.path).join(", ")} (follow them)`);

  let profileText = lines.join("\n");
  if (profileText.length > budgetChars) profileText = `${profileText.slice(0, budgetChars)}\n… [profile truncated]`;

  return { root, languages, frameworks, packageManager, scripts, testCommand, git, instructionFiles, keyDirs, entryPoints, totalFiles, treeText, profileText };
}

// ─── helpers ──────────────────────────────────────────────────────────────────────────

/** Tracked files via `git ls-files` (respects .gitignore); null when not a repo or git missing. */
function listTrackedFiles(root: string): string[] | null {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") return null;
  const res = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return null;
  return res.stdout.split("\n").filter((l) => l.trim().length > 0);
}

/**
 * Render a compact directory tree with per-directory file counts, under a
 * character budget. Two levels: top dirs with totals, then their immediate
 * subdirs. A wide shallow map orients better than a deep narrow one.
 */
function renderTree(files: string[], budgetChars: number, maxDepth = 3): string | null {
  if (files.length === 0) return null;
  const dirFiles = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const f of files) {
    const parts = f.split("/");
    if (parts.length === 1) {
      rootFiles.push(f);
      continue;
    }
    // Attribute the file to its top-level directory (and one subdir level).
    const top = parts[0]!;
    dirFiles.set(top, (dirFiles.get(top) ?? 0) + 1);
    if (parts.length > 2) {
      const sub = `${top}/${parts[1]}`;
      dirFiles.set(sub, (dirFiles.get(sub) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  const tops = [...dirFiles.keys()].filter((k) => !k.includes("/")).sort();
  for (const top of tops) {
    const subEntries = [...dirFiles.entries()]
      .filter(([k]) => k.startsWith(top + "/"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const total = dirFiles.get(top) ?? 0;
    lines.push(`${top}/  (${total} files${subEntries.length ? `, biggest: ${subEntries.map(([k, n]) => `${k.slice(top.length + 1)} ${n}`).join(", ")}` : ""})`);
  }
  const fileLine = rootFiles.length ? `(root: ${rootFiles.slice(0, 10).join(", ")}${rootFiles.length > 10 ? `, +${rootFiles.length - 10} more` : ""})` : "";
  let text = [fileLine, ...lines].filter(Boolean).join("\n");
  if (text.length > budgetChars) {
    text = text.slice(0, budgetChars).replace(/\n[^\n]*$/, "") + `\n… [tree truncated — ${files.length} files total]`;
  }
  void maxDepth;
  return text;
}

async function detectPackageManager(root: string, files: string[]): Promise<string | null> {
  const has = (f: string): boolean => files.includes(f);
  try {
    if (has("pnpm-lock.yaml")) return "pnpm (pnpm-lock.yaml)";
    if (has("yarn.lock")) return "yarn (yarn.lock)";
    if (has("bun.lockb") || has("bun.lock")) return "bun (bun.lock)";
    if (has("package-lock.json")) return "npm (package-lock.json)";
    if (has("package.json")) return "npm (package.json, no lockfile)";
    if (has("poetry.lock")) return "poetry";
    if (has("uv.lock")) return "uv";
    if (has("Cargo.lock")) return "cargo";
    if (has("go.mod")) return "go modules";
  } catch {
    /* fallthrough */
  }
  void root;
  return null;
}

function readGitState(root: string): RepoProfile["git"] {
  // `rev-parse --is-inside-work-tree` succeeds even before the first commit.
  const repoRes = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  const isRepo = repoRes.status === 0 && repoRes.stdout.trim() === "true";
  const branchRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" });
  const statusRes = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  return {
    isRepo,
    branch: isRepo && branchRes.status === 0 ? branchRes.stdout.trim() || null : null,
    dirtyFiles: isRepo && statusRes.status === 0 ? statusRes.stdout.split("\n").filter((l) => l.trim()).length : null,
  };
}
