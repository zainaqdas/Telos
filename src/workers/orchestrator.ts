import { createHash } from "node:crypto";
import { ToolRegistry, type ToolDefinition } from "../tools/registry.ts";
import type { BudgetEnforcer } from "../runtime/usage.ts";
import type { EventLog } from "../events/log.ts";
import { ROLES, parseWorkerReport, formatReportForManager, type WorkerRole, type WorkerReport } from "./roles.ts";
import { ManagerLoop } from "../manager/loop.ts";
import type { Provider } from "../providers/types.ts";
import type { ToolExecContext } from "../tools/registry.ts";
import type { SynergonConfig } from "../config/schema.ts";
import type { CancellationController } from "../runtime/cancellation.ts";
import type { FailureLearner } from "../memory/pipeline.ts";

/**
 * Orchestrator (Part 90): task decomposition happens in the Manager's model
 * turn; this component enforces the runtime side — worker budgets, scoped
 * toolsets, event bookkeeping, and reconciliation of worker output into
 * findings/objections. The Manager remains the primary builder: workers are
 * read-only (QA read-mostly) and every report is advisory input, never writes.
 */

export interface OrchestratorDeps {
  provider: Provider;
  model: string;
  config: SynergonConfig;
  registry: ToolRegistry;
  events: EventLog;
  budget: BudgetEnforcer;
  cancellation: CancellationController;
  ctx: ToolExecContext;
  learner?: FailureLearner;
}

interface DelegationRequest {
  role: WorkerRole;
  question: string;
  context?: string;
}

interface DelegationResult {
  workerId: string;
  role: WorkerRole;
  report: WorkerReport;
  tokens: number;
  toolCalls: number;
  error?: string;
  /** Populated when the worker signals it needs another cycle. */
  waitingFor?: string;
}

interface WorkerSession {
  id: string;
  role: WorkerRole;
  question: string;
  context?: string;
  cycles: number;
  /** What the worker said it is waiting for (from its last WAITING line). */
  waitingFor?: string;
  lastReport: WorkerReport;
}

const VALID_ROLES = new Set(Object.keys(ROLES));

export class Orchestrator {
  private workerSeq = 0;
  /** Task-scoped worker sessions (multi-cycle resumability, Part 11). */
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /** Parse and validate a delegate tool call's arguments. */
  parseDelegation(args: Record<string, unknown>): { ok: true; req: DelegationRequest } | { ok: false; error: string } {
    const role = typeof args["role"] === "string" ? args["role"].toLowerCase() : "";
    const question = typeof args["question"] === "string" ? args["question"].trim() : "";
    const context = typeof args["context"] === "string" ? args["context"] : undefined;
    if (!VALID_ROLES.has(role)) {
      return { ok: false, error: `role must be one of: ${[...VALID_ROLES].join(", ")}` };
    }
    if (!question) return { ok: false, error: "question is required — state the specific engineering question this worker must answer" };
    return { ok: true, req: { role: role as WorkerRole, question, context } };
  }

  /** Validate continue_worker tool call arguments. */
  parseContinue(args: Record<string, unknown>): { ok: true; workerId: string; update: string } | { ok: false; error: string } {
    const workerId = typeof args["worker_id"] === "string" ? args["worker_id"].trim() : "";
    const update = typeof args["update"] === "string" ? args["update"].trim() : "";
    if (!workerId) return { ok: false, error: "worker_id is required (from the original delegate result)" };
    if (!update) return { ok: false, error: "update is required — tell the worker what changed since it went waiting" };
    return { ok: true, workerId, update };
  }

  /** Continue tool definition for resuming waiting workers. */
  continueTool(): ToolDefinition {
    return {
      name: "continue_worker",
      description:
        "Resume a waiting worker (one that ended with WAITING) after the situation changed — e.g. the fix is now applied, a test run exists, credentials were added. Supply what changed as the update.",
      permission: "read",
      mutative: false,
      risk: "low",
      parameters: {
        type: "object",
        properties: {
          worker_id: { type: "string", description: "The workerId from the original delegate result" },
          update: { type: "string", description: "What changed since the worker went waiting (concrete: files edited, commands run, answers)" },
        },
        required: ["worker_id", "update"],
        additionalProperties: false,
      },
      execute: async (args, _ctx) => {
        void _ctx;
        const parsed = this.parseContinue(args);
        if (!parsed.ok) return { ok: false, output: `continue_worker: ${parsed.error}`, errorCategory: "bad_args" };
        const result = await this.continueWorker(parsed.workerId, parsed.update);
        return { ok: !result.error, output: result.error ?? formatReportForManager(result.role, result.workerId, result.report) };
      },
    };
  }

