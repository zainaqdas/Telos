import type { AgentEvent, TeamState } from "./types.ts";
import { reduce, apply } from "./state.ts";
import type { EventLog } from "./log.ts";

/**
 * Incremental derived state (Part 96: measured, then optimized).
 *
 * The benchmark (evals/bench.ts) measured the old pattern — every
 * gate.evaluate() re-reading and re-reducing the whole JSONL log — at ~5 ms
 * per call on a 2000-event session (~2 s of pure re-derivation per long task,
 * O(N²) synchronous reads). This store folds each event into the derived
 * state exactly once as it is appended: O(1) amortized reads.
 *
 * Correctness rules:
 * - The reducer is pure (Part 14), so applying new events to the cached state
 *   is transition-equivalent to a full replay. `rebuild()` re-derives from the
 *   log wholesale; tests assert equivalence between the two paths.
 * - The log is the authority. The store subscribes to appends AFTER a durable
 *   write succeeds (EventLog contract), so cache and file cannot diverge on
 *   the happy path. A failed append throws to the writer and the cache simply
 *   stays at the last good event — same as the file.
 * - Consumers must not mutate the returned state. Call sites that need their
 *   own mutable copy do a full `reduce()` explicitly.
 */
export class StateStore {
  private log: EventLog;
  private state: TeamState;
  private readonly eventsCache: AgentEvent[] = [];
  private unsubscribe: () => void;

  constructor(log: EventLog) {
    this.log = log;
    const initial = log.readAll();
    this.eventsCache.push(...initial);
    this.state = reduce(initial);
    this.unsubscribe = log.onAppend((ev) => {
      this.eventsCache.push(ev);
      apply(this.state, ev);
    });
  }

  /** Derived state reflecting every event in the log. Read-only by contract. */
  current(): TeamState {
    return this.state;
  }

  /** The event slice the state was derived from. Read-only by contract. */
  events(): readonly AgentEvent[] {
    return this.eventsCache;
  }

  /** /new (Part 61): rebind to the fresh task's log (full re-derive). */
  attach(log: EventLog): void {
    this.unsubscribe();
    this.log = log;
    this.eventsCache.length = 0;
    const initial = log.readAll();
    this.eventsCache.push(...initial);
    this.state = reduce(initial);
    this.unsubscribe = log.onAppend((ev) => {
      this.eventsCache.push(ev);
      apply(this.state, ev);
    });
  }

  /** Force a full re-derivation from the log (self-check / recovery path). */
  rebuild(): void {
    this.eventsCache.length = 0;
    const all = this.log.readAll();
    this.eventsCache.push(...all);
    this.state = reduce(all);
  }

  /** Stop listening (session shutdown). */
  dispose(): void {
    this.unsubscribe();
  }
}
