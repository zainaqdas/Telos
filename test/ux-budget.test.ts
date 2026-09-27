import assert from "node:assert/strict";
import { test } from "node:test";
import { buildThinkingBox, ThinkingWindow, Spinner } from "../src/session/thinking-window.ts";
import { BudgetEnforcer, billableTokens } from "../src/runtime/usage.ts";
import type { Usage } from "../src/providers/types.ts";

/** v0.1.8: contained thinking window + budget realism. */

const usage = (p: Partial<Usage>): Usage => ({
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, modelCalls: 0, toolCalls: 0, costUsd: null, ...p,
});

// ─── Thinking window ─────────────────────────────────────────────────────────

test("thinking box: fixed height regardless of content size", () => {
  const short = buildThinkingBox("one line", 60, 6);
  assert.equal(short.length, 6);
  const huge = buildThinkingBox(Array.from({ length: 200 }, (_, i) => `line ${i} of very long thinking`).join("\n"), 60, 6);
  assert.equal(huge.length, 6, "box must never grow past its height");
});

test("thinking box: keeps the LATEST content when it overflows", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `think-${i}`);
  const box = buildThinkingBox(lines.join("\n"), 60, 6);
  const body = box.slice(1, -1).join("\n"); // strip borders
  assert.ok(body.includes("think-49"), "newest line visible");
  assert.ok(body.includes("think-46"), "recent lines visible (4 content rows)");
  assert.ok(!body.includes("think-45"), "older-than-window scrolled out");
  assert.ok(!body.includes("think-0"), "oldest scrolled out of the box");
});

test("thinking box: long lines wrap to the width, borders intact", () => {
  const box = buildThinkingBox("x".repeat(500), 40, 5);
  assert.equal(box.length, 5);
  for (const line of box) {
    const visible = [...line.replace(/\x1b\[[0-9;]*m/g, "")].length; // strip ANSI
    assert.ok(visible === 40, `row must be exactly 40 visible cols, got ${visible}`);
  }
});

test("thinking window (TTY): redraws in place — same rows, no screen scroll", () => {
  const chunks: string[] = [];
  const win = new ThinkingWindow({ write: (s) => chunks.push(s), width: 60, height: 5 });
  for (let i = 0; i < 30; i += 1) win.push(`thinking line number ${i}\n`);
  const all = chunks.join("");
  // Repaints move the cursor UP over the box instead of scrolling.
  assert.match(all, /\x1b\[\d+A/, "repaint moves cursor up over the box");
  assert.ok(all.includes("thinking line number 29"), "latest content shown");
  // The FINAL frame holds only the window's rows: early lines are gone.
  const lastFrame = chunks[chunks.length - 1]!;
  assert.ok(lastFrame.includes("thinking line number 29"));
  assert.ok(!lastFrame.includes("thinking line number 0"), "early lines not in the final frame");
  assert.ok(lastFrame.split("\n").length <= 5, "frame never exceeds box height");
  win.end();
  assert.ok(chunks.join("").includes("\x1b[K"), "end erases the box");
});

test("thinking window (pipe): old dimmed passthrough, no box", () => {
  const chunks: string[] = [];
  const win = new ThinkingWindow({ write: (s) => chunks.push(s), width: Number.POSITIVE_INFINITY });
  win.push("reasoning delta");
  const all = chunks.join("");
  assert.ok(all.includes("reasoning delta"));
  assert.ok(all.includes("\x1b[2m"), "dimmed");
  assert.ok(!all.includes("╭"), "no box on a pipe");
});

// ─── Spinner ─────────────────────────────────────────────────────────────────

test("spinner: renders frames with elapsed seconds and stops clean", async () => {
  const chunks: string[] = [];
  const spinner = new Spinner({ write: (s) => chunks.push(s), intervalMs: 10 });
  spinner.start("thinking");
  assert.ok(spinner.running);
  await new Promise((r) => setTimeout(r, 80));
  spinner.stop();
  assert.ok(!spinner.running);
  const all = chunks.join("");
  assert.match(all, /thinking… 0\.\ds/);
  assert.ok(all.includes("\x1b[K"), "stop clears the line");
});

test("spinner: stop is a safe no-op when never started", () => {
  const chunks: string[] = [];
  const spinner = new Spinner({ write: (s) => chunks.push(s) });
  spinner.stop();
  assert.ok(!spinner.running);
  assert.equal(chunks.join(""), "");
});

// ─── Budget realism ──────────────────────────────────────────────────────────

test("billableTokens excludes cache reads from the ceiling count", () => {
  assert.equal(billableTokens(usage({ totalTokens: 100_000, cachedTokens: 95_000 })), 5_000);
  assert.equal(billableTokens(usage({ totalTokens: 1_000, cachedTokens: 0 })), 1_000);
  assert.equal(billableTokens(usage({ totalTokens: 50, cachedTokens: 100 })), 0); // never negative
});

test("default budget: unlimited billable tokens (0) — long tasks survive", () => {
  const b = new BudgetEnforcer({ maxTotalTokens: 0, maxToolCalls: 100, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 3600 });
  // Half a million billable tokens of real work: no token violation.
  for (let i = 0; i < 50; i += 1) {
    assert.ok(b.check("model_call").allowed);
    b.recordUsage(usage({ totalTokens: 20_000, cachedTokens: 19_000, modelCalls: 1 }));
  }
  assert.equal(b.used.tokens, 50_000); // 50 × 1k billable
  assert.ok(b.firstViolation().allowed, "unlimited budget never violates on tokens");
});

test("declared cap still hard-stops on BILLABLE tokens (cache reads exempt)", () => {
  const b = new BudgetEnforcer({ maxTotalTokens: 10_000, maxToolCalls: 100, maxWorkerSpawns: 0, maxParallelWorkers: 0, maxWallTimeSeconds: 3600 });
  // 9k billed + 90k cached: legacy behavior would have blown the cap 10× over.
  b.recordUsage(usage({ totalTokens: 99_000, cachedTokens: 90_000, modelCalls: 1 }));
  assert.equal(b.used.tokens, 9_000);
  assert.ok(b.check("model_call").allowed, "cache reads must not consume the cap");
  b.recordUsage(usage({ totalTokens: 5_000, cachedTokens: 0, modelCalls: 1 }));
  assert.equal(b.used.tokens, 14_000);
  const verdict = b.check("model_call");
  assert.equal(verdict.allowed, false);
  assert.match(verdict.message ?? "", /token budget 14000\/10000/);
});
