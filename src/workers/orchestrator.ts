import { createHash } from "node:crypto";
import { ToolRegistry, type ToolDefinition } from "../tools/registry.ts";
import type { BudgetEnforcer } from "../runtime/usage.ts";
import type { EventLog } from "../events/log.ts";
import { ROLES, parseWorkerReport, formatReportForManager, emptyReport, evaluateObjection, type WorkerRole, type WorkerReport } from "./roles.ts";
import { workerExternalTools } from "../tools/external.ts";
import { mcpWorkerTools } from "../mcp/tools.ts";
import { ManagerLoop } from "../manager/loop.ts";
import type { Provider } from "../providers/types.ts";
import type { ToolExecContext } from "../tools/registry.ts";
import type { SynergonConfig } from "../config/schema.ts";
import { CancellationController } from "../runtime/cancellation.ts";
import type { FailureLearner } from "../memory/pipeline.ts";

/**
 * Orchestrator (Part 90): task decomposition happens in the Manager's model
 * turn; this component enforces the runtime side — worker budgets, scoped
 * toolsets, event bookkeeping, and reconciliation of worker output into
 * findings/objections/proposals/blockers. The Manager remains the primary
 * builder: workers are read-only (QA read-mostly) and every report is advisory
 * input, never writes.
 *
 * Collaboration (Part 91–93): worker proposals are first-class events that a
 * user correction forces into needs_rework; blockers stay visible until a
 * decision resolves them; objections go through a deterministic debate before
 * being dropped; and while parallel workers run, write tools are stripped from
 * the Manager's own registry (single-writer discipline, defense in depth).
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
  /** Per-worker cancellation (Part 62): stopping one worker must not touch
   *  the manager, other workers, or the session's shell children. */
  cancellation: CancellationController;
  /** Set when the worker finished (or was stopped) — no longer stoppable. */
  done?: boolean;
}

const VALID_ROLES = new Set(Object.keys(ROLES));

/** Write-capable tools stripped from the Manager's registry while workers run in parallel. */
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

export class Orchestrator {
  private workerSeq = 0;
  /** Task-scoped worker sessions (multi-cycle resumability, Part 11). */
  private readonly sessions = new Map<string, WorkerSession>();
  /** Monotonic id counters (proposals, blockers, objections, decisions number independently). */
  private proposalSeq = 0;
  private blockerSeq = 0;
  private objectionSeq = 0;
  private decisionSeq = 0;
  /** Objections already classified by the debate (once per task). */
  private readonly debatedObjections = new Set<string>();
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

