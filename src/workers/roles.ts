/**
 * Worker roles (Parts 8–9). Workers are roles, not personalities: each has a
 * mission, a read-only tool allowlist, and an output contract. No permanent
 * staff — spawned per task by the Manager through the delegate tool.
 */

export type WorkerRole = "explorer" | "researcher" | "reviewer" | "qa";

export interface RoleSpec {
  role: WorkerRole;
  /** Tools this role may use (subset of the shared registry). */
  allowedTools: string[];
  /** Mission framing for the worker's system prompt. */
  mission: string;
  /** Output contract appended to the mission. */
  outputContract: string;
}

export const ROLES: Record<WorkerRole, RoleSpec> = {
  explorer: {
    role: "explorer",
    allowedTools: ["read_file", "list_directory", "find_files", "search_text", "git_status", "git_log", "git_diff"],
    mission:
      "Map the repository territory relevant to the question: which files own which behavior, how components connect, and where the risk of change concentrates.",
    outputContract:
      "Report with sections: FINDING (one claim per finding), EVIDENCE (file:line or command output backing it), RISK (what could break), RECOMMENDATION (what the Manager should do).",
  },
  researcher: {
    role: "researcher",
    allowedTools: ["read_file", "list_directory", "find_files", "search_text"],
    mission:
      "Answer questions about external libraries, APIs, and frameworks from the repository's own dependency files and docs; clearly separate what you verified from what you could not.",
    outputContract:
      "Report with sections: FINDING, EVIDENCE (quote the dependency manifest, doc line, or code you verified), CONFIDENCE (high/medium/low with what remains unverified).",
  },
  reviewer: {
    role: "reviewer",
    allowedTools: ["read_file", "list_directory", "find_files", "search_text", "git_status", "git_diff", "git_log"],
    mission:
      "Adversarially review the proposed or completed change: correctness, edge cases, regressions, and conflicts with existing architecture or user rules.",
    outputContract:
      "Report with sections: VERDICT (approve / request_changes), FINDING (defects only, one per finding, with severity), EVIDENCE (file:line), OBJECTION (any plan-level disagreement with your recommended alternative).",
  },
  qa: {
    role: "qa",
    allowedTools: ["read_file", "list_directory", "find_files", "search_text", "run_shell", "git_status", "git_diff"],
    mission:
      "Reproduce, exercise, and verify behavior. You may run read-mostly shell commands (tests, builds, scripts) but you do NOT modify production source files.",
    outputContract:
      "Report with sections: TESTED (what you ran), RESULT (pass/fail with exit codes and output), EVIDENCE (commands + outputs), REMAINING_UNCERTAINTY (what you could not verify).",
  },
};

/** A structured report parsed from the worker's final message. */
export interface WorkerReport {
  findings: Array<{ claim: string; evidence?: string }>;
  risks: string[];
  recommendations: string[];
  objections: Array<{ statement: string; evidence?: string; recommendation?: string }>;
  /** A concrete plan or change the worker proposes (Part 13). */
  proposals: Array<{ statement: string; rationale?: string }>;
  /** Something the worker cannot resolve; must stay visible until resolved. */
  blockers: string[];
  confidence?: "high" | "medium" | "low";
  verdict?: "approve" | "request_changes";
  tested?: string[];
  raw: string;
}

/** An all-empty report (parse failure, transport error, contract failure). */
export function emptyReport(raw = ""): WorkerReport {
  return { findings: [], risks: [], recommendations: [], objections: [], proposals: [], blockers: [], raw };
}

/**
 * Parse the structured output contract. Tolerant of missing sections and
 * slight formatting drift; the raw text is always carried as a fallback.
 */
