import type { Usage } from "../providers/types.ts";

/**
 * Hard budget enforcement (Parts 22–23). The runtime calls canSpend() before
 * each model call, tool call, or spawn — the model can never override this.
 * `null` cost means "unknown", not "free" (Part 24).
 */
export interface BudgetLimits {
  maxTotalTokens: number;
  maxToolCalls: number;
  maxWorkerSpawns: number;
  maxParallelWorkers: number;
  maxWallTimeSeconds: number;
}

export interface UsageState {
  tokens: number;
  /** Input/output granularity for cost estimation (Part 24). */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolCalls: number;
  modelCalls: number;
  workersSpawned: number;
  runningWorkers: number;
  startedAt: number;
}

export type SpendKind = "model_call" | "tool_call" | "worker_spawn";

export interface BudgetVerdict {
  allowed: boolean;
  resource?: "tokens" | "tool_calls" | "worker_spawns" | "parallel_workers" | "wall_time";
  message?: string;
}

export class BudgetEnforcer {
  private state: UsageState;
  private readonly limits: BudgetLimits;
  private readonly nowFn: () => number;
  /** Running cost estimate in USD; null until the user declares pricing (Part 24). */
  private costAccumulated: number | null = null;

  constructor(limits: BudgetLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.nowFn = now;
    this.state = { tokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, toolCalls: 0, modelCalls: 0, workersSpawned: 0, runningWorkers: 0, startedAt: now() };
  }

  get used(): UsageState {
    return { ...this.state };
  }

  get limitsValue(): BudgetLimits {
    return { ...this.limits };
  }

  /** Check whether a spend would be within budget, without recording it. */
  check(kind: SpendKind, estimatedTokens = 0, now?: () => number): BudgetVerdict {
    const clock = now ?? this.nowFn;
    if (this.state.tokens + estimatedTokens > this.limits.maxTotalTokens) {
      return { allowed: false, resource: "tokens", message: `token budget ${this.state.tokens + estimatedTokens}/${this.limits.maxTotalTokens}` };
    }
    switch (kind) {
      case "model_call":
        break; // tokens are the binding constraint for model calls
      case "tool_call":
        if (this.state.toolCalls + 1 > this.limits.maxToolCalls) {
          return { allowed: false, resource: "tool_calls", message: `tool calls ${this.state.toolCalls + 1}/${this.limits.maxToolCalls}` };
        }
        break;
      case "worker_spawn":
        if (this.state.workersSpawned + 1 > this.limits.maxWorkerSpawns) {
          return { allowed: false, resource: "worker_spawns", message: `worker spawns ${this.state.workersSpawned + 1}/${this.limits.maxWorkerSpawns}` };
        }
        if (this.state.runningWorkers + 1 > this.limits.maxParallelWorkers) {
          return { allowed: false, resource: "parallel_workers", message: `parallel workers ${this.state.runningWorkers + 1}/${this.limits.maxParallelWorkers}` };
        }
        break;
    }
    const elapsedSeconds = (clock() - this.state.startedAt) / 1000;
    if (elapsedSeconds > this.limits.maxWallTimeSeconds) {
      return { allowed: false, resource: "wall_time", message: `wall time ${Math.round(elapsedSeconds)}s/${this.limits.maxWallTimeSeconds}s` };
    }
    return { allowed: true };
  }

  record(kind: SpendKind, estimatedTokens = 0): void {
    if (kind === "worker_spawn") {
      this.state.workersSpawned += 1;
      this.state.runningWorkers += 1;
    }
    if (kind === "tool_call") this.state.toolCalls += 1;
    if (kind === "model_call") this.state.modelCalls += 1;
    if (estimatedTokens > 0) this.state.tokens += estimatedTokens;
  }

  recordUsage(usage: Usage): void {
    this.state.tokens += usage.totalTokens;
    this.state.inputTokens += usage.inputTokens;
    this.state.outputTokens += usage.outputTokens;
    this.state.cachedTokens += usage.cachedTokens;
    this.state.modelCalls += usage.modelCalls;
    if (usage.costUsd !== null) {
      // Provider-reported cost is authoritative when it exists.
      this.costAccumulated = (this.costAccumulated ?? 0) + usage.costUsd;
    }
  }

