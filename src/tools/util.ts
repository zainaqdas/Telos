import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { ToolExecContext } from "./registry.ts";

/** Resolve a user/tool-supplied path inside the workspace; never escape root. */
export function safePath(ctx: ToolExecContext, ...parts: string[]): string {
  const target = resolve(ctx.root, ...parts.filter((p) => p !== "" && p !== "."));
  const rel = relative(ctx.root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${parts.join("/")}`);
  }
  try {
    // A symlink pointing outside the workspace is still an escape.
    const real = realpathSync(target);
    const realRoot = realpathSync(ctx.root);
    if (!real.startsWith(realRoot + sep) && real !== realRoot) {
      throw new Error(`path escapes workspace via symlink: ${parts.join("/")}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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

export function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  const cut = text.slice(0, maxBytes);
  return { text: `${cut}\n… [output truncated at ${maxBytes} bytes of ${bytes}]`, truncated: true };
}

/** Small line diff for edit results: what changed, where (Part 45). */
export function lineDiff(before: string, after: string): { added: number; removed: number; preview: string } {
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

export { join };
