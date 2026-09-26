/**
 * Git-backed /undo (Scale Batch 3; docs/SCALE_ROADMAP.md item 10).
 *
 * Snapshot the workspace's tracked files onto a private ref
 * (refs/telos/snapshot) using a temporary index — NO commits, NO branch
 * changes, invisible to `git log` and to the user's history. Taken before
 * the session's first write; /undo restores via read-tree + checkout-index.
 *
 * Files created after the snapshot are removed on undo (they are not in the
 * snapshot tree). The user's pre-existing untracked files are never touched:
 * checkout-index only rewrites paths present in the snapshot tree.
 *
 * The snapshot composes with the edit journal (Part 61): git undo is tried
 * first and restores the whole workspace in one step; the journal remains the
 * fallback for non-git directories.
 */

import { spawnSync } from "node:child_process";
import { join, normalize } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const GIT_SNAPSHOT_REF = "refs/telos/snapshot";

function git(root: string, args: string[], extraEnv?: Record<string, string>): { ok: boolean; out: string } {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...extraEnv } });
  return { ok: res.status === 0, out: (res.stdout || res.stderr || "").trim() };
}

/**
 * Snapshot tracked files onto the private ref. Returns the tree sha, or null
 * when not a git repo / git failed (best-effort by design).
 */
export async function gitSnapshot(root: string): Promise<string | null> {
  if (!git(root, ["rev-parse", "--is-inside-work-tree"]).ok) return null;
  const tmpIndex = join(root, ".project-agent", "git-index-snapshot");
  const env = { GIT_INDEX_FILE: tmpIndex };
  // The snapshot hook fires before the journal creates .project-agent/, and
  // git refuses `add` when GIT_INDEX_FILE's directory is missing — create it.
  try {
    mkdirSync(join(root, ".project-agent"), { recursive: true });
  } catch {
    /* best-effort */
  }
  if (!git(root, ["add", "-A"], env).ok) return null;
  const tree = git(root, ["write-tree"], env);
  if (!tree.ok) return null;
  if (!git(root, ["update-ref", GIT_SNAPSHOT_REF, tree.out]).ok) return null;
  rmSync(tmpIndex, { force: true });
  return tree.out;
}

export interface GitUndoResult {
  restored: boolean;
  snapshot: string;
  filesChanged: number;
}

/** Restore the workspace to the snapshot. No-op (restored:false) without one. */
export async function gitUndoToSnapshot(root: string): Promise<GitUndoResult> {
  const snap = git(root, ["rev-parse", "--verify", GIT_SNAPSHOT_REF]);
  if (!snap.ok) return { restored: false, snapshot: "", filesChanged: 0 };
  const snapshot = snap.out;

  const numstat = git(root, ["diff", "--numstat", GIT_SNAPSHOT_REF]);
  const filesChanged = numstat.ok ? numstat.out.split("\n").filter((l) => l.trim()).length : 0;

  // Files created after the snapshot are invisible to `git diff <ref>`: they
  // are untracked, and stay untracked once the index is reset. Stage the
  // worktree into a throwaway index FIRST and diff that against the snapshot —
  // paths present now but absent from the snapshot show up as `A`.
  try {
    mkdirSync(join(root, ".project-agent"), { recursive: true });
  } catch {
    /* best-effort */
  }
  const undoIndex = join(root, ".project-agent", "git-index-undo");
  const undoEnv = { GIT_INDEX_FILE: undoIndex };
  let created: string[] = [];
  if (git(root, ["add", "-A"], undoEnv).ok) {
    const createdDiff = git(root, ["diff", "--name-only", "--diff-filter=A", GIT_SNAPSHOT_REF], undoEnv);
    if (createdDiff.ok) {
      created = createdDiff.out.split("\n").map((l) => l.trim()).filter(Boolean);
    }
  }
  rmSync(undoIndex, { force: true });

  if (!git(root, ["read-tree", GIT_SNAPSHOT_REF]).ok) return { restored: false, snapshot, filesChanged };
  if (!git(root, ["checkout-index", "-a", "-f"]).ok) return { restored: false, snapshot, filesChanged };

  // Remove files created after the snapshot (present now, absent in it).
  for (const name of created) {
    const full = normalize(join(root, name));
    if (!full.startsWith(normalize(root))) continue; // never delete outside the repo
    try {
      rmSync(full, { force: true });
    } catch {
      /* already gone */
    }
  }
  return { restored: true, snapshot, filesChanged };
}