  private pricing?: { inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok?: number };

  /** Declare per-model pricing (USD per million tokens); enables cost estimates. */
  setPricing(pricing: { inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok?: number }): void {
    this.pricing = pricing;
  }

  /**
   * Cost so far in USD. Provider-reported figures are authoritative; without
   * them, the user-declared per-Mtok pricing yields an estimate from actual
   * token counts. null means unknown — never a fabricated number (Part 24).
   */
  get costEstimateUsd(): number | null {
    if (!this.pricing) return this.costAccumulated;
    const { inputPerMtok, outputPerMtok, cacheReadPerMtok } = this.pricing;
    // Cached tokens bill at the (cheaper) cache-read rate when declared.
    const billedInput = this.state.inputTokens - this.state.cachedTokens;
    const estimate =
      (Math.max(0, billedInput) / 1_000_000) * inputPerMtok +
      (this.state.outputTokens / 1_000_000) * outputPerMtok +
      (cacheReadPerMtok !== undefined ? (this.state.cachedTokens / 1_000_000) * cacheReadPerMtok : 0);
    return this.costAccumulated === null ? estimate : this.costAccumulated + estimate;
  }

  workerFinished(): void {
    this.state.runningWorkers = Math.max(0, this.state.runningWorkers - 1);
  }

  // ─── Per-worker sub-budgets (Scale Batch 5, item 19) ────────────────────
  //
  // A 12-worker build must not starve the manager: each delegation carries
  // its own tool-call/token sub-budget on top of the SHARED pools. The
  // shared budget stays authoritative (a sub-budget can never authorize a
  // spend the shared one refuses); sub-budgets just bound one worker's
  // share of it.

  /** Live sub-budget for a running worker id; absent ⇒ unlimited share. */
  private readonly workerBudgets = new Map<string, { maxToolCalls: number; maxTokens: number; usedToolCalls: number; usedTokens: number }>();

  /** Attach a sub-budget to a worker before its first cycle. */
  setWorkerBudget(workerId: string, limits: { maxToolCalls: number; maxTokens: number }): void {
    this.workerBudgets.set(workerId, { ...limits, usedToolCalls: 0, usedTokens: 0 });
  }

  /** Drop a worker's sub-budget (completed/stopped/waiting). */
  clearWorkerBudget(workerId: string): void {
    this.workerBudgets.delete(workerId);
  }

  /**
   * Check + record one tool call against worker `workerId`'s sub-budget.
   * Returns the shared verdict when no sub-budget is attached.
   */
  checkWorkerToolCall(workerId: string): BudgetVerdict {
    const wb = this.workerBudgets.get(workerId);
    if (!wb) return { allowed: true };
    if (wb.usedToolCalls + 1 > wb.maxToolCalls) {
      return { allowed: false, resource: "tool_calls", message: `worker tool-call sub-budget ${wb.usedToolCalls + 1}/${wb.maxToolCalls} exhausted` };
    }
    wb.usedToolCalls += 1;
    return { allowed: true };
  }

  /** Accumulate reported usage onto a worker's sub-budget (bounded). */
  recordWorkerUsage(workerId: string, totalTokens: number): void {
    const wb = this.workerBudgets.get(workerId);
    if (!wb) return;
    wb.usedTokens += totalTokens;
  }

  /** True when the worker has burned through its token sub-budget. */
  workerTokensExhausted(workerId: string): boolean {
    const wb = this.workerBudgets.get(workerId);
    return wb !== undefined && wb.usedTokens > wb.maxTokens;
  }

  /** /new (Part 61): usage counters start over for the fresh task. */
  resetUsage(): void {
    this.state = { tokens: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, toolCalls: 0, modelCalls: 0, workersSpawned: 0, runningWorkers: 0, startedAt: this.nowFn() };
    this.costAccumulated = null;
  }

  /** First budget violation wins; used to emit budget_exceeded once. */
  firstViolation(now = Date.now): BudgetVerdict {
    return this.check("model_call", 0, now);
  }
}
