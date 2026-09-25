import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, join } from "node:path";
import type { ToolRegistry } from "../tools/registry.ts";

/**
 * Repetition Guard (Parts 25–26). Before executing a tool call the runtime
 * normalizes it, compares against recent attempts, failure history, and a
 * fingerprint of relevant execution state, then classifies:
 *
 *   NEW | SAFE_RETRY | CHANGED_RETRY | REPEATED_FAILURE | KNOWN_BAD_PATTERN
 *
 * REPEATED_FAILURE / KNOWN_BAD_PATTERN calls are refused by the runtime —
 * the model does not get to argue with the guard.
 */

export type GuardVerdict = "NEW" | "SAFE_RETRY" | "CHANGED_RETRY" | "REPEATED_FAILURE" | "KNOWN_BAD_PATTERN";

export interface AttemptRecord {
  key: string;
  fingerprint: string;
  ok: boolean;
  errorCategory?: string;
  t: number;
}

export interface GuardDecision {
  verdict: GuardVerdict;
  reason: string;
  priorFailures: number;
}

export interface GuardConfig {
  /** Identical failed attempts (same key + fingerprint) allowed before blocking. */
  maxIdenticalFailures: number;
  /** Consecutive failed tool calls that trip the failure-storm breaker. */
  maxConsecutiveFailures: number;
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  maxIdenticalFailures: 2,
  maxConsecutiveFailures: 4,
};

export class RepetitionGuard {
  private readonly attempts: AttemptRecord[] = [];
  /** Per-tool consecutive-failure counters: one tool's storm must not lock out unrelated tools. */
  private readonly consecutiveFailuresByTool = new Map<string, number>();
  private readonly config: GuardConfig;

  constructor(config: GuardConfig = DEFAULT_GUARD_CONFIG) {
    this.config = config;
  }

  /** Classify an incoming call BEFORE executing it. */
  evaluate(key: string, fingerprint: string, now = Date.now(), toolName = ""): GuardDecision {
    // Prune old attempts (10-minute horizon).
    const horizon = now - 600_000;
    while (this.attempts.length > 0 && this.attempts[0]!.t < horizon) this.attempts.shift();

    const identical = this.attempts.filter((a) => a.key === key && a.fingerprint === fingerprint);
    const sameKey = this.attempts.filter((a) => a.key === key);
    const priorFailures = identical.filter((a) => !a.ok).length;

    if (priorFailures >= this.config.maxIdenticalFailures) {
      return {
        verdict: "REPEATED_FAILURE",
        reason: `identical call already failed ${priorFailures} times with unchanged state fingerprint`,
        priorFailures,
      };
    }
    if (sameKey.filter((a) => !a.ok).length >= this.config.maxIdenticalFailures + 2) {
      return {
        verdict: "KNOWN_BAD_PATTERN",
        reason: `command repeatedly fails across ${sameKey.length} attempts with varied arguments`,
        priorFailures: sameKey.filter((a) => !a.ok).length,
      };
    }
    const consecutive = this.consecutiveFailuresByTool.get(toolName) ?? 0;
    if (consecutive >= this.config.maxConsecutiveFailures) {
      return {
        verdict: "KNOWN_BAD_PATTERN",
        reason: `${consecutive} consecutive ${toolName} failures — failure storm for this tool; other tools remain available. Stop retrying and report, or change approach materially.`,
        priorFailures: consecutive,
      };
    }
    if (identical.length > 0) {
      return identical.some((a) => a.ok)
        ? { verdict: "SAFE_RETRY", reason: "identical call succeeded recently", priorFailures }
        : { verdict: "CHANGED_RETRY", reason: "prior attempt failed but environment changed", priorFailures };
    }
    return { verdict: "NEW", reason: "no comparable prior attempt", priorFailures: 0 };
  }

  /** Record the outcome after execution. */
  record(key: string, fingerprint: string, ok: boolean, errorCategory?: string, now = Date.now(), toolName = ""): void {
    this.attempts.push({ key, fingerprint, ok, errorCategory, t: now });
    const current = this.consecutiveFailuresByTool.get(toolName) ?? 0;
    this.consecutiveFailuresByTool.set(toolName, ok ? 0 : current + 1);
  }

  /**
   * Record a caller-mistake failure (bad arguments, unknown tool): it counts
   * for identical-failure detection but must NOT feed the failure-storm
   * breaker, which is reserved for environment/execution instability.
   */
  recordNonStorm(key: string, fingerprint: string, errorCategory: string, now = Date.now()): void {
    this.attempts.push({ key, fingerprint, ok: false, errorCategory, t: now });
  }
}

/**
 * State fingerprint (Part 27): answers "did anything relevant actually
 * change?" — not cryptographic identity. Hashes the call itself plus the
 * target files' contents, command cwd, and workspace snapshot marker files.
 */
export async function fingerprintCall(toolName: string, args: Record<string, unknown>, root: string): Promise<string> {
  const h = createHash("sha256");
  h.update(toolName);
  h.update("\u0000");
  h.update(stableStringify(args));
  h.update("\u0000");
  h.update(root);

  // File targets: hash current contents so edits change the fingerprint.
  const targets = [args["path"], args["cwd"], args["subdir"]].filter((v): v is string => typeof v === "string");
  for (const target of targets) {
    try {
      const p = join(root, target);
      const st = await stat(p);
      if (st.isFile()) {
        const content = await readFile(p);
        h.update(`file:${target}:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`);
      } else {
        h.update(`dir:${target}:${st.mtimeMs}`);
      }
    } catch {
      h.update(`missing:${target}`);
    }
  }
  return h.digest("hex").slice(0, 24);
}

/** Tools whose repetition is protected: everything except trivial reads. */
export function guardKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Shell error classification (Part 28): map raw stderr to a category so
 * failure learning can reason about causes instead of raw text.
 */
export function classifyShellFailure(output: string, exitCode: number | null): string {
  const text = output.toLowerCase();
  if (text.includes("eaddrinuse")) return "port_in_use";
  if (text.includes("command not found") || exitCode === 127) return "command_not_found";
  if (text.includes("permission denied")) return "permission_denied";
  if (text.includes("enoent") || text.includes("no such file")) return "path_missing";
  if (text.includes("econnrefused") || text.includes("etimedout") || text.includes("enotfound")) return "network";
  if (text.includes("cannot find module")) return "module_missing";
  if (text.includes("failed") && text.includes("test")) return "test_failure";
  if (text.includes("error ts") || text.includes("type error") || text.includes("syntaxerror")) return "compile_error";
  return exitCode === null ? "signalled" : "command_failed";
}
