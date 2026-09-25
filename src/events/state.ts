import type { AgentEvent, BudgetSnapshot, RequirementRecord, TeamState } from "./types.ts";

/**
 * Pure reducer: events → TeamState (Part 14). No I/O, no clock reads —
 * timestamps come from the events themselves.
 */
export function reduce(events: AgentEvent[]): TeamState {
  const first = events[0];
  const taskId = first?.taskId ?? "";
  const taskStart = first?.t ?? 0;
  const startedAt = first ? Date.now() - first.t : Date.now();

  const state: TeamState = {
    task: { id: taskId, startedAt, title: "", status: "active" },
    instructions: [],
    requirements: new Map(),
    decisions: [],
    objections: [],
    blockers: [],
    findings: [],
    workers: new Map(),
    budget: makeBudget({ tokensUsed: 0, toolCallsUsed: 0, modelCallsUsed: 0, workersSpawned: 0 }, taskStart),
    taskStatus: "active",
  };

  for (const ev of events) {
    apply(state, ev);
  }
  return state;
}

function makeBudget(
  used: { tokensUsed: number; toolCallsUsed: number; modelCallsUsed: number; workersSpawned: number },
  t: number,
): BudgetSnapshot {
  void t;
  return {
    tokensUsed: used.tokensUsed,
    toolCallsUsed: used.toolCallsUsed,
    modelCallsUsed: used.modelCallsUsed,
    workersSpawned: used.workersSpawned,
    limits: { maxTotalTokens: 0, maxToolCalls: 0, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 0 },
  };
}

function apply(state: TeamState, ev: AgentEvent): void {
  const d = ev.data;
  switch (ev.kind) {
    case "task_started": {
      state.task.title = str(d["title"]);
      state.task.startedAt = Date.now() - ev.t;
      const limits = obj(d["limits"]);
      state.budget.limits = {
        maxTotalTokens: num(limits["max_total_tokens"], state.budget.limits.maxTotalTokens),
        maxToolCalls: num(limits["max_tool_calls"], state.budget.limits.maxToolCalls),
        maxWorkerSpawns: num(limits["max_worker_spawns"], state.budget.limits.maxWorkerSpawns),
        maxParallelWorkers: num(limits["max_parallel_workers"], state.budget.limits.maxParallelWorkers),
        maxWallTimeSeconds: num(limits["max_wall_time_seconds"], state.budget.limits.maxWallTimeSeconds),
      };
      break;
    }
    case "user_instruction":
      state.instructions.push({ text: str(d["text"]), t: ev.t, isCorrection: false });
      break;
    case "user_correction":
      state.instructions.push({ text: str(d["text"]), t: ev.t, isCorrection: true });
      // A correction may conflict with any prior work (Part 15): pending,
      // in-progress, AND satisfied requirements are invalidated so stale work
      // can never silently survive. Blocked/failed/waived keep their status.
      for (const req of state.requirements.values()) {
        if (req.status === "pending" || req.status === "in_progress" || req.status === "satisfied") {
          req.status = "invalidated";
          for (const e of req.evidence) e.valid = false;
        }
      }
      break;
    case "requirement_added": {
      const rec: RequirementRecord = {
        id: str(d["id"]),
        description: str(d["description"]),
        required: bool(d["required"], true),
        status: "pending",
        evidence: [],
        guardrail: optStr(d["guardrail"]),
      };
      state.requirements.set(rec.id, rec);
      break;
    }
    case "requirement_satisfied": {
      const req = state.requirements.get(str(d["id"]));
      if (!req) break;
      req.status = "satisfied";
      req.evidence.push({
        source: str(d["source"]),
        producer: str(d["producer"]),
        timestamp: new Date(Date.now() - ev.t).toISOString(),
        fingerprint: optStr(d["fingerprint"]),
        observation: str(d["observation"]),
        valid: true,
      });
      break;
    }
    case "requirement_invalidated": {
      const req = state.requirements.get(str(d["id"]));
      if (!req) break;
      req.status = "invalidated";
      for (const e of req.evidence) e.valid = false;
      break;
    }
    case "tool_started":
      state.budget.toolCallsUsed += 1;
      break;
    case "tool_completed":
      break;
    case "tool_failed":
      break;
    case "finding":
      state.findings.push({ text: str(d["text"]), source: str(d["source"]), t: ev.t });
      break;
    case "decision":
      state.decisions.push({
        id: str(d["id"]),
        statement: str(d["statement"]),
        reason: optStr(d["reason"]),
        status: "active",
        t: ev.t,
      });
      break;
    case "objection":
      state.objections.push({ id: str(d["id"]), statement: str(d["statement"]), raisedBy: str(d["raised_by"]), t: ev.t, resolved: false });
      break;
    case "blocker":
      state.blockers.push({ id: str(d["id"]), reason: str(d["reason"]), status: "open", t: ev.t });
      break;
    case "delegation":
    case "worker_started":
      if (ev.kind === "worker_started") {
        state.workers.set(str(d["id"]), { role: str(d["role"]), status: "running", startedAt: ev.t });
        state.budget.workersSpawned += 1;
      }
      break;
    case "worker_completed": {
      const w = state.workers.get(str(d["id"]));
      if (w) w.status = bool(d["ok"], true) ? "completed" : "failed";
      break;
    }
    case "budget_exceeded":
      state.taskStatus = "budget_exceeded";
      state.endReason = str(d["resource"]);
      state.task.status = "budget_exceeded";
      break;
    case "task_completed":
      state.taskStatus = "completed";
      state.task.status = "completed";
      state.task.endReason = str(d["reason"]);
      break;
    case "task_cancelled":
      state.taskStatus = "cancelled";
      state.task.status = "cancelled";
      state.task.endReason = str(d["reason"]);
      break;
    case "task_updated":
    case "test_result":
    case "review_result":
    case "verification_result":
    case "failure":
    case "lesson_candidate":
    case "lesson_verified":
      break;
  }
}

// ─── Small extraction helpers (never throw on malformed events) ──────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
