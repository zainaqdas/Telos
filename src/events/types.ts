/**
 * Event model (Part 14). The append-only event log is authoritative;
 * TeamState is derived by a pure reducer. Events carry only facts.
 */

export type TaskStatus = "active" | "completed" | "cancelled" | "budget_exceeded" | "failed";

export type EventKind =
  | "task_started"
  | "task_updated"
  | "user_instruction"
  | "user_correction"
  | "finding"
  | "proposal"
  | "proposal_invalidated"
  | "blocker_resolved"
  | "objection"
  | "objection_debated"
  | "objection_resolved"
  | "decision"
  | "delegation"
  | "worker_started"
  | "worker_waiting"
  | "worker_completed"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "test_result"
  | "review_result"
  | "verification_result"
  | "failure"
  | "lesson_candidate"
  | "lesson_verified"
  | "blocker"
  | "blocker_waived"
  | "requirement_added"
  | "requirement_satisfied"
  | "requirement_invalidated"
  | "skill_activated"
  | "budget_exceeded"
  | "task_completed"
  | "task_cancelled";

export interface Evidence {
  /** Where the evidence came from, e.g. "tool:run_shell" or "worker:reviewer". */
  source: string;
  /** What produced it: manager | worker:<id> | runtime. */
  producer: string;
  timestamp: string;
  /** Fingerprint of workspace state the observation is valid against. */
  fingerprint?: string;
  /** Human-readable observation, e.g. "exit 0, 14 passed". */
  observation: string;
  /** Whether the evidence is still current; invalidated when state moves on. */
  valid: boolean;
}

export interface RequirementRecord {
  id: string;
  description: string;
  required: boolean;
  status: "pending" | "in_progress" | "satisfied" | "failed" | "blocked" | "waived" | "invalidated";
  evidence: Evidence[];
  /** Guardrails the requirement belongs to (e.g. "security"), when applicable. */
  guardrail?: string;
  /** Skill that registered this requirement, for the gate's skill audit. */
  skill?: string;
}

export interface BudgetSnapshot {
  tokensUsed: number;
  toolCallsUsed: number;
  modelCallsUsed: number;
  workersSpawned: number;
  limits: {
    maxTotalTokens: number;
    maxToolCalls: number;
    maxWorkerSpawns: number;
    maxParallelWorkers: number;
    maxWallTimeSeconds: number;
  };
}

export interface AgentEvent {
  seq: number;
  /** Wall time in ms since task start — ordering comes from seq, not clocks. */
  t: number;
  taskId: string;
  kind: EventKind;
  data: Record<string, unknown>;
}

export interface TaskMeta {
  id: string;
  startedAt: number;
  title: string;
  status: TaskStatus;
  endReason?: string;
}

/** Lifecycle of a worker proposal: corrections force needs_rework (Part 91). */
export type ProposalStatus = "active" | "invalidated" | "superseded" | "needs_rework";

/** Derived state — a pure projection of the event log (Part 14). */
export interface TeamState {
  task: TaskMeta;
  instructions: Array<{ text: string; t: number; isCorrection: boolean }>;
  requirements: Map<string, RequirementRecord>;
  decisions: Array<{ id: string; statement: string; reason?: string; status: "active" | "superseded"; t: number }>;
  objections: Array<{ id: string; statement: string; raisedBy: string; t: number; resolved: boolean; debate?: { verdict: "upheld" | "dismissed" | "needs_decision"; rationale: string } }>;
  blockers: Array<{ id: string; reason: string; status: "open" | "resolved" | "waived"; t: number }>;
  findings: Array<{ text: string; source: string; t: number }>;
  /** Worker proposals (Part 91): first-class, status tracks correction invalidation. */
  proposals: Map<string, { statement: string; raisedBy: string; status: "active" | "invalidated" | "superseded" | "needs_rework"; t: number }>;
  /** Skill checklist bookkeeping for the gate's audit (Part 36). */
  skills: Map<string, { name: string; source: string; status: "active"; requirementIds: string[]; activatedAt: number }>;
  workers: Map<string, { role: string; status: "running" | "completed" | "failed"; startedAt: number }>;
  budget: BudgetSnapshot;
  taskStatus: TaskStatus;
  endReason?: string;
}
