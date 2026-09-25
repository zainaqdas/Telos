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