  /** Validate decision tool call arguments. */
  parseDecision(args: Record<string, unknown>): { ok: true; statement: string; reason?: string } | { ok: false; error: string } {
    const statement = typeof args["statement"] === "string" ? args["statement"].trim() : "";
    const reason = typeof args["reason"] === "string" ? args["reason"].trim() : undefined;
    if (!statement) return { ok: false, error: "statement is required — state the resolved decision (e.g. how a blocker was cleared or an objection was settled)" };
    return { ok: true, statement, reason: reason || undefined };
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
   * Decision tool (Part 93): resolves a blocker, upholds or overrides an
   * objection debate, or adopts a proposal. Recorded as a first-class
   * `decision` event; open blockers referenced by id are marked resolved.
   */
  decisionTool(): ToolDefinition {
    return {
      name: "decision",
      description:
        "Record a resolved decision: a blocker you cleared, an objection debate you settled, or a worker proposal you adopted/rejected. State the resolution and why. Open blockers referenced by id (e.g. 'resolves b-3') are marked resolved automatically.",
      permission: "read",
      mutative: false,
      risk: "low",
      parameters: {
        type: "object",
        properties: {
          statement: { type: "string", description: "The resolved decision (what was decided and, if applicable, which blocker id it resolves)" },
          reason: { type: "string", description: "Why — evidence, tradeoff, or the objection debate outcome" },
        },
        required: ["statement"],
        additionalProperties: false,
      },
      execute: async (args, _ctx) => {
        void _ctx;
        const parsed = this.parseDecision(args);
        if (!parsed.ok) return { ok: false, output: `decision: ${parsed.error}`, errorCategory: "bad_args" };
        const blockersResolved = this.recordDecision(parsed.statement, parsed.reason);
        return {
          ok: true,
          output: blockersResolved > 0 ? `decision recorded; ${blockersResolved} blocker(s) marked resolved` : "decision recorded",
        };
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
      lastReport: emptyReport(),
      cancellation: new CancellationController(),
    };
    // One-way propagation: a SESSION-level interrupt (Ctrl+C, /cancel) also
    // stops this worker's stream and children; a worker-level /stop does not
    // touch the session or sibling workers.
    const propagateSessionCancel = (): void => session.cancellation.cancel("session cancelled");
    this.deps.cancellation.signal.addEventListener("abort", propagateSessionCancel, { once: true });
    this.sessions.set(workerId, session);

    // Parallel-write discipline (Part 91, defense in depth): while at least
    // one worker is running, the Manager's registry loses write tools. Role
    // allowlists remain authoritative for workers themselves.
    const releaseWriteStrip = this.maybeStripWriteTools();

    try {
      const result = await this.runCycle(session, req.context);
      return result;
    } catch (err) {
      this.deps.events.append("worker_completed", { id: workerId, ok: false });
      this.sessions.delete(workerId);
      return this.failed(`worker ${workerId} (${req.role}) failed: ${(err as Error).message}`);
    } finally {
      releaseWriteStrip();
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

  /**
   * Selective stop (Part 62): cancel ONE worker's current cycle — its model
   * stream and any shell children it spawned — without touching the manager,
   * other workers, or session-scoped resources. Waiting workers are stopped
   * by dropping their session (they hold no running resources). The worker
   * is recorded as stopped in the log.
   */
  stopWorker(workerId: string): { ok: boolean; message: string } {
    const session = this.sessions.get(workerId);
    if (!session) {
      return { ok: false, message: `stop_workers: no such worker '${workerId}'. Active/waiting: ${this.activeWorkerIds().join(", ") || "none"}.` };
    }
    if (session.done) {
      return { ok: false, message: `stop_workers: worker '${workerId}' has already finished.` };
    }
    session.cancellation.cancel(`worker ${workerId} stopped by user`);
    this.deps.events.append("worker_completed", { id: workerId, ok: false, stopped: true });
    session.done = true;
    this.sessions.delete(workerId);
    return { ok: true, message: `worker ${workerId} (${session.role}) stopped${session.waitingFor ? "; it was waiting and will not resume." : "."}` };
  }

  /** Stop every live worker (Part 62: stop workers); returns stopped ids. */
  stopAllWorkers(): string[] {
    const ids = this.activeWorkerIds();
    for (const id of ids) this.stopWorker(id);
    return ids;
  }

  /** IDs of workers that are waiting or mid-cycle (still resumable/stoppable). */
  activeWorkerIds(): string[] {
    return [...this.sessions.entries()].filter(([, s]) => !s.done).map(([id]) => id);
  }

  /**
   * Correction propagation (Part 92): a user correction invalidates the
   * reasoning built on pre-correction state. Active worker proposals become
   * needs_rework, open blockers stay open, and every waiting worker is
   * resumed with the correction so it can re-evaluate its report against the
   * new state. Returns the resumed worker ids (empty when none were waiting).
   */
  async propagateCorrection(correction: string): Promise<string[]> {
    // Objection debate (Part 93): every worker objection raised before the
    // correction is classified against it exactly once. Objections that
    // survive get guidance the Manager must follow (decision tool or user
    // escalation) — it cannot silently proceed past a risk objection.
    const prior = this.deps.events.readAll();
    for (const ev of prior) {
      if (ev.kind !== "objection") continue;
      const id = String(ev.data["id"] ?? "");
      const statement = String(ev.data["statement"] ?? "");
      const dedupeKey = id || statement;
      if (!statement || this.debatedObjections.has(dedupeKey)) continue;
      this.debatedObjections.add(dedupeKey);
      const debate = this.debateObjection(statement, correction, id || undefined);
      this.deps.events.append("task_updated", { notice: debate.guidance.slice(0, 400) });
    }
    const waiting = [...this.sessions.entries()].filter(([, s]) => s.waitingFor);
    const resumed: string[] = [];
    for (const [id, session] of waiting) {
      this.deps.events.append("worker_started", { id, role: session.role, resumed: true, cycle: session.cycles + 1, reason: "user_correction" });
      try {
        await this.runCycle(session, `USER CORRECTION — the user corrected course: ${correction}\nRe-evaluate your prior report against this correction. State what changes, what still holds, and end with WAITING: <need> if you now need something else.`);
        resumed.push(id);
      } catch {
        // A worker that fails during propagation is simply no longer waiting;
        // the correction itself has already been recorded at the task level.
        this.deps.events.append("worker_completed", { id, ok: false });
        this.sessions.delete(id);
      }
    }
    return resumed;
  }

  /**
   * Objection debate (Part 93): classify a worker objection against the
   * latest user instruction/correction. The verdict is recorded as a
   * first-class `objection_debated` event; a needs_decision verdict BLOCKS
   * completion (via the gate) until a decision resolves the objection.
   */
  debateObjection(objection: string, latestUserText: string, objectionId?: string): { verdict: "upheld" | "dismissed" | "needs_decision"; guidance: string } {
    const debate = evaluateObjection(objection, latestUserText);
    this.deps.events.append("objection_debated", {
      id: objectionId,
      statement: objection.slice(0, 240),
      debate: { verdict: debate.verdict, rationale: debate.rationale },
    });
    const prefix = `OBJECTION DEBATE (${debate.verdict})${objectionId ? ` ${objectionId}` : ""}: ${debate.rationale}`;
    if (debate.verdict === "needs_decision") {
      return {
        verdict: debate.verdict,
        guidance: `${prefix}. Record a decision via the decision tool that references this objection${objectionId ? ` (e.g. "resolves ${objectionId}: <why it is safe to proceed>")` : ""}, or surface it to the user. Open objections awaiting a decision keep the gate at BLOCKED.`,
      };
    }
    if (debate.verdict === "upheld") {
      return { verdict: debate.verdict, guidance: `${prefix}. The objection stands — incorporate it before continuing.` };
    }
    return { verdict: debate.verdict, guidance: `${prefix}.` };
  }

  /**
   * Record a decision event; resolves any open blocker whose id appears in
   * the statement (Part 93: decisions are the only thing that clears a
   * blocker). Returns how many blockers were resolved.
   */
  recordDecision(statement: string, reason?: string): number {
    const id = `d-${++this.decisionSeq}`;
    this.deps.events.append("decision", { id, statement: statement.slice(0, 400), reason: reason?.slice(0, 400) });
    const text = statement.toLowerCase();
    const events = this.deps.events.readAll();
    let resolved = 0;

    // Blockers: resolve open ones whose id the decision names ('b-1' must not
    // match 'b-10' — word-boundary match). Users and models rarely know the
    // runtime id, so when no id matched, fall back to a conservative
    // paraphrase match: the single blocker whose significant tokens the
    // statement covers best (≥ half, strictly best) wins. Ties and thin
    // coverage resolve nothing — a wrong auto-resolution is worse than an
    // unresolved blocker, which stays visible at the gate.
    const blockerIds = new Set(events.filter((e) => e.kind === "blocker").map((e) => String(e.data["id"] ?? "")));
    const resolvedBlockers = new Set(events.filter((e) => e.kind === "blocker_resolved").map((e) => String(e.data["id"] ?? "")));
    let resolvedAnyById = false;
    const openReasons = new Map<string, string>();
    for (const blockerId of blockerIds) {
      if (!blockerId || resolvedBlockers.has(blockerId)) continue;
      if (new RegExp(`\\b${blockerId}\\b`).test(text)) {
        this.deps.events.append("blocker_resolved", { id: blockerId, by: id });
        resolved += 1;
        resolvedAnyById = true;
      } else {
        const reason = String(events.find((e) => e.kind === "blocker" && String(e.data["id"] ?? "") === blockerId)?.data["reason"] ?? "");
        if (reason) openReasons.set(blockerId, reason);
      }
    }
    if (!resolvedAnyById && openReasons.size > 0) {
      // Humans paraphrase: "resolves the courier sandbox credentials blocker".
      // Conservative matching: thin or ambiguous paraphrases resolve nothing —
      // a wrong auto-resolution is worse than an unresolved blocker, which
      // stays visible at the gate.
      const best = bestParaphraseMatch(text, openReasons);
      if (best) {
        this.deps.events.append("blocker_resolved", { id: best, by: id });
        resolved += 1;
      }
    }

    // Objections: same id convention ('resolves obj-2'), plus statement-level
    // resolution for objections that carry a decision's substance even without
    // naming the id (legacy no-id objections). Resolving an objection is what
    // un-BLOCKS the gate after a needs_decision debate.
    const openObjections = events.filter((e) => e.kind === "objection");
    const resolvedObjections = new Set(events.filter((e) => e.kind === "objection_resolved").map((e) => String(e.data["id"] ?? "")));
    for (const ev of openObjections) {
      const objId = String(ev.data["id"] ?? "");
      if (objId && resolvedObjections.has(objId)) continue;
      if (objId) {
        if (!new RegExp(`\\b${objId}\\b`).test(text)) continue;
      } else {
        const objStatement = String(ev.data["statement"] ?? "").toLowerCase();
        if (!objStatement || !text.includes(objStatement)) continue;
      }
      this.deps.events.append("objection_resolved", { id: objId, statement: String(ev.data["statement"] ?? "").slice(0, 240), by: id });
      resolved += 1;
    }
    return resolved;
  }

  /**
   * While workers are running, remove write tools from the Manager's registry
   * (single-writer rule enforced at the registry layer). Returns a release
   * function restoring them; the strip is refcounted for parallel delegates.
   */
  private maybeStripWriteTools(): () => void {
    // Refcounted: N concurrent delegates each strip once; the registry is
    // restored only when the LAST one releases. New registrations while
    // stripped are re-deferred so nothing re-appears mid-window.
    const registry = this.deps.registry;
    const key = "__writeTools";
    const entry = ((registry as unknown as Record<string, unknown>)[key] ?? { count: 0, tools: [] as ToolDefinition[] }) as { count: number; tools: ToolDefinition[] };
    if (entry.count === 0) {
      for (const name of WRITE_TOOLS) {
        const tool = registry.get(name);
        if (tool) {
          entry.tools.push(tool);
          registry.remove(name);
        }
      }
      if (entry.tools.length > 0) {
        this.deps.events.append("task_updated", { notice: `parallel_write_discipline: write tools stripped while workers run (${entry.tools.map((t) => t.name).join(", ")})` });
      }
    }
    entry.count += 1;
    (registry as unknown as Record<string, unknown>)[key] = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.count -= 1;
      if (entry.count === 0) {
        // remove-then-register: a mid-window re-registration must not make
        // the restore throw (duplicate tool) or shadow the original.
        for (const tool of entry.tools) {
          registry.remove(tool.name);
          registry.register(tool);
        }
        (registry as unknown as Record<string, unknown>)[key] = undefined;
      }
    };
  }

  /** One investigation cycle: scoped loop run → report parse → reconcile. */
  private async runCycle(session: WorkerSession, extraContext?: string, isRetry = false): Promise<DelegationResult> {
    if (session.done) {
      return this.failed(`worker ${session.id} was stopped; no further cycles.`);
    }
    const scoped = this.scopedRegistry(ROLES[session.role].allowedTools, session.role);
    const cycle = session.cycles + 1;
    const roleSpec = ROLES[session.role];
    const loop = new ManagerLoop({
      provider: this.deps.provider,
      // Worker model override (spec Phase 9): a cheaper declared model keeps
      // elastic staffing affordable; investigation rarely needs the flagship.
      model: this.deps.config.model.workerModel || this.deps.model,
      config: this.deps.config,
      registry: scoped,
      events: this.deps.events,
      budget: this.deps.budget, // shared pools: workers and manager draw the same budget (Part 22)
      cancellation: session.cancellation, // per-worker scope: /stop kills this worker only
      ctx: { ...this.deps.ctx, signal: session.cancellation.signal, cancellation: session.cancellation },
      learner: this.deps.learner,
      workerPromptOverride: {
        text:
          `You are ${session.role}, a task-scoped specialist worker. ${roleSpec.mission}\n\n` +
          `OUTPUT CONTRACT — use EXACTLY these section headers, each on its own line:\n${roleSpec.outputContract}\n` +
          `Use PROPOSAL: for a concrete plan or change you recommend the Manager adopt, and BLOCKER: for something you cannot resolve that must stay visible until a decision clears it.\n` +
          `If you cannot complete your mission because you are waiting on something (e.g. an edit not yet applied, missing test run), end your reply with a line 'WAITING: <what you need>' instead of speculating.\n\n` +
          `You are read-only in this workspace${session.role === "qa" ? " (you may run tests/builds but must not modify source)" : ""}. The Manager integrates your report; do not edit production files.\n\n` +
          `QUESTION FROM MANAGER: ${session.question}${session.context ? `\n\nCONTEXT: ${session.context}` : ""}${extraContext ? `\n\nUPDATE FROM MANAGER: ${extraContext}` : ""}\n\n` +
          (cycle > 1 ? `This is investigation cycle ${cycle}; you already reported ${session.cycles} time(s). Build on your prior findings.` : "Produce your report now."),
        isWorker: true,
      },
    });
    const retryNote = isRetry ? "\n\nFORMAT REMINDER: your previous reply did not use the required section headers. Rewrite it using the exact headers from the output contract." : "";
    const result = await loop.run(
      (cycle === 1 ? `Answer the Manager's question: ${session.question}` : `Continue your investigation: ${extraContext ?? ""}`) + retryNote,
    );
    if (session.done || result.status === "cancelled") {
      // Stopped mid-cycle: worker_completed(stopped) is already recorded by
      // stopWorker; never re-record, never parse a partial reply.
      this.sessions.delete(session.id);
      return this.failed(`worker ${session.id} (${session.role}) stopped by user.`);
    }
    session.cycles = cycle;
    let report = parseWorkerReport(result.assistantText);

    // Contract enforcement: if the final message carried no structured
    // sections at all, spend ONE retry asking for the exact headers (the
    // content is usually good — only the shape is missing).
    const structured = report.findings.length > 0 || report.risks.length > 0 || report.recommendations.length > 0 || report.objections.length > 0 || report.verdict !== undefined || report.tested!.length > 0 || report.proposals.length > 0 || report.blockers.length > 0;
    if (!structured && !isRetry && !result.assistantText.includes("WAITING:") && !session.done) {
      this.deps.events.append("failure", { source: "worker_contract", message: `${session.role} reply lacked required section headers; retrying once with format reminder` });
      return this.runCycle(session, extraContext, true);
    }
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
    const stopped = session.done; // stopWorker may have flipped it during a tool call that ignored abort
    this.deps.events.append("worker_completed", { id: session.id, ok: !stopped && result.status !== "provider_error", cycle, ...(stopped ? { stopped: true } : {}) });
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

  /** Record findings/objections/proposals/blockers as first-class events
   *  (Parts 12–13, 91) and persist them to memory so future sessions retrieve
   *  them without re-reading raw event logs. */
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
      const id = `obj-${++this.objectionSeq}`;
      const statement = o.statement.slice(0, 240);
      this.deps.events.append("objection", { id, raised_by: `${role}:${workerId}`, statement });
      this.deps.learner?.store.add({
        type: "objection",
        key: statement.slice(0, 100),
        statement,
        source: `${role}:${workerId}`,
        verified: true,
      });
    }
    for (const p of report.proposals.slice(0, 3)) {
      const id = `p-${++this.proposalSeq}`;
      const statement = p.statement.slice(0, 300);
      this.deps.events.append("proposal", { id, statement, raised_by: `${role}:${workerId}`, rationale: p.rationale?.slice(0, 300) });
      this.deps.learner?.store.add({
        type: "fact",
        key: `proposal:${statement.slice(0, 80)}`,
        statement: `proposal (${role}): ${statement}`,
        source: `${role}:${workerId}`,
        verified: false,
      });
    }
    for (const b of report.blockers.slice(0, 3)) {
      const id = `b-${++this.blockerSeq}`;
      const reason = b.slice(0, 300);
      this.deps.events.append("blocker", { id, reason, raised_by: `${role}:${workerId}` });
      this.deps.learner?.store.add({
        type: "fact",
        key: `blocker:${reason.slice(0, 80)}`,
        statement: `blocker (${role}): ${reason} — resolve via a recorded decision`,
        source: `${role}:${workerId}`,
        verified: true,
      });
    }
  }

  /**
   * Build a registry view containing only the role's allowlist plus external
   * tools that explicitly declare this role in `worker_roles` (Phase 9):
   * external commands stay manager-only unless the user names the role.
   */
  private scopedRegistry(allowed: string[], role: WorkerRole): ToolRegistry {
    const view = new ToolRegistry();
    for (const name of allowed) {
      const tool = this.deps.registry.get(name);
      if (tool) view.register(tool);
    }
    for (const name of workerExternalTools(this.deps.registry, role)) {
      const tool = this.deps.registry.get(name);
      if (tool) view.register(tool);
    }
    // MCP tools (Part 55) follow the same policy: only roles the user named.
    for (const name of mcpWorkerTools(this.deps.registry, role)) {
      const tool = this.deps.registry.get(name);
      if (tool) view.register(tool);
    }
    return view;
  }

  private failed(message: string): DelegationResult {
    return { workerId: "none", role: "explorer", report: emptyReport(message), tokens: 0, toolCalls: 0, error: message };
  }

  /** /new (Part 61): rebind to the fresh task's event log (sessions are task-scoped and empty across tasks). */
  attachEvents(events: EventLog): void {
    (this.deps as { events: EventLog }).events = events;
    this.sessions.clear();
    this.proposalSeq = 0;
    this.blockerSeq = 0;
    this.objectionSeq = 0;
    this.decisionSeq = 0;
  }
}

const STOP_TOKENS = new Set([
  "that", "this", "with", "from", "have", "has", "been", "being", "into", "cannot",
  "them", "they", "were", "will", "would", "could", "should", "then", "than",
  "when", "what", "where", "which", "while", "about", "after", "also", "only",
  "some", "such", "there", "their", "these", "those", "your", "must", "more", "very",
]);

/** Crude deterministic suffix stem — enough to align simulate/simulating, measured/measuring… */
function stemToken(w: string): string {
  return w.replace(/(ings|ing|ies|ions|ion|ments|ment|ers|er|edly|ed|ly|s)$/i, "");
}

/** Lowercase stemmed significant tokens (≥4 chars, glue words removed). */
function significantTokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_TOKENS.has(w))
    .map(stemToken)
    .filter((w) => w.length >= 4);
  return new Set(words);
}

