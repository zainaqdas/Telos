import assert from "node:assert/strict";
import { test } from "node:test";
import { panelLines, Panel } from "../src/session/panel.ts";
import { LineEditor } from "../src/session/line-editor.ts";

/** v0.1.8: docked input panel (Pi/Hermes-style bottom box). */

const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("panelLines: status + input rows at exact width, hint when height allows", () => {
  const v = panelLines({ width: 60, panelHeight: 3, input: "hello", cursor: 5, status: "budget 0 (no cap)", busy: false });
  const rows = [v.status, ...v.input].map(strip);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal([...row].length, 60, `row width: ${row}`);
  assert.match(rows[0]!, /budget 0 \(no cap\)/);
  assert.match(rows[1]!, /hello/);
  assert.match(rows[2]!, /Enter send/);
  assert.equal(v.cursorCol, 5);
});

test("panelLines: long input windows so the cursor stays visible", () => {
  const input = "a".repeat(200) + "TAIL";
  const v = panelLines({ width: 40, panelHeight: 2, input, cursor: input.length, status: "s", busy: false });
  const row = strip(v.input[0]!);
  assert.ok(row.includes("TAIL"), "cursor end must be visible");
  // The window holds exactly the LAST ~36 content chars (w=40 → 36 visible).
  assert.ok(row.includes("a".repeat(28)), "window is full of the tail a's");
  assert.ok(!row.includes("a".repeat(37)), "nothing before the window is visible");
  assert.equal([...row].length, 40);
  // And with the cursor at the far LEFT, the tail is what scrolls out.
  const v2 = panelLines({ width: 40, panelHeight: 2, input, cursor: 0, status: "s", busy: false });
  const row2 = strip(v2.input[0]!);
  assert.ok(!row2.includes("TAIL"));
  assert.equal(v2.cursorCol, 0);
});

test("panelLines: busy hint differs from idle hint", () => {
  const busy = panelLines({ width: 60, panelHeight: 3, input: "", cursor: 0, status: "s", busy: true });
  const idle = panelLines({ width: 60, panelHeight: 3, input: "", cursor: 0, status: "s", busy: false });
  assert.match(strip(busy.input[1]!), /Ctrl\+C cancel/);
  assert.match(strip(idle.input[1]!), /history/);
});

test("Panel (not installed): everything falls through to plain stdout", () => {
  const chunks: string[] = [];
  const p = new Panel({ write: (s) => chunks.push(s), width: () => Number.POSITIVE_INFINITY, height: () => Number.POSITIVE_INFINITY, renderStatus: () => "" });
  p.print("hello\n");
  p.writeTranscript("delta");
  p.setInput("x", 1);
  p.setBusy(true);
  assert.equal(chunks.join(""), "hello\ndelta");
  assert.equal(p.active, false);
  p.teardown(); // no-op when not installed
});

test("Panel install: region set, panel drawn, cursor left in panel, position saved", () => {
  const chunks: string[] = [];
  const p = new Panel({ write: (s) => chunks.push(s), width: () => 80, height: () => 24, panelHeight: 3, renderStatus: () => "st" });
  p.install();
  const all = chunks.join("");
  assert.ok(all.includes("\x1b[1;20r"), `scroll region: ${all.slice(0, 80)}`);
  assert.ok(all.includes("\x1b[?25l"), "cursor hidden");
  assert.ok(all.includes("╭"), "top border drawn");
  assert.ok(all.includes("\x1b7"), "transcript position saved after install");
  // Cursor ends inside the panel (input row = row 21 for h=24, panel 4 rows).
  assert.ok(all.includes("\x1b[21;"), "cursor parked in the input row");
  p.teardown();
  const torn = chunks.join("");
  assert.ok(torn.includes("\x1b[r"), "scroll region reset");
  assert.ok(torn.includes("\x1b[?25h"), "cursor shown");
});

test("writeTranscript continues where the last write ended (DECRC), then re-saves", async () => {
  const chunks: string[] = [];
  const p = new Panel({ write: (s) => chunks.push(s), width: () => 80, height: () => 24, panelHeight: 3, renderStatus: () => "st" });
  p.install();
  chunks.length = 0;
  p.writeTranscript("Hello ");
  let all = chunks.join("");
  assert.ok(all.startsWith("\x1b8"), "first write restores the saved transcript position");
  chunks.length = 0;
  p.writeTranscript("world");
  all = chunks.join("");
  assert.ok(!all.startsWith("\x1b8"), "continuation does NOT re-jump (cursor already there)");
  assert.ok(all.includes("world"));
  // Throttled repaint fires within ~50ms and re-saves the position.
  await new Promise((r) => setTimeout(r, 60));
  const post = chunks.join("");
  assert.ok(post.includes("\x1b7"), "repaint re-saves the transcript position");
  assert.ok(post.includes("╭"), "repaint redraws the panel");
});

test("print writes full lines into the region without touching the panel", () => {
  const chunks: string[] = [];
  const p = new Panel({ write: (s) => chunks.push(s), width: () => 80, height: () => 24, panelHeight: 3, renderStatus: () => "st" });
  p.install();
  chunks.length = 0;
  p.print("a transcript line");
  const all = chunks.join("");
  assert.ok(all.startsWith("\x1b8"), "restores transcript position");
  assert.ok(all.includes("a transcript line\n"), "line written with newline");
  assert.ok(!all.includes("\x1b[20;1H"), "no per-line row jumping");
});

test("editor exposes cursor for the panel and repaint works after external edits", () => {
  const echoed: string[] = [];
  const ed = new LineEditor({ onEcho: (s) => echoed.push(s) });
  ed.feed("hello");
  assert.equal(ed.cursor, 5);
  ed.feed("\x1b[D\x1b[D");
  assert.equal(ed.cursor, 3);
  ed.feed("X");
  assert.equal(ed.value, "helXlo");
});
