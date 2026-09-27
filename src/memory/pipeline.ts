import type { MemoryStore, MemoryRecord } from "./store.ts";

/**
 * Failure learning pipeline (Parts 27–28, 89):
 *
 *   tool failure → classify → root cause → record failure
 *     → recurring? → promote to verified lesson → memory
 *
 * Classification is deterministic (no model in the loop). A lesson is only
 * written when a failure has recurred — single occurrences stay as failures,
 * not lessons. Lessons are born verified because they are distilled from
 * observed evidence, not from model claims.
 */

export interface FailureInput {
  tool: string;
  category: string;
  /** Raw output (already redacted/truncated by the tool layer). */
  observation: string;
  /** The command or target, for the natural key. */
  target: string;
}

export interface LearnedLesson {
  key: string;
  statement: string;
  cause: string;
  correction: string;
  verification: string;
}

/** Root-cause map: deterministic category → cause + correction guidance. */
const CAUSE_MAP: Record<string, { cause: string; correction: string }> = {
  port_in_use: {
    cause: "The port was already occupied, most likely by a previous instance of the same server that is still running.",
    correction: "Find and reuse or terminate the existing process bound to the port before starting the server again.",
  },
  command_not_found: {
    cause: "The executable is not installed or not on PATH in this environment.",
    correction: "Verify the tool name, install the missing dependency, or use the package manager specified by the repository.",
  },
  permission_denied: {
    cause: "The process lacks permission for the target file/port/resource.",
    correction: "Check ownership and permissions; avoid elevated workarounds unless the user asks.",
  },
  path_missing: {
    cause: "A referenced file or directory does not exist at the expected path.",
    correction: "Verify the path with list_directory/find_files before retrying; correct relative vs absolute path usage.",
  },
  module_missing: {
    cause: "A required package is not installed in the workspace.",
    correction: "Install dependencies using the repository's detected package manager before running the command.",
  },
  test_failure: {
    cause: "The code under test does not satisfy the asserted behavior (or the test pins a contract the code was changed to break).",
    correction: "Read the assertion diff, fix the code to match the pinned contract, then re-run the suite.",
  },
  compile_error: {
    cause: "The source contains type or syntax errors that prevent the build.",
    correction: "Fix the reported type/syntax errors at their reported locations, then rebuild.",
  },
  network: {
    cause: "A network request failed (refused connection, timeout, or DNS).",
    correction: "Check connectivity and the target host/port; do not hammer retries — wait or use a local fallback.",
  },
};

export function classifyRootCause(category: string, observation: string): { cause: string; correction: string } {
  const mapped = CAUSE_MAP[category];
  if (mapped) return mapped;
  const lowered = observation.toLowerCase();
  if (lowered.includes("eaddrinuse")) return CAUSE_MAP["port_in_use"]!;
  if (lowered.includes("cannot find module")) return CAUSE_MAP["module_missing"]!;
  if (lowered.includes("permission denied")) return CAUSE_MAP["permission_denied"]!;
  if (lowered.includes("no such file") || lowered.includes("enoent")) return CAUSE_MAP["path_missing"]!;
  return {
    cause: "The command failed for a reason not yet classified.",
    correction: "Read the full error output and compare the failing step against the repository's documented workflow.",
  };
}

export class FailureLearner {
  readonly store: MemoryStore;
  private readonly promotionThreshold: number;

  constructor(store: MemoryStore, promotionThreshold = 2) {
    this.store = store;
    this.promotionThreshold = promotionThreshold;
  }

  /** Record a failure. Returns a lesson when one was promoted this time. */
  recordFailure(input: FailureInput): LearnedLesson | null {
    // Recurrence key (P2): tool:category:target — category matters. Without
    // it, `npm run dev → EADDRINUSE` and `npm run dev → command_not_found`
    // merge into one "recurring failure" and produce a nonsense lesson.
    const key = `${input.tool}:${input.category}:${input.target}`.slice(0, 160);
    const { cause, correction } = classifyRootCause(input.category, input.observation);
    const isNew = this.store.add(
      {
        type: "failure",
        key,
        statement: `${input.tool} failed (${input.category}) on ${input.target}: ${input.observation.slice(0, 160)}`,
        cause,
        correction,
        source: "failure_pipeline",
        verified: false,
      },
    );
    if (isNew) return null;

    // The failure already existed → it recurred → promote to a verified lesson.
    const failure = this.store.all("failure").find((f) => f.key === key);
    const hits = failure?.hits ?? 1;
    if (hits < this.promotionThreshold) return null;

    const lesson: LearnedLesson = {
      key,
      statement: `Before ${describeTarget(input.target, input.tool)}, ${lowerFirst(correction)}`,
      cause,
      correction,
      verification: `Observed ${hits} times: the same ${input.category} failure recurred; correction applied prevents it.`,
    };
    const added = this.store.add(
      {
        type: "lesson",
        key,
        statement: lesson.statement,
        cause: lesson.cause,
        correction: lesson.correction,
        verification: lesson.verification,
        source: "failure_pipeline",
        verified: true,
      },
    );
    return added ? lesson : null;
  }

  /** Record an explicit rejection (user or evidence-driven) of an approach. */
  recordRejection(approach: string, reason: string, revisitIf?: string): boolean {
    return this.store.add({
      type: "rejected_approach",
      key: approach.slice(0, 120),
      statement: `Rejected approach: ${approach}`,
      reason,
      revisitIf,
      source: "user_or_evidence",
      verified: true,
    });
  }

  /** Record a durable user rule (top of the trust hierarchy). */
  recordUserRule(rule: string): boolean {
    return this.store.add({
      type: "user_rule",
      key: rule.slice(0, 120),
      statement: rule,
      source: "user_instruction",
      verified: true,
    });
  }

  /** Retrieve memory relevant to an instruction, capped, trust-ordered. */
  retrieveFor(instruction: string, limit = 6): MemoryRecord[] {
    return this.store.query(instruction, ["user_rule", "lesson", "rejected_approach", "fact", "decision", "objection"], limit);
  }

  /** Format retrieved memory for injection into the model context. */
  formatForContext(records: MemoryRecord[]): string {
    if (!records.length) return "";
    const lines: string[] = ["PROJECT MEMORY (trusted, retrieved for this task):"];
    for (const r of records) {
      switch (r.type) {
        case "user_rule":
          lines.push(`- RULE: ${r.statement}`);
          break;
        case "lesson":
          lines.push(`- LESSON (${r.key}): ${r.correction}`);
          break;
        case "rejected_approach":
          lines.push(`- REJECTED: ${r.key}${r.reason ? ` — ${r.reason}` : ""}${r.revisitIf ? ` (revisit if: ${r.revisitIf})` : ""}. Do not resurrect without new justification.`);
          break;
        case "fact":
          lines.push(`- FACT: ${r.statement}`);
          break;
        case "decision":
          lines.push(`- DECISION: ${r.statement}`);
          break;
        case "objection":
          lines.push(`- PRIOR OBJECTION (${r.source}): ${r.statement} — evaluate whether it still applies before proceeding.`);
          break;
        default:
          break;
      }
    }
    return lines.join("\n");
  }
}

function describeTarget(target: string, tool: string): string {
  if (tool === "run_shell") return `running \`${target}\``;
  return `working with ${target}`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