/** How many of `needles` appear in `haystack`. */
function tokenCoverage(haystack: Set<string>, needles: Set<string>): { hits: number; total: number } {
  let hits = 0;
  for (const n of needles) if (haystack.has(n)) hits += 1;
  return { hits, total: needles.size };
}

/**
 * Match a decision statement to the single open blocker it paraphrases.
 * Primary: lift "<desc> blocker(s)" phrases out of the statement (how humans
 * actually refer to a blocker) and require ≥2/3 of the desc's significant
 * tokens in the blocker's reason. Fallback: whole-statement token coverage
 * with ≥half coverage and ≥3 hits. Strictly-best-only; ties resolve nothing.
 */
function bestParaphraseMatch(statementText: string, openReasons: Map<string, string>): string | undefined {
  const reasonTokens = new Map<string, Set<string>>();
  for (const [id, reason] of openReasons) reasonTokens.set(id, significantTokens(reason));

  const descPhrases = [...statementText.matchAll(/\b(?:the|this|that)\s+([\w-][\w\s-]{1,80}?)\s+blockers?\b/gi)]
    .map((m) => m[1] ?? "")
    .filter((d) => significantTokens(d).size >= 2);
  if (descPhrases.length > 0) {
    let bestId: string | undefined;
    let bestScore = 0;
    let tie = false;
    for (const desc of descPhrases) {
      const descTokens = significantTokens(desc);
      for (const [id, tokens] of reasonTokens) {
        const { hits, total } = tokenCoverage(tokens, descTokens);
        const score = total > 0 ? hits / total : 0;
        if (score > bestScore) {
          bestScore = score;
          bestId = id;
          tie = false;
        } else if (bestScore > 0 && score === bestScore) {
          tie = true;
        }
      }
    }
    if (bestId && bestScore >= 2 / 3 && !tie) return bestId;
  }

  const statementTokens = significantTokens(statementText);
  let fallbackId: string | undefined;
  let fallbackScore = 0;
  let fallbackTie = false;
  for (const [id, tokens] of reasonTokens) {
    const { hits, total } = tokenCoverage(statementTokens, tokens);
    const score = total > 0 ? hits / total : 0;
    if (score > fallbackScore) {
      fallbackScore = score;
      fallbackId = id;
      fallbackTie = false;
    } else if (fallbackScore > 0 && score === fallbackScore) {
      fallbackTie = true;
    }
  }
  if (fallbackId && fallbackScore >= 0.5 && !fallbackTie) {
    const { hits } = tokenCoverage(statementTokens, reasonTokens.get(fallbackId)!);
    if (hits >= 3) return fallbackId;
  }
  return undefined;
}
