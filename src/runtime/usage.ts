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

  constructor(limits: BudgetLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.nowFn = now;
    this.state = { tokens: 0, toolCalls: 0, modelCalls: 0, workersSpawned: 0, runningWorkers: 0, startedAt: now() };
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
    this.state.modelCalls += usage.modelCalls;
  }

  workerFinished(): void {
    this.state.runningWorkers = Math.max(0, this.state.runningWorkers - 1);
  }

  /** /new (Part 61): usage counters start over for the fresh task. */
  resetUsage(): void {
    this.state = { tokens: 0, toolCalls: 0, modelCalls: 0, workersSpawned: 0, runningWorkers: 0, startedAt: this.nowFn() };
  }

  /** First budget violation wins; used to emit budget_exceeded once. */
  firstViolation(now = Date.now): BudgetVerdict {
    return this.check("model_call", 0, now);
  }
}
