import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ToolRegistry, ToolDefinition, ToolExecContext } from "../tools/registry.ts";

/**
 * Edit journal (Part 61: /undo). Every successful workspace write is
 * undoable: the pre-edit content is captured BEFORE the tool runs and kept
 * in a bounded stack. /undo pops the newest entry and restores it. This is
 * session-level safety, not version control — /diff and Git remain the real
 * history; the journal exists so a bad automated edit is one command away
 * from gone.
 */

export interface JournalEntry {
  /** Workspace-relative path as given to the tool. */
  path: string;
  /** Absolute path at edit time. */
  absolutePath: string;
  /** File content before the write ("" for created files). */
  before: string;
  t: number;
}

const MAX_ENTRIES = 50;

export class EditJournal {
  private readonly entries: JournalEntry[] = [];

  push(entry: JournalEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  pop(): JournalEntry | undefined {
    return this.entries.pop();
  }

  get depth(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Wrap write_file/edit_file so every successful mutation journals the
 * pre-edit content. The decoration is transparent to the registry: schema,
 * permission, risk, guard behavior, and result shape are untouched.
 */
export function journalWriteTools(
  registry: ToolRegistry,
  journal: EditJournal,
  /** Called before the session's first successful write (Scale Batch 3): the git snapshot hook. */
  onFirstWrite?: () => void | Promise<void>,
): void {
  let snapshotTaken = false;
  for (const name of ["write_file", "edit_file"]) {
    const tool = registry.get(name);
    if (!tool) continue;
    const wrapped: ToolDefinition = {
      ...tool,
      async execute(args: Record<string, unknown>, ctx: ToolExecContext) {
        let before = "";
        const pathArg = typeof args["path"] === "string" ? args["path"] : "";
        if (pathArg) {
          try {
            before = await readFile(join(ctx.root, pathArg), "utf8");
          } catch {
            before = ""; // created file (or unreadable — restoring "" is still safe)
          }
        }
        if (!snapshotTaken) {
          snapshotTaken = true;
          try {
            await onFirstWrite?.();
          } catch {
            /* snapshot is best-effort; never blocks the edit */
          }
        }
        const result = await tool.execute(args, ctx);
        if (result.ok && pathArg) {
          journal.push({ path: pathArg, absolutePath: join(ctx.root, pathArg), before, t: Date.now() });
        }
        return result;
      },
    };
    registry.remove(name);
    registry.register(wrapped);
  }
}

/** Restore the newest journaled edit. Returns what was undone, if anything. */
export async function undoLastEdit(journal: EditJournal, root: string): Promise<string | undefined> {
  const entry = journal.pop();
  if (!entry) return undefined;
  const { writeFile, mkdir, rm } = await import("node:fs/promises");
  if (entry.before === "") {
    // The edit created the file — undo removes it again.
    await rm(entry.absolutePath, { force: true });
    return `removed ${relative(root, entry.absolutePath)} (was created by the undone edit)`;
  }
  await mkdir(join(entry.absolutePath, ".."), { recursive: true });
  await writeFile(entry.absolutePath, entry.before, "utf8");
  return `restored ${relative(root, entry.absolutePath)} to its pre-edit content`;
}
