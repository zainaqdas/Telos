import type { AgentEvent, RequirementRecord, TeamState } from "../events/types.ts";
import { reduce } from "../events/state.ts";

/**
 * The Completion Gate (Parts 17–21) — exactly one completion authority.
 * The Manager proposes completion; the Gate decides. Model explanations are
 * not evidence: the Gate reads derived TeamState (requirements + evidence)
 * and, where relevant, fresh tool results recorded as evidence.
 */

export type GateVerdict = "COMPLETE" | "INCOMPLETE" | "BLOCKED";

export interface GateInput {
  /** Fresh evidence gathered now (e.g. a just-run test suite). */
  freshEvidence?: Array<{
    requirementId: string;
    source: string;
    producer: string;
    observation: string;
    ok: boolean;
    fingerprint?: string;
  }>;
  /** User instruction like "just investigate, don't change anything". */
  waive?: string[];
}

export interface GateReport {
  verdict: GateVerdict;
  satisfied: string[];
  unsatisfied: string[];
  blocked: string[];
  invalidated: string[];
  summary: string;
}

export class CompletionGate {
  private readonly events: () => AgentEvent[];

  constructor(events: () => AgentEvent[]) {
    this.events = events;
  }

  /**
   * Evaluate the Gate. `freshEvidence` entries are checked against the
   * derived state — but the Gate still refuses to satisfy a requirement
   * whose evidence producer is the model's say-so alone.
   */
  evaluate(input: GateInput = {}): GateReport {
    const events = this.events();
    const state = reduce(events);
    const requirements = [...state.requirements.values()];
    const required = requirements.filter((r) => r.required);
    const waived = new Set(input.waive ?? []);

    const satisfied: string[] = [];
    const unsatisfied: string[] = [];
    const blocked: string[] = [];
    const invalidated: string[] = [];

    for (const req of required) {
      if (waived.has(req.id) || req.status === "waived") continue;
      switch (req.status) {
        case "satisfied":
          satisfied.push(req.id);
          break;
        case "invalidated":
          invalidated.push(req.id);
          break;
        case "blocked":
          blocked.push(req.id);
          break;
        default: {
          const fresh = (input.freshEvidence ?? []).find((e) => e.requirementId === req.id && e.ok);
          if (fresh) satisfied.push(req.id);
          else unsatisfied.push(req.id);
        }
      }
    }

    // Runtime-derived rules (Part 21): the model's prose is not evidence.
    const MUTATORS = new Set(["write_file", "edit_file"]);
    const wroteWorkspace = events.some((e) => e.kind === "tool_completed" && MUTATORS.has(String(e.data["name"])));
    const ranVerification = events.some((e) => e.kind === "test_result" || e.kind === "verification_result");
    const unverifiedWrites = wroteWorkspace && !ranVerification;

    // A change-requesting instruction that ended in prose with no edits and no
    // verification is not complete — bias toward doing the work. Multi-word
    // patterns keep read/investigate tasks ("make sure", "make a summary of"…)
    // from being misread as change requests.
    const lastInstruction = state.instructions.at(-1)?.text ?? "";
    const requestedChanges =
      /\b(fix|add|implement|refactor|update|remove|delete|write|change|create|install|migrate|rename)\b/i.test(lastInstruction) ||
      /\bmake (it|the|this|me)\b/i.test(lastInstruction) ||
      /\bmake (a|an) (new|fix|change|file|component|feature)\b/i.test(lastInstruction);
    const changeRequestedButNotMade = requestedChanges && !wroteWorkspace && !ranVerification;

    let verdict: GateVerdict;
    if (blocked.length > 0) verdict = "BLOCKED";
    else if (unsatisfied.length > 0 || invalidated.length > 0 || unverifiedWrites || changeRequestedButNotMade) verdict = "INCOMPLETE";
    else verdict = "COMPLETE";

    const parts: string[] = [];
    if (satisfied.length) parts.push(`satisfied: ${satisfied.join(", ")}`);
    if (unsatisfied.length) parts.push(`unsatisfied: ${unsatisfied.join(", ")}`);
    if (blocked.length) parts.push(`blocked: ${blocked.join(", ")}`);
    if (invalidated.length) parts.push(`invalidated: ${invalidated.join(", ")}`);
    if (unverifiedWrites) parts.push("workspace was modified but nothing was run to verify it");
    if (changeRequestedButNotMade) parts.push("instruction requested changes but no workspace change or verification occurred");
    const summary = verdict === "COMPLETE" ? `all ${satisfied.length} required conditions satisfied` : parts.join("; ") || "no requirements registered";

    return { verdict, satisfied, unsatisfied, blocked, invalidated, summary };
  }
}

/** Format a Gate report for the transcript (no theater, facts only). */
export function formatGateReport(report: GateReport): string {
  const icon = report.verdict === "COMPLETE" ? "✓" : report.verdict === "BLOCKED" ? "☒" : "•";
  return `${icon} Gate ${report.verdict} — ${report.summary}`;
}
