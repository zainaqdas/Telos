import { isAbsolute, join, relative, resolve, sep, dirname } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { ToolExecContext } from "./registry.ts";

/**
 * Resolve a user/tool-supplied path inside the workspace; never escape root.
 *
 * Containment model (P0): the request is first lexicalized (`resolve`), then
 * verified in REAL path space via the nearest EXISTING ancestor. Checking only
 * the target is not enough — a nonexistent leaf (`linked/new.txt` where
 * `linked -> /outside`) throws ENOENT on realpath and would slip through an
 * implementation that tolerates ENOENT. Instead we walk upward to the first
 * existing ancestor, realpath it, and require it to stay inside the realpath'd
 * workspace root. Every workspace-mutating tool (write/append/edit, shell cwd)
 * resolves through this function; the only deliberate exception is run_shell
 * commands themselves, which are the user's own machine and gated by the
 * destructive-command refusal list.
 */
export function safePath(ctx: ToolExecContext, ...parts: string[]): string {
  const target = resolve(ctx.root, ...parts.filter((p) => p !== "" && p !== "."));
  const rel = relative(ctx.root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${parts.join("/")}`);
  }
  // Walk up to the nearest existing ancestor (target itself may not exist).
  let anchor = target;
  let walked = 0;
  while (!existsSync(anchor) && dirname(anchor) !== anchor) {
    anchor = dirname(anchor);
    walked += 1;
  }
  // A symlink pointing outside the workspace is still an escape — for the
  // target itself when it exists, and for any ancestor when it does not.
  const realAnchor = realpathSync(anchor);
  const realRoot = realpathSync(ctx.root);
  if (!realAnchor.startsWith(realRoot + sep) && realAnchor !== realRoot) {
    throw new Error(`path escapes workspace via symlink: ${parts.join("/")}`);
  }
  void walked;
  return target;
}

const SECRET_HOLDER: { value: string | null } = { value: null };

/** Install the redaction secret (the BYOK key). Called once per session. */
export function installSecret(value: string): void {
  SECRET_HOLDER.value = value && value.length >= 8 ? value : null;
}

export function makeRedact(): (text: string) => string {
  return (text: string) => {
    const secret = SECRET_HOLDER.value;
    let out = text;
    if (secret) out = out.split(secret).join("[REDACTED]");
    // Generic credential-looking patterns (best-effort, never log keys).
    out = out.replace(/(?:sk|pk|api[_-]?key|token|bearer)[=_\s-]?[A-Za-z0-9_-]{16,}/gi, "[REDACTED]");
    return out;
  };
}

/**
 * UTF-8-safe truncation (P2): cut at a code-point boundary so the result is
 * always valid text. Slicing by UTF-16 code units could split a surrogate
 * pair (emoji) and corrupt output; we walk back at most 3 bytes to the last
 * code-point start, so the result never exceeds the byte budget by more
 * than the suffix note itself.
 */
export function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  const note = `\n… [output truncated at ${maxBytes} bytes of ${bytes}]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(note, "utf8"));
  // Fast path: exact byte slice is already a clean code-point boundary.
  const raw = Buffer.from(text, "utf8").subarray(0, budget);
  let cut = raw;
  // A continuation byte (0b10xxxxxx) means we sliced mid-code-point; back up
  // to the start of the last complete code point (up to 3 continuation bytes
  // for a 4-byte sequence).
  let end = raw.length;
  while (end > 0 && (raw[end - 1]! & 0xc0) === 0x80) end -= 1;
  if (end > 0 && (raw[end - 1]! & 0x80) !== 0) end -= 1; // drop the lead byte of the partial sequence
  if (end < raw.length) cut = raw.subarray(0, end);
  return { text: `${cut.toString("utf8")}${note}`, truncated: true };
}

/**
 * Multiset line-change summary for edit results (Part 45, renamed P2): this
 * is a COUNT of lines added/removed plus a small preview — NOT a structural
 * diff (no positional/contiguity analysis). Git remains the authoritative
 * diff source; /diff and the journal own precise change inspection.
 */
export function summarizeLineChanges(before: string, after: string): { added: number; removed: number; preview: string } {
  const a = before.split("\n");
  const b = after.split("\n");
  const setA = new Map<string, number>();
  for (const l of a) setA.set(l, (setA.get(l) ?? 0) + 1);
  let added = 0;
  const addedLines: string[] = [];
  for (const l of b) {
    const n = setA.get(l) ?? 0;
    if (n > 0) setA.set(l, n - 1);
    else {
      added += 1;
      if (addedLines.length < 6) addedLines.push(`+ ${l}`);
    }
  }
  let removed = 0;
  const removedLines: string[] = [];
  for (const [l, n] of setA) {
    removed += n;
    if (removedLines.length < 6) removedLines.unshift(`- ${l}`);
  }
  return { added, removed, preview: [...removedLines, ...addedLines].join("\n") };
}

/** Root context factory shared by all built-in tools. */
export function makeContext(
  root: string,
  opts: { shellTimeoutSeconds: number; maxOutputBytes?: number; signal?: AbortSignal; cancellation?: import("../runtime/cancellation.ts").CancellationController },
): ToolExecContext {
  return {
    root,
    redact: makeRedact(),
    maxOutputBytes: opts.maxOutputBytes ?? 48_000,
    shellTimeoutSeconds: opts.shellTimeoutSeconds,
    signal: opts.signal,
    cancellation: opts.cancellation,
  };
}

/** Legacy name kept as an alias so older call sites/tests keep working. */
export const lineDiff = summarizeLineChanges;

export { join };