  /** Delegate tool definition, registered once; executes via runDelegation. */
  delegateTool(): ToolDefinition {
    return {
      name: "delegate",
      description:
        "Delegate a bounded, read-only investigation to a specialist worker: explorer (repository/architecture), researcher (dependencies/APIs/docs in-repo), reviewer (adversarial review of changes), qa (reproduce and run tests/builds). Parallel delegations run concurrently when the worker budget allows. Workers cannot edit files; you integrate their reports.",
      permission: "read",
      mutative: false,
      risk: "low",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: [...VALID_ROLES], description: "explorer | researcher | reviewer | qa" },
          question: { type: "string", description: "The specific engineering question to answer (be concrete: files, change, behavior)" },
          context: { type: "string", description: "Optional context: what you already know, files of interest, the proposed change" },
        },
        required: ["role", "question"],
        additionalProperties: false,
      },
      execute: async (args, _ctx) => {
        void _ctx;
        const parsed = this.parseDelegation(args);
        if (!parsed.ok) return { ok: false, output: `delegate: ${parsed.error}`, errorCategory: "bad_args" };
        const result = await this.runDelegation(parsed.req);
        return { ok: !result.error, output: result.error ?? formatReportForManager(result.role, result.workerId, result.report) };
      },
    };
  }

  /**
   * Run one delegation: budget-gated spawn → scoped worker loop → report.
   * If the worker ends with a WAITING line (needs something it cannot get —
   * e.g. a pending edit to review), the session is kept and resumable via
   * continue_worker (Part 10 lifecycle: working → waiting → working).
   */
  async runDelegation(req: DelegationRequest): Promise<DelegationResult> {
    // Hard worker budgets (Part 22): spawn + parallel limits are runtime-enforced.
    const spawnVerdict = this.deps.budget.check("worker_spawn");
    if (!spawnVerdict.allowed) {
      return this.failed(`delegate refused by runtime: ${spawnVerdict.message}. Integrate what you have and proceed yourself.`);
    }

    const workerId = `w${++this.workerSeq}-${createHash("sha1").update(`${req.role}:${req.question}`).digest("hex").slice(0, 4)}`;
    this.deps.budget.record("worker_spawn");
    this.deps.events.append("delegation", { workerId, role: req.role, question: req.question.slice(0, 200) });
    this.deps.events.append("worker_started", { id: workerId, role: req.role });

    const session: WorkerSession = {
      id: workerId,
      role: req.role,
      question: req.question,
      context: req.context,
      cycles: 0,
      lastReport: { findings: [], risks: [], recommendations: [], objections: [], raw: "" },
    };
    this.sessions.set(workerId, session);

    try {
      const result = await this.runCycle(session, req.context);
      return result;
    } catch (err) {
      this.deps.events.append("worker_completed", { id: workerId, ok: false });
      this.sessions.delete(workerId);
      return this.failed(`worker ${workerId} (${req.role}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Resume a waiting worker with new context (e.g. "the fix is now applied —
   * re-review"). Refuses unknown or already-completed workers.
   */
  async continueWorker(workerId: string, update: string): Promise<DelegationResult> {
    const session = this.sessions.get(workerId);
    if (!session) {
      return this.failed(`continue_worker: no waiting worker '${workerId}'. Waiting: ${this.waitingWorkerIds().join(", ") || "none"}.`);
    }
    this.deps.events.append("worker_started", { id: workerId, role: session.role, resumed: true, cycle: session.cycles + 1 });
    try {
      const result = await this.runCycle(session, update);
      return result;
    } catch (err) {
      this.deps.events.append("worker_completed", { id: workerId, ok: false });
      this.sessions.delete(workerId);
      return this.failed(`worker ${workerId} failed on resume: ${(err as Error).message}`);
    }
  }

  /** IDs of workers currently in the waiting state. */
  waitingWorkerIds(): string[] {
    return [...this.sessions.entries()].filter(([, s]) => s.waitingFor).map(([id]) => id);
  }

  /** One investigation cycle: scoped loop run → report parse → reconcile. */
  private async runCycle(session: WorkerSession, extraContext?: string): Promise<DelegationResult> {
    const scoped = this.scopedRegistry(ROLES[session.role].allowedTools);
    const cycle = session.cycles + 1;
    const loop = new ManagerLoop({
      provider: this.deps.provider,
      model: this.deps.model,
      config: this.deps.config,
      registry: scoped,
      events: this.deps.events,
      budget: this.deps.budget, // shared pools: workers and manager draw the same budget (Part 22)
      cancellation: this.deps.cancellation,
      ctx: this.deps.ctx,
      learner: this.deps.learner,
      workerPromptOverride: {
        text:
          `You are ${session.role}, a task-scoped specialist worker. ${ROLES[session.role].mission}\n\n` +
          `OUTPUT CONTRACT: ${ROLES[session.role].outputContract}\n` +
          `If you cannot complete your mission because you are waiting on something (e.g. an edit not yet applied, missing test run), end your reply with a line 'WAITING: <what you need>' instead of speculating.\n\n` +
          `You are read-only in this workspace${session.role === "qa" ? " (you may run tests/builds but must not modify source)" : ""}. The Manager integrates your report; do not edit production files.\n\n` +
          `QUESTION FROM MANAGER: ${session.question}${session.context ? `\n\nCONTEXT: ${session.context}` : ""}${extraContext ? `\n\nUPDATE FROM MANAGER: ${extraContext}` : ""}\n\n` +
          (cycle > 1 ? `This is investigation cycle ${cycle}; you already reported ${session.cycles} time(s). Build on your prior findings.` : "Produce your report now."),
        isWorker: true,
      },
    });
    const result = await loop.run(cycle === 1 ? `Answer the Manager's question: ${session.question}` : `Continue your investigation: ${extraContext ?? ""}`);
    session.cycles = cycle;
    const report = parseWorkerReport(result.assistantText);
    session.lastReport = report;

    // Waiting state detection: explicit WAITING line in the final message.
    const waitingMatch = /WAITING:\s*(.+)$/im.exec(result.assistantText);
    if (waitingMatch && !result.assistantText.includes("VERDICT") && report.findings.length === 0) {
      session.waitingFor = waitingMatch[1]!.trim().slice(0, 200);
      this.deps.events.append("worker_waiting", { id: session.id, role: session.role, cycle, waiting_for: session.waitingFor });
      return {
        workerId: session.id,
        role: session.role,
        report,
        tokens: result.usage.totalTokens,
        toolCalls: this.deps.budget.used.toolCalls,
        waitingFor: session.waitingFor,
        error: `WORKER WAITING: ${session.waitingFor}. Resume later with continue_worker (workerId: ${session.id}) when the situation changes.`,
      };
    }

    session.waitingFor = undefined;
    this.deps.events.append("worker_completed", { id: session.id, ok: result.status !== "provider_error" && result.status !== "cancelled", cycle });
    this.reconcile(session.id, session.role, report);
    if (cycle > 1) this.sessions.delete(session.id);
    return { workerId: session.id, role: session.role, report, tokens: result.usage.totalTokens, toolCalls: this.deps.budget.used.toolCalls };
  }

  /** Run several delegations with bounded parallelism; returns all results. */
  async runParallel(reqs: DelegationRequest[], maxParallel: number): Promise<DelegationResult[]> {
    const queue = [...reqs];
    const results: DelegationResult[] = [];
    const lanes = Math.max(1, Math.min(maxParallel, queue.length));
    await Promise.all(
      Array.from({ length: lanes }, async () => {
        while (queue.length > 0) {
          const req = queue.shift();
          if (!req) break;
          results.push(await this.runDelegation(req));
        }
      }),
    );
    return results;
  }

  /** Record findings/objections as first-class events (Parts 12–13) and
   *  persist them to memory so future sessions retrieve them without
   *  re-reading raw event logs. */
  private reconcile(workerId: string, role: WorkerRole, report: WorkerReport): void {
    for (const f of report.findings.slice(0, 5)) {
      const text = f.claim.slice(0, 240);
      this.deps.events.append("finding", { source: `${role}:${workerId}`, text });
      this.deps.learner?.store.add({
        type: "fact",
        key: text.slice(0, 100),
        statement: text,
        source: `${role}:${workerId}`,
        verified: Boolean(f.evidence),
      });
    }
    for (const o of report.objections.slice(0, 3)) {
      const statement = o.statement.slice(0, 240);
      this.deps.events.append("objection", { raised_by: `${role}:${workerId}`, statement });
      this.deps.learner?.store.add({
        type: "objection",
        key: statement.slice(0, 100),
        statement,
        source: `${role}:${workerId}`,
        verified: true,
      });
    }
  }

  /** Build a registry view containing only the role's allowed tools. */
  private scopedRegistry(allowed: string[]): ToolRegistry {
    const view = new ToolRegistry();
    for (const name of allowed) {
      const tool = this.deps.registry.get(name);
      if (tool) view.register(tool);
    }
    return view;
  }

  private failed(message: string): DelegationResult {
    return { workerId: "none", role: "explorer", report: { findings: [], risks: [], recommendations: [], objections: [], raw: message }, tokens: 0, toolCalls: 0, error: message };
  }
}
