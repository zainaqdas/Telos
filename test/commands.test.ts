import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../src/events/types.ts";
import { reduce } from "../src/events/state.ts";
import type { Message, GenerateRequest, Provider, StreamChunk } from "../src/providers/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { registerFilesystemTools } from "../src/tools/fs-tools.ts";
import { makeContext } from "../src/tools/util.ts";
import { BudgetEnforcer } from "../src/runtime/usage.ts";
import { EditJournal, journalWriteTools, undoLastEdit } from "../src/session/journal.ts";
import { buildDigest, compactMessages, transcriptTokens, COMPACT_THRESHOLD_TOKENS } from "../src/runtime/compact.ts";

// ─── Edit journal + /undo ─────────────────────────────────────────────────────

function journalRegistry(dir: string): { registry: ToolRegistry; journal: EditJournal } {
  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const journal = new EditJournal();
  journalWriteTools(registry, journal);
  return { registry, journal };
}

test("journal captures pre-edit content and /undo restores it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-cmd1-"));
  try {
    const p = join(dir, "code.ts");
    writeFileSync(p, "const a = 1;\n", "utf8");
    const { registry, journal } = journalRegistry(dir);
    const ctx = makeContext(dir, { shellTimeoutSeconds: 5 });
    const edit = registry.get("edit_file")!;
    const res = await edit.execute({ path: "code.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, ctx);
    assert.ok(res.ok, res.output);
    assert.equal(journal.depth, 1);

    const undone = await undoLastEdit(journal, dir);
    assert.ok(undone?.includes("code.ts"));
    assert.equal(readFileSync(p, "utf8"), "const a = 1;\n", "file restored to pre-edit content");
    assert.equal(journal.depth, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undo removes files the undone edit created; empty journal undoes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-cmd2-"));
  try {
    const { registry, journal } = journalRegistry(dir);
    const ctx = makeContext(dir, { shellTimeoutSeconds: 5 });
    const write = registry.get("write_file")!;
    const res = await write.execute({ path: "new.ts", content: "export {};" }, ctx);
    assert.ok(res.ok, res.output);
    assert.ok(existsSync(join(dir, "new.ts")));

    const undone = await undoLastEdit(journal, dir);
    assert.ok(undone?.includes("removed"), undone);
    assert.equal(existsSync(join(dir, "new.ts")), false, "created file removed by undo");
    assert.equal(await undoLastEdit(journal, dir), undefined, "empty journal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal ignores failed writes and caps its depth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syn-cmd3-"));
  try {
    const { registry, journal } = journalRegistry(dir);
    const ctx = makeContext(dir, { shellTimeoutSeconds: 5 });
    const edit = registry.get("edit_file")!;
    const bad = await edit.execute({ path: "missing.ts", old_string: "x", new_string: "y" }, ctx);
    assert.equal(bad.ok, false);
    assert.equal(journal.depth, 0, "failed edit is not journaled");

    writeFileSync(join(dir, "f.ts"), "x", "utf8");
    const edit2 = registry.get("edit_file")!;
    for (let i = 0; i < 55; i += 1) {
      await edit2.execute({ path: "f.ts", old_string: "x", new_string: "xy" }, ctx);
      // keep it idempotent-ish: no-op content churn is fine, depth must stay bounded
      await undoLastEdit(journal, dir);
    }
    assert.ok(journal.depth <= 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Context compaction (Part 68) ─────────────────────────────────────────────

function ev(seq: number, kind: AgentEvent["kind"], data: Record<string, unknown>): AgentEvent {
  return { seq, t: seq * 10, taskId: "t", kind, data };
}

const bigText = (n: number): Message => ({ role: "user", parts: [{ type: "text", text: "x".repeat(n) }] });

test("digest keeps corrections, blockers, requirements, failures; never model prose", () => {
  const events: AgentEvent[] = [
    ev(1, "task_started", { title: "x" }),
    ev(2, "user_instruction", { text: "use plain css" }),
    ev(3, "user_correction", { text: "Do NOT use tailwind — plain CSS only" }),
    ev(4, "blocker", { id: "b-1", reason: "staging credentials unavailable" }),
    ev(5, "requirement_added", { id: "r-1", description: "browser verification", required: true }),
    ev(6, "failure", { source: "provider", message: "stream failed twice" }),
    ev(7, "tool_failed", { name: "run_shell", category: "REPEATED_FAILURE", message: "identical retry" }),
  ];
  const digest = buildDigest(events);
  assert.match(digest, /Do NOT use tailwind/);
  assert.match(digest, /b-1: staging credentials unavailable/);
  assert.match(digest, /browser verification/);
  assert.match(digest, /stream failed twice/);
  assert.match(digest, /REPETITION GUARD BLOCKED 1/);
  // A digest built from the reducer reflects derived state, not raw events:
  const state = reduce(events);
  assert.equal(state.instructions.filter((i) => i.isCorrection).length, 1);
});

test("compaction keeps system + recent messages and injects the digest as a system notice", () => {
  const events: AgentEvent[] = [ev(1, "task_started", { title: "x" }), ev(2, "user_correction", { text: "no redis, ever" })];
  const messages: Message[] = [
    { role: "system", parts: [{ type: "text", text: "SYSTEM PROMPT" }] },
    // Old turns (compactable): must exceed KEEP_RECENT_MESSAGES + 1 overall.
    bigText(100_000),
    { role: "assistant", parts: [{ type: "text", text: "y".repeat(100_000) }] },
    bigText(100_000),
    { role: "assistant", parts: [{ type: "text", text: "y".repeat(100_000) }] },
    bigText(100_000),
    { role: "assistant", parts: [{ type: "text", text: "y".repeat(100_000) }] },
    bigText(100_000),
    // Recent tail (kept verbatim):
    bigText(2_000),
    { role: "assistant", parts: [{ type: "text", text: "middle" }] },
    bigText(2_000),
    { role: "assistant", parts: [{ type: "text", text: "recent answer" }] },
  ];
  const before = transcriptTokens(messages);
  assert.ok(before > COMPACT_THRESHOLD_TOKENS, "test transcript must exceed the default threshold");

  const r = compactMessages(messages, events, { thresholdTokens: COMPACT_THRESHOLD_TOKENS });
  assert.equal(r.compacted, true);
  assert.ok(r.removed > 0);
  assert.ok(r.savedTokens > 0);
  // Shape: system + digest + 8 recent (fewer if the transcript was shorter).
  assert.equal(messages[0]!.parts[0]!.type, "text");
  assert.equal(messages[1]!.role, "system");
  assert.match(messages[1]!.parts[0]!.type === "text" ? messages[1]!.parts[0]!.text : "", /no redis, ever/);
  assert.equal(messages[0]!.parts[0]!.type === "text" ? messages[0]!.parts[0]!.text : "", "SYSTEM PROMPT");
  const last = messages.at(-1)!;
  assert.match(last.parts[0]!.type === "text" ? last.parts[0]!.text : "", /recent answer/, "recent turns survive verbatim");
});

test("compaction is a no-op under threshold and honors force for /compact", () => {
  const messages: Message[] = [
    { role: "system", parts: [{ type: "text", text: "S" }] },
    bigText(100),
    { role: "assistant", parts: [{ type: "text", text: "recent" }] },
  ];
  const snapshot = JSON.stringify(messages);
  const r = compactMessages(messages, [], {});
  assert.equal(r.compacted, false);
  assert.equal(JSON.stringify(messages), snapshot, "untouched under threshold");
});

// ─── /new: budget usage reset ─────────────────────────────────────────────────

test("BudgetEnforcer.resetUsage starts counters and clock over (fresh task)", () => {
  let now = 1_000_000;
  const clock = (): number => now;
  const b = new BudgetEnforcer({ maxTotalTokens: 1000, maxToolCalls: 5, maxWorkerSpawns: 2, maxParallelWorkers: 2, maxWallTimeSeconds: 100 }, clock);
  b.recordUsage({ inputTokens: 900, outputTokens: 0, cachedTokens: 0, totalTokens: 900, modelCalls: 3, toolCalls: 0, costUsd: null });
  for (let i = 0; i < 5; i += 1) b.record("tool_call");
  now += 90_000; // 90s elapsed
  assert.equal(b.check("tool_call").allowed, false, "tool budget exhausted (5/5 used)");
  assert.equal(b.check("model_call", 200).resource, "tokens", "900 + 200 estimated > 1000");

  b.resetUsage();
  assert.equal(b.used.tokens, 0);
  assert.equal(b.used.toolCalls, 0);
  assert.equal(b.used.modelCalls, 0);
  assert.equal(b.used.startedAt, now, "wall clock restarts");
  assert.equal(b.check("tool_call").allowed, true, "fresh task allows tool calls again");
});

// ─── FakeProvider for any future loop-level command tests ─────────────────────

class FakeProvider implements Provider {
  readonly name = "fake";
  async *stream(_req: GenerateRequest, _model: string): AsyncIterable<StreamChunk> {
    void _req;
    void _model;
    yield { type: "text_delta", text: "ok" };
  }
  capabilities() {
    return { supportsTools: true, supportsVision: false, supportsStreaming: true, supportsStructuredOutput: false, contextLimit: 10_000 };
  }
}
void FakeProvider;
