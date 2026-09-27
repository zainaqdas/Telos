import assert from "node:assert/strict";
import { test } from "node:test";
import { LineEditor, takeEscape } from "../src/session/line-editor.ts";

/** Input-quality fix: cursor editing + real escape parsing, zero-dep. */

function make(history: string[] = []) {
  const echoed: string[] = [];
  // Mirrors the session's history store: index -1 = live draft; first ↑
  // remembers the draft; ↓ past the newest returns to it.
  let index = -1;
  let draft = "";
  const editor = new LineEditor({
    onEcho: (s) => echoed.push(s),
    historyNav: (dir) => {
      if (dir === -1) {
        if (history.length === 0) return null; // session guard: no history
        if (index === -1) {
          draft = editor.value;
          index = history.length - 1;
        } else if (index > 0) {
          index -= 1;
        }
        return history[index] ?? "";
      }
      if (index === -1) return null;
      if (index >= history.length - 1) {
        index = -1;
        return draft;
      }
      index += 1;
      return history[index] ?? "";
    },
  });
  return { editor, echoed };
}

test("backspace removes a character from the buffer (the reported bug)", () => {
  const { editor } = make();
  editor.feed("hi what are y");
  editor.feed("\x7f");
  assert.equal(editor.value, "hi what are ");
  const r = editor.feed("\x7f\x7f\x7f\x7f\x7f");
  assert.equal(r.action, "none");
  assert.equal(editor.value, "hi what");
});

test("backspace at start of empty/beginning buffer is a safe no-op", () => {
  const { editor } = make();
  assert.equal(editor.feed("\x7f").action, "none");
  editor.feed("ab");
  editor.feed("\x1b[D\x1b[D"); // cursor to start
  editor.feed("\x7f\x7f\x7f"); // extra backspaces do nothing
  assert.equal(editor.value, "ab");
});

test("arrow keys never leak into the line (the reported `[C` bug)", () => {
  const { editor } = make();
  editor.feed("hi\x1b[C\x1b[D\x1b[A\x1b[B");
  assert.equal(editor.value, "hi");
  assert.ok(!editor.value.includes("["), `leaked: ${editor.value}`);
});

test("split escape sequences across reads are buffered, not leaked", () => {
  const { editor } = make();
  editor.feed("abc\x1b[D"); // complete sequence in one chunk (cursor → 2)
  const r1 = editor.feed("\x1b"); // lone ESC first…
  const r2 = editor.feed("[D"); // …completion next chunk (cursor → 1)
  assert.equal(r1.action, "none");
  assert.equal(r2.action, "none");
  editor.feed("X"); // insert at position 1
  assert.equal(editor.value, "aXbc");
});

test("cursor movement + mid-line insert/delete", () => {
  const { editor } = make();
  editor.feed("hello");
  editor.feed("\x1b[D\x1b[D\x1b[D"); // cursor after 'he'
  editor.feed("X"); // mid-line insert
  assert.equal(editor.value, "heXllo");
  editor.feed("\x1b[3~"); // Delete forward
  assert.equal(editor.value, "heXlo");
  editor.feed("\x1b[H"); // Home
  editor.feed("Y");
  assert.equal(editor.value, "YheXlo");
  editor.feed("\x1b[F"); // End
  editor.feed("Z");
  assert.equal(editor.value, "YheXloZ");
});

test("Ctrl+C clears the typed line and reports interrupt", () => {
  const { editor } = make();
  editor.feed("oops typo");
  const r = editor.feed("\x03");
  assert.equal(r.action, "interrupt");
  assert.equal(editor.value, "");
});

test("Ctrl+D on empty line signals eof", () => {
  const { editor } = make();
  assert.equal(editor.feed("\x04").action, "eof");
  editor.feed("text");
  assert.equal(editor.feed("\x04").action, "none"); // non-empty: no eof
});

test("submit returns the line and clears the buffer; CRLF handled", () => {
  const { editor } = make();
  editor.feed("hello");
  const r = editor.feed("\r\n"); // CRLF in one chunk
  assert.equal(r.action, "submit");
  assert.equal(r.line, "hello");
  assert.equal(editor.value, "");
  const r2 = editor.feed("next\r");
  assert.equal(r2.action, "submit");
  assert.equal(r2.line, "next");
});

test("multibyte input survives (UTF-8 astral + accents)", () => {
  const { editor } = make();
  editor.feed("héllo 🙂");
  editor.feed("\x7f"); // backspace removes the WHOLE emoji, not half a pair
  assert.equal(editor.value, "héllo ");
  editor.feed("é");
  assert.equal(editor.value, "héllo é");
});

test("history: ↑ recalls older, ↓ returns to draft, edits replace buffer", () => {
  const { editor } = make(["first command", "second command"]);
  editor.feed("draft");
  editor.feed("\x1b[A"); // → "second command"
  assert.equal(editor.value, "second command");
  editor.feed("\x1b[A"); // → "first command"
  assert.equal(editor.value, "first command");
  editor.feed("\x1b[B"); // → "second command"
  assert.equal(editor.value, "second command");
  editor.feed("\x1b[B"); // → back to live draft
  assert.equal(editor.value, "draft");
  editor.feed("\x1b[B"); // ↓ past newest: no-op
  assert.equal(editor.value, "draft");
});

test("Alt+Backspace kills the previous word", () => {
  const { editor } = make();
  editor.feed("remove this");
  editor.feed("\x1b\x7f");
  assert.equal(editor.value, "remove ");
});

test("takeEscape: CSI/SS3/WSL/Alt forms, incomplete returns null", () => {
  assert.equal(takeEscape("\x1b[D", 0), "\x1b[D");
  assert.equal(takeEscape("\x1b[1;5D", 0), "\x1b[1;5D"); // xterm modifier
  assert.equal(takeEscape("\x1bOD", 0), "\x1bOD");
  assert.equal(takeEscape("\x1b[[D", 0), "\x1b[[D");
  assert.equal(takeEscape("\x1bz", 0), "\x1bz");
  assert.equal(takeEscape("\x1b[", 0), null);
  assert.equal(takeEscape("\x1b", 0), null);
  assert.equal(takeEscape("abc", 0), null);
});

test("unknown CSI sequences are swallowed silently (no ghost characters)", () => {
  const { editor } = make();
  editor.feed("ok\x1b[1;5C\x1b[99~\x1b[?25l");
  assert.equal(editor.value, "ok");
});

test("repaint clears stale characters (no ghost after external edit)", () => {
  const { editor, echoed } = make();
  editor.feed("abc");
  echoed.length = 0;
  editor.repaint();
  const last = echoed.join("");
  assert.ok(last.includes("\x1b[K"), "repaint must clear to EOL");
  assert.ok(last.includes("abc"));
});

test("paste burst with multiple Enters queues every line, loses none", () => {
  const { editor } = make();
  const r = editor.feed("first\rsecond\rthird\r");
  assert.equal(r.action, "submit");
  assert.deepEqual(editor.takeSubmitted(), ["first", "second", "third"]);
  assert.equal(editor.value, "");
  assert.deepEqual(editor.takeSubmitted(), []); // drained
});
