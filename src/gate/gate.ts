import type { AgentEvent, RequirementRecord, TeamState } from "../events/types.ts";
import { reduce } from "../events/state.ts";
import type { StateStore } from "../events/state-store.ts";

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
  private readonly source: (() => AgentEvent[]) | StateStore;

  constructor(source: (() => AgentEvent[]) | StateStore) {
    this.source = source;
  }

  /**
   * Evaluate the Gate. `freshEvidence` entries are checked against the
   * derived state — but the Gate still refuses to satisfy a requirement
   * whose evidence producer is the model's say-so alone.
   */
  evaluate(input: GateInput = {}): GateReport {
    // Store-backed (incremental, O(1) amortized) when available; the legacy
    // function source re-reads and re-reduces per call (kept for tests).
    const src = this.source;
    let state: TeamState;
    let events: readonly AgentEvent[];
    if (typeof src === "function") {
      const snap = src();
      state = reduce(snap);
      events = snap;
    } else {
      events = src.events();
      state = src.current();
    }
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

    // Skill audit (Part 39): every activated skill's checklist must be
    // satisfied before the gate can rule COMPLETE. Requirements registered
    // by skills already appear in `required` above; this adds visibility and
    // catches a skill whose checklist never got registered.
    const skillAudit = [...state.skills.values()].map((s) => {
      const own = [...state.requirements.values()].filter((r) => r.skill === s.name);
      const pending = own.filter((r) => r.status !== "satisfied" && r.status !== "waived").map((r) => r.id);
      return { skill: s.name, requirements: own.length, pending };
    });

    // Collaboration state (Part 93): blockers stay visible until a recorded
    // decision clears them, and objections whose debate verdict is
    // needs_decision block until a decision resolves them — the Manager
    // cannot complete a task past an unresolved disagreement.
    const openBlockers = state.blockers.filter((b) => b.status === "open" || (b.status === "waived" && b.waiverExpiresAt !== undefined && b.waiverExpiresAt <= Date.now()));
    const waivedBlockers = state.blockers.filter((b) => b.status === "waived" && !(b.waiverExpiresAt !== undefined && b.waiverExpiresAt <= Date.now()));
    const undecidedObjections = state.objections.filter((o) => !o.resolved && o.debate?.verdict === "needs_decision");

    // Plan audit (Scale Batch 5 item 16): the runtime stores the plan, so the
    // model can't silently drift off it. A recorded plan with unfinished steps
    // keeps the gate from declaring COMPLETE — the Manager must mark real
    // progress via update_plan (or the plan is stale and must be re-scoped).
    const planSteps = lastPlanSteps(events);
    const planDone = planSteps.filter((s) => s.status === "done").length;
    const planOpen = planSteps.length - planDone;

    let verdict: GateVerdict;
    if (blocked.length > 0 || openBlockers.length > 0 || undecidedObjections.length > 0) verdict = "BLOCKED";
    else if (unsatisfied.length > 0 || invalidated.length > 0 || unverifiedWrites || changeRequestedButNotMade || planOpen > 0) verdict = "INCOMPLETE";
    else verdict = "COMPLETE";

    const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
    const parts: string[] = [];
    if (satisfied.length) parts.push(`satisfied: ${satisfied.join(", ")}`);
    if (unsatisfied.length) parts.push(`unsatisfied: ${unsatisfied.join(", ")}`);
    if (blocked.length) parts.push(`blocked: ${blocked.join(", ")}`);
    if (invalidated.length) parts.push(`invalidated: ${invalidated.join(", ")}`);
    if (unverifiedWrites) parts.push("workspace was modified but nothing was run to verify it");
    if (changeRequestedButNotMade) parts.push("instruction requested changes but no workspace change or verification occurred");
    if (planOpen > 0) parts.push(`plan has ${planOpen} unfinished step(s) (${planDone}/${planSteps.length} done) — mark progress with update_plan, or re-scope the plan if it is stale`);
    for (const b of openBlockers) {
      const expired = b.status === "waived";
      parts.push(`open blocker ${b.id}${expired ? " (waiver expired)" : ""}: ${clip(b.reason)} — resolve via the decision tool${expired ? " or re-waive via /waive" : ""}`);
    }
    for (const b of waivedBlockers) parts.push(`waived blocker ${b.id}: ${clip(b.reason)} (user waived via /waive)`);
    for (const o of undecidedObjections) parts.push(`objection ${o.id || "(legacy)"} awaits a decision: ${clip(o.statement)}`);
    for (const s of skillAudit) {
      if (s.pending.length) parts.push(`skill ${s.skill} pending: ${s.pending.join(", ")}`);
    }
    let summary = verdict === "COMPLETE" ? `all ${satisfied.length} required conditions satisfied` : parts.join("; ") || "no requirements registered";
    if (verdict === "COMPLETE" && waivedBlockers.length > 0) {
      summary += `; ${waivedBlockers.length} blocker(s) waived by user: ${waivedBlockers.map((b) => b.id).join(", ")}`;
    }

    return { verdict, satisfied, unsatisfied, blocked, invalidated, summary };
  }
}

/**
 * The most recent plan (Scale Batch 5): the LAST plan_updated event wins —
 * the plan is a whole-document replacement, so later events supersede.
 */
function lastPlanSteps(events: readonly AgentEvent[]): Array<{ text: string; status: string }> {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.kind !== "plan_updated") continue;
    const steps = ev.data["steps"];
    if (!Array.isArray(steps)) continue;
    return steps
      .map((s) => (typeof s === "object" && s !== null ? (s as Record<string, unknown>) : null))
      .filter((s): s is Record<string, unknown> => s !== null)
      .map((s) => ({ text: String(s["text"] ?? ""), status: String(s["status"] ?? "pending") }))
      .filter((s) => s.text.length > 0);
  }
  return [];
}

/** Format a Gate report for the transcript (no theater, facts only). */
export function formatGateReport(report: GateReport): string {
  const icon = report.verdict === "COMPLETE" ? "✓" : report.verdict === "BLOCKED" ? "☒" : "•";
  return `${icon} Gate ${report.verdict} — ${report.summary}`;
}
