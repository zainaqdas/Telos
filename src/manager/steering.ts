/**
 * Mid-turn steering precedence (follow-up to Scale Batch 4 item 13).
 *
 * A line the user types WHILE the manager runs must always outrank the
 * instruction the run started with — the user is boss (Part 15), mid-flight
 * even more so. Two mechanisms, both runtime-owned:
 *
 * 1. MARKING — every injected steering line carries a deterministic marker
 *    the system prompt explains: "overrides the original instruction where
 *    they conflict". The model cannot miss which line is newer.
 * 2. PARTITION — only plain user input steers; slash commands stay in the
 *    session queue so /undo, /exit & co. keep their run-end semantics.
 *
 * The marker is plain text (no role games) and deliberately non-adversarial:
 * aligned models (observed live on deepseek-family) reject imperative
 * "OVERRIDES EVERYTHING" phrasing as a jailbreak attempt. Instead it states
 * the facts — relayed by the runtime, newest user message wins, system rules
 * still apply — so the model treats it as normal interactive input.
 */

export const STEERING_MARK = "[STEERING] Live message from the user, relayed mid-run by the Telos runtime (they typed it while you were working). This is the user's newest instruction: honor it now. Where it conflicts with the original task text, the newer user message wins. All system rules still apply.";

/** Wrap a queued user line in the precedence marker. */
export function markSteering(line: string): string {
  return `${STEERING_MARK} ${line}`;
}

/** Split queued session lines: plain input steers, slash commands defer. */
export function partitionSteering(pendingLines: string[]): { steer: string[]; deferred: string[] } {
  const steer: string[] = [];
  const deferred: string[] = [];
  for (const line of pendingLines) {
    if (line.startsWith("/")) deferred.push(line);
    else steer.push(line);
  }
  return { steer, deferred };
}