export function parseWorkerReport(text: string): WorkerReport {
  const lines = text.split("\n");
  // Each section-header occurrence starts a NEW group (two BLOCKER: lines are
  // two blockers, not one multi-line blocker); headerless continuation lines
  // extend the current group, and bullet lists inside a group still split.
  const sections = new Map<string, string[][]>();
  let currentGroup: string[] | undefined;
  for (const line of lines) {
    const m = /^\s*(FINDING|EVIDENCE|RISK|RECOMMENDATION|OBJECTION|CONFIDENCE|VERDICT|TESTED|RESULT|REMAINING_UNCERTAINTY|PROPOSAL|BLOCKER)\b[:\s]*(.*)$/i.exec(line);
    if (m) {
      const name = m[1]!.toUpperCase();
      let groups = sections.get(name);
      if (!groups) {
        groups = [];
        sections.set(name, groups);
      }
      const group: string[] = [];
      groups.push(group);
      const rest = m[2]?.trim();
      if (rest) group.push(rest);
      currentGroup = group;
    } else if (currentGroup) {
      currentGroup.push(line);
    }
  }

  const collect = (name: string): string[] =>
    (sections.get(name) ?? [])
      .map((group) => group.join("\n"))
      .flatMap((block) =>
        block
          .split(/\n(?=\s*[-•*]|\s*\d+[.)])/)
          .map((s) => s.replace(/^\s*(?:[-•*]|\d+[.)])?\s*/, "").trim())
          .filter((s) => s.length > 0),
      );

  const findings = collect("FINDING");
  const evidence = collect("EVIDENCE");
  const confidenceRaw = (sections.get("CONFIDENCE") ?? []).flat().join(" ").toLowerCase();
  const verdictRaw = (sections.get("VERDICT") ?? []).flat().join(" ").toLowerCase();

  return {
    findings: findings.map((claim, i) => ({ claim, evidence: evidence[i] })),
    risks: collect("RISK"),
    recommendations: collect("RECOMMENDATION"),
    objections: collect("OBJECTION").map((o) => ({ statement: o, recommendation: undefined })),
    proposals: collect("PROPOSAL").map((p) => ({ statement: p, rationale: undefined })),
    blockers: collect("BLOCKER"),
    confidence: confidenceRaw.includes("high") ? "high" : confidenceRaw.includes("low") ? "low" : confidenceRaw.includes("medium") ? "medium" : undefined,
    verdict: verdictRaw.includes("request_changes") ? "request_changes" : verdictRaw.includes("approve") ? "approve" : undefined,
    tested: collect("TESTED"),
    raw: text,
  };
}

/**
 * Objection debate (Part 93): deterministic classification of how a worker's
 * objection relates to a user correction or decision. The Manager gets the
 * classification and the burden of proof rule — it does not get to wave the
 * objection away or silently comply-and-hope.
 */
export type ObjectionDebate =
  | { verdict: "upheld"; rationale: string }
  | { verdict: "dismissed"; rationale: string }
  | { verdict: "needs_decision"; rationale: string };

export function evaluateObjection(objection: string, correction: string): ObjectionDebate {
  const o = objection.toLowerCase();
  const c = correction.toLowerCase();
  // The correction directly names the objection's subject → worker was heard;
  // the Manager answered the concern explicitly.
  const oWords = o.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  const hits = oWords.filter((w) => c.includes(w)).length;
  if (oWords.length > 0 && hits / oWords.length >= 0.5) {
    return { verdict: "upheld", rationale: `correction addresses the objection's subject (${hits}/${oWords.length} key terms)` };
  }
  // Corrective edge cases are never a reason to keep building on a rule the
  // user just revoked — but a genuine risk call-out (regression/data loss/
  // security) survives and must be decided, not ignored.
  if (RISK_TERMS.some((t) => o.includes(t))) {
    return {
      verdict: "needs_decision",
      rationale: "objection flags a concrete risk (regression/data-loss/security) the correction does not address; surface it to the user before proceeding",
    };
  }
  return { verdict: "dismissed", rationale: "objection restates preference, not risk; user correction has priority (Part 15)" };
}

const STOP_WORDS = new Set(["that", "this", "with", "would", "could", "should", "when", "then", "have", "will", "from", "into", "only", "also", "because", "which", "their", "them", "were"]);

const RISK_TERMS = ["regression", "data loss", "corrupt", "security", "race", "deadlock", "migration", "backwards", "breaking change", "inject"];

/** Render a report compactly for the Manager's transcript. */
export function formatReportForManager(role: WorkerRole, workerId: string, report: WorkerReport): string {
  const parts: string[] = [`WORKER REPORT (${role} ${workerId})`];
  if (report.verdict) parts.push(`VERDICT: ${report.verdict}`);
  for (const f of report.findings) parts.push(`FINDING: ${f.claim}${f.evidence ? `\n  EVIDENCE: ${f.evidence}` : ""}`);
  for (const r of report.risks) parts.push(`RISK: ${r}`);
  for (const o of report.objections) parts.push(`OBJECTION: ${o.statement}`);
  for (const p of report.proposals) parts.push(`PROPOSAL: ${p.statement}`);
  for (const b of report.blockers) parts.push(`BLOCKER: ${b}`);
  for (const r of report.recommendations) parts.push(`RECOMMENDATION: ${r}`);
  if (report.tested?.length) parts.push(`TESTED: ${report.tested.join("; ")}`);
  if (report.confidence) parts.push(`CONFIDENCE: ${report.confidence}`);
  if (parts.length === 1) parts.push(report.raw.slice(0, 1500));
  return parts.join("\n");
}
