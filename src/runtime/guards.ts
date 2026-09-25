/**
 * Circuit breakers (Part 25). Execution stops on runtime-observed conditions:
 * repeated identical failures, excessive failed commands, spawn storms,
 * context explosion, network failure storms, cancellation. These are runtime
 * protections, not model suggestions.
 */

export type BreakerCondition =
  | "tool_failure_storm"
  | "identical_failure_loop"
  | "spawn_storm"
  | "context_explosion"
  | "network_failure_storm";

export interface BreakerConfig {
  /** Failures within `windowMs` before the breaker opens. */
  threshold: number;
  windowMs: number;
}

export interface BreakerDecision {
  tripped: boolean;
  condition?: BreakerCondition;
  detail?: string;
}

export class CircuitBreakers {
  private readonly hits = new Map<BreakerCondition, number[]>();
  private readonly configs: Record<BreakerCondition, BreakerConfig>;

  constructor(configs: Record<BreakerCondition, BreakerConfig>) {
    this.configs = configs;
  }

  /**
   * Record an occurrence and return whether any breaker just tripped.
   * Callers must stop the affected activity when tripped is true.
   */
  record(condition: BreakerCondition, now = Date.now()): BreakerDecision {
    const cfg = this.configs[condition];
    const list = (this.hits.get(condition) ?? []).filter((t) => now - t < cfg.windowMs);
    list.push(now);
    this.hits.set(condition, list);
    if (list.length >= cfg.threshold) {
      return { tripped: true, condition, detail: `${list.length} occurrences in ${cfg.windowMs}ms (threshold ${cfg.threshold})` };
    }
    return { tripped: false };
  }

  /** Manually reset a condition after a meaningful state change. */
  reset(condition: BreakerCondition): void {
    this.hits.delete(condition);
  }
}

export function defaultBreakers(): CircuitBreakers {
  return new CircuitBreakers({
    tool_failure_storm: { threshold: 6, windowMs: 120_000 },
    identical_failure_loop: { threshold: 3, windowMs: 600_000 },
    spawn_storm: { threshold: 5, windowMs: 60_000 },
    context_explosion: { threshold: 1, windowMs: 60_000 },
    network_failure_storm: { threshold: 4, windowMs: 120_000 },
  });
}
