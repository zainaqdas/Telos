import type { Message } from "../providers/types.ts";
import type { AgentEvent } from "../events/types.ts";
import { reduce } from "../events/state.ts";

/**
 * Runtime-owned context compaction (Part 68): the ManagerLoop consults this
 * before every model turn. Deterministic, reducer-informed — the model never
 * decides what may be forgotten.
 */

/**
 * Context compaction (Part 68). When the transcript grows large, conversational
 * noise (old tool results, superseded turns) is collapsed into a deterministic
 * digest derived from the event log — the authoritative record. Protected
 * content is never compacted away:
 *
 *   system prompt · unresolved user correction · open blockers ·
 *   undecided objections · active requirements/skills · recent failures
 *
 * The summary is injected as a SYSTEM notice, not as fake model/user dialogue.
 */

/** Rough size of a message in model tokens (chars/4 heuristic, deterministic). */
function roughTokens(m: Message): number {
  const chars = m.parts.reduce((n, p) => n + (p.type === "text" ? p.text.length : p.mediaType.length + (p.data.length ?? 0)), 0) + (m.toolCalls?.reduce((n, tc) => n + tc.argumentsJson.length + tc.name.length, 0) ?? 0);
  return Math.ceil(chars / 4);
}

export function transcriptTokens(messages: Message[]): number {
  return messages.reduce((n, m) => n + roughTokens(m), 0);
}

/** Number of trailing turns kept verbatim regardless of threshold. */
const KEEP_RECENT_MESSAGES = 8;

/** Compact when the transcript exceeds this many estimated tokens. */
export const COMPACT_THRESHOLD_TOKENS = 60_000;

/**
 * Build the digest from the event log. Order follows trust: user words,
 * verification evidence, collaboration state, lessons. Clipped, factual,
 * no theater.
 */
export function buildDigest(events: AgentEvent[]): string {
  const state = reduce(events);
  const lines: string[] = [];

  lines.push("CONTEXT DIGEST — older transcript was compacted; these are the authoritative facts.");

  const corrections = state.instructions.filter((i) => i.isCorrection);
  if (corrections.length) {
    lines.push("UNRESOLVED USER CORRECTIONS (highest priority):");
    for (const c of corrections.slice(-3)) lines.push(`  - ${c.text.slice(0, 300)}`);
  }

  const openBlockers = state.blockers.filter((b) => b.status === "open");
  if (openBlockers.length) {
    lines.push("OPEN BLOCKERS:");
    for (const b of openBlockers) lines.push(`  - ${b.id}: ${b.reason.slice(0, 200)}`);
  }
  const waived = state.blockers.filter((b) => b.status === "waived");
  if (waived.length) lines.push(`WAIVED BLOCKERS: ${waived.map((b) => b.id).join(", ")}`);

  const undecided = state.objections.filter((o) => !o.resolved);
  if (undecided.length) {
    lines.push("UNDECIDED OBJECTIONS:");
    for (const o of undecided.slice(-3)) lines.push(`  - ${o.id || "(legacy)"}: ${o.statement.slice(0, 200)}`);
  }

  const activeRequirements = [...state.requirements.values()].filter((r) => r.status === "pending" || r.status === "in_progress");
  if (activeRequirements.length) {
    lines.push("ACTIVE REQUIREMENTS:");
    for (const r of activeRequirements.slice(-8)) lines.push(`  - ${r.id}: ${r.description.slice(0, 140)} [${r.status}]`);
  }

  const activeSkills = [...state.skills.values()];
  if (activeSkills.length) lines.push(`ACTIVATED SKILLS: ${activeSkills.map((s) => s.name).join(", ")}`);

  const decisions = state.decisions.filter((d) => d.status === "active").slice(-3);
  if (decisions.length) {
    lines.push("ACTIVE DECISIONS:");
    for (const d of decisions) lines.push(`  - ${d.id}: ${d.statement.slice(0, 200)}`);
  }

  const failures = events.filter((e) => e.kind === "failure").slice(-3);
  if (failures.length) {
    lines.push("RECENT FAILURES (do not repeat):");
    for (const f of failures) lines.push(`  - ${String(f.data["source"] ?? "?")}: ${String(f.data["message"] ?? "").slice(0, 180)}`);
  }

  const guardBlocks = events.filter((e) => e.kind === "tool_failed" && (e.data["category"] === "REPEATED_FAILURE" || e.data["category"] === "KNOWN_BAD_PATTERN")).slice(-2);
  if (guardBlocks.length) lines.push(`REPETITION GUARD BLOCKED ${guardBlocks.length} recent identical retries.`);

  const findings = state.findings.slice(-5);
  if (findings.length) {
    lines.push("KEY FINDINGS:");
    for (const f of findings) lines.push(`  - ${f.text.slice(0, 200)}`);
  }

  return lines.join("\n");
}

/**
 * Compact the transcript in place. Returns a report; when the transcript is
 * under threshold the messages array is untouched and compacted is false.
 */
export function compactMessages(
  messages: Message[],
  events: AgentEvent[],
  opts: { thresholdTokens?: number; force?: boolean } = {},
): { compacted: boolean; removed: number; savedTokens: number; digest?: string } {
  const threshold = opts.thresholdTokens ?? COMPACT_THRESHOLD_TOKENS;
  const total = transcriptTokens(messages);
  if ((!opts.force && total <= threshold) || messages.length <= KEEP_RECENT_MESSAGES + 1) {
    return { compacted: false, removed: 0, savedTokens: 0 };
  }

  // Keep: system prompt (index 0) + the most recent messages verbatim.
  const system = messages[0]!;
  const keepFrom = Math.max(1, messages.length - KEEP_RECENT_MESSAGES);
  const removedMessages = messages.slice(1, keepFrom);
  const recent = messages.slice(keepFrom);
  const digest = buildDigest(events);

  const removedTokens = removedMessages.reduce((n, m) => n + roughTokens(m), 0);
  messages.length = 0;
  messages.push(system);
  messages.push({ role: "system", parts: [{ type: "text", text: digest }] });
  messages.push(...recent);
  return { compacted: true, removed: removedMessages.length, savedTokens: removedTokens, digest };
}
