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
}

const VALID_ROLES = new Set(Object.keys(ROLES));

export class Orchestrator {
  private workerSeq = 0;
  private readonly rejectionHits = new Set<string>();
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

  /** Run one delegation: budget-gated spawn → scoped worker loop → report. */
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

    try {
      const scoped = this.scopedRegistry(ROLES[req.role].allowedTools);
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
          text: `You are ${req.role}, a task-scoped specialist worker. ${ROLES[req.role].mission}\n\nOUTPUT CONTRACT: ${ROLES[req.role].outputContract}\n\nYou are read-only in this workspace${req.role === "qa" ? " (you may run tests/builds but must not modify source)" : ""}. The Manager integrates your report; do not edit production files.\n\nQUESTION FROM MANAGER: ${req.question}${req.context ? `\n\nCONTEXT: ${req.context}` : ""}\n\nProduce your report now.`,
          isWorker: true,
        },
      });
      const result = await loop.run(`Answer the Manager's question: ${req.question}`);
      this.deps.events.append("worker_completed", { id: workerId, ok: result.status !== "provider_error" && result.status !== "cancelled" });
      const report = parseWorkerReport(result.assistantText);
      this.reconcile(workerId, req.role, report);
      return { workerId, role: req.role, report, tokens: result.usage.totalTokens, toolCalls: this.deps.budget.used.toolCalls };
    } catch (err) {
      this.deps.events.append("worker_completed", { id: workerId, ok: false });
      return this.failed(`worker ${workerId} (${req.role}) failed: ${(err as Error).message}`);
    }
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

  /** Record findings/objections as first-class events (Parts 12–13). */
  private reconcile(workerId: string, role: WorkerRole, report: WorkerReport): void {
    for (const f of report.findings.slice(0, 5)) {
      this.deps.events.append("finding", { source: `${role}:${workerId}`, text: f.claim.slice(0, 240) });
    }
    for (const o of report.objections.slice(0, 3)) {
      this.deps.events.append("objection", { raised_by: `${role}:${workerId}`, statement: o.statement.slice(0, 240) });
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
