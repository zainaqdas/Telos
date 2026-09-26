import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamPrinter, streamWidth } from "../src/session/stream-printer.ts";

test("TTY mode passes deltas through untouched", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: Number.POSITIVE_INFINITY, write: (s) => chunks.push(s) });
  p.push("Hello ");
  p.push("world.\n");
  p.end();
  assert.equal(chunks.join(""), "Hello world.\n");
});

test("non-TTY wraps at word boundaries within the width", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: 20, write: (s) => chunks.push(s) });
  p.push("The root cause is a boundary bug in the tier check");
  p.end();
  const text = chunks.join("");
  const lines = text.split("\n");
  for (const l of lines) assert.ok(l.length <= 20, `line too long (${l.length}): ${l}`);
  assert.equal(text.replace(/\n/g, " ").replace(/ {2}/g, " "), "The root cause is a boundary bug in the tier check");
});

test("words longer than the width are hard-broken", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: 10, write: (s) => chunks.push(s) });
  p.push("aaabbbbcccddd");
  p.end();
  const lines = chunks.join("").split("\n");
  assert.ok(lines.every((l) => l.length <= 10), JSON.stringify(lines));
  assert.equal(chunks.join("").replace(/\n/g, ""), "aaabbbbcccddd");
});

test("newline() flushes streamed text before interleaved lines", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: 20, write: (s) => chunks.push(s) });
  p.push("partial stream");
  p.newline();
  p.push("next line");
  p.end();
  const text = chunks.join("");
  assert.equal(text, "partial stream\nnext line");
});

test("explicit newlines reset the column counter", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: 12, write: (s) => chunks.push(s) });
  p.push("first line\nsecond");
  p.end();
  const lines = chunks.join("").split("\n");
  assert.ok(lines.every((l) => l.length <= 12), JSON.stringify(lines));
  assert.equal(chunks.join("").replace(/\n/g, " ").trim(), "first line second");
});

test("streamWidth honors COLUMNS env and clamps to a floor", () => {
  assert.equal(streamWidth({ columns: 120 }, {}), 120);
  assert.equal(streamWidth({}, { COLUMNS: "80" }), 80);
  assert.equal(streamWidth({}, {}), 100);
  assert.equal(streamWidth({ columns: 5 }, {}), 20);
});

test("thinking renders dim; answer text flushes the dim block first", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: Number.POSITIVE_INFINITY, write: (s) => chunks.push(s) });
  p.thinking("reasoning about the bug ");
  p.push("The answer.");
  p.end();
  const text = chunks.join("");
  // Dim marker appears before thinking, reset appears before the answer.
  const dimIdx = text.indexOf("\x1b[2m");
  const resetIdx = text.indexOf("\x1b[22m");
  const answerIdx = text.indexOf("The answer.");
  assert.ok(dimIdx !== -1, "thinking block must be dimmed");
  assert.ok(resetIdx !== -1 && resetIdx < answerIdx, "reset must precede answer text");
  assert.ok(text.includes("reasoning about the bug"));
});

test("thinking-only stream still resets the dim block at end()", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: Number.POSITIVE_INFINITY, write: (s) => chunks.push(s) });
  p.thinking("hmm");
  p.end();
  const text = chunks.join("");
  assert.ok(text.includes("\x1b[2m"));
  assert.ok(text.endsWith("\x1b[22m"), `got: ${JSON.stringify(text)}`);
});

test("tool line between thinking and answer does not inherit dim state", () => {
  const chunks: string[] = [];
  const p = new StreamPrinter({ width: Number.POSITIVE_INFINITY, write: (s) => chunks.push(s) });
  p.thinking("thinking... ");
  p.newline(); // interleaved status line
  p.push("status line\n");
  p.push("answer");
  p.end();
  const text = chunks.join("");
  const afterStatus = text.slice(text.indexOf("status line"));
  // Answer text comes after the reset (dim block closed before it).
  assert.ok(afterStatus.indexOf("\x1b[22m") < afterStatus.indexOf("answer"));
});
