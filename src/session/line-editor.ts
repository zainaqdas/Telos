/**
 * Zero-dep line editor for the interactive session (input-quality fix).
 *
 * The old input path kept an append-only buffer: backspace trimmed the end of
 * the STRING, the redraw wrote no clear-to-EOL so deleted characters stayed
 * visible as ghosts, and arrow keys leaked `[C` / `[D` into the line because
 * CSI sequences were parsed byte-wise with 0x1b silently dropped
 * (`byte < 0x20`). Home/End/Delete did nothing and multibyte input corrupted.
 *
 * This editor keeps a CURSOR inside the buffer and parses the sequences real
 * terminals send: CSI (ESC [ … final), SS3 (ESC O …), WSL F-key variant
 * (ESC [ [ A-E), and Alt-chords (ESC <key>). Sequences split across reads are
 * buffered — a real pty delivers `\x1b[` and `D` in separate chunks all the
 * time. Pure logic is separated from terminal I/O: unit tests feed bytes and
 * assert actions/buffers without a pty; the session only wires onEcho.
 */

/** Keys the session acts on; everything else the editor handles internally. */
export type EditorAction = "submit" | "interrupt" | "eof" | "none";

export interface EditorResult {
  action: EditorAction;
  /** Line to submit (only when action === "submit"). */
  line?: string;
}

export interface LineEditorOptions {
  /** Terminal writes (echo/redraw). */
  onEcho: (s: string) => void;
  /**
   * History navigation, owned by the session. Called on ↑/↓; return the entry
   * to load, or null when the end of history is reached. dir -1 = older.
   */
  historyNav?: (dir: -1 | 1) => string | null;
}

/** Time window in which a lone ESC waits for the rest of its sequence (ms). */
const ESCAPE_WAIT_MS = 50;

export class LineEditor {
  private buf = "";
  private pos = 0; // code-point index into buf
  /** Partial escape sequence carried between feeds (split reads). */
  private pendingEscape = "";
  /** When the pending lone-ESC first arrived (0 = no timer). */
  private escStartedAt = 0;
  /** Lines completed this feed — a paste burst can contain several Enters. */
  private submitted: string[] = [];
  private readonly onEcho: (s: string) => void;
  private readonly historyNav?: (dir: -1 | 1) => string | null;

  constructor(opts: LineEditorOptions) {
    this.onEcho = opts.onEcho;
    this.historyNav = opts.historyNav;
  }

  get value(): string {
    return this.buf;
  }

  /** Current cursor as a code-point offset into `value` (for panel rendering). */
  get cursor(): number {
    return this.pos;
  }

  /** Discard partial input + pending escape + queued submits (Ctrl+C). */
  reset(): void {
    this.buf = "";
    this.pos = 0;
    this.pendingEscape = "";
    this.escStartedAt = 0;
    this.submitted = [];
  }

  /**
   * All lines completed so far (a paste burst may carry multiple Enters in
   * one chunk). Call after every feed; the session hands each to handleLine.
   */
  takeSubmitted(): string[] {
    const s = this.submitted;
    this.submitted = [];
    return s;
  }

  /** Full-line repaint (buffer + clear to EOL + cursor reposition). */
  repaint(): void {
    const len = [...this.buf].length;
    const back = len - this.pos;
    this.onEcho(`\r${this.buf}\x1b[K${back > 0 ? `\x1b[${back}D` : ""}`);
  }

  /**
   * Feed one chunk of terminal input. At most one action is returned per
   * feed; echo/redraw writes are emitted through onEcho as they happen.
   */
  feed(data: string): EditorResult {
    let stream = this.pendingEscape + data;
    this.pendingEscape = "";
    let result: EditorResult = { action: "none" };
    let i = 0;

    while (i < stream.length) {
      const ch = stream[i]!;

      // ── Escape sequences ─────────────────────────────────────────────
      if (ch === "\x1b") {
        const seq = takeEscape(stream, i);
        if (seq === null) {
          const rest = stream.slice(i);
          if (rest === "\x1b") {
            // A lone ESC: wait briefly for its follower (Alt-chords, arrow
            // heads) — pty reads split sequences all the time.
            if (this.escStartedAt === 0) this.escStartedAt = Date.now();
            if (Date.now() - this.escStartedAt < ESCAPE_WAIT_MS) {
              this.pendingEscape = rest;
              break;
            }
            this.escStartedAt = 0;
            i += 1; // timed out: drop the stray ESC, never leak it
            continue;
          }
          this.pendingEscape = rest; // ESC + partial CSI/SS3: wait for more
          break;
        }
        this.escStartedAt = 0;
        i += seq.length;
        this.applyEscape(seq);
        continue;
      }
      this.escStartedAt = 0;

      // ── Control characters ───────────────────────────────────────────
      if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && stream[i + 1] === "\n") i += 1; // swallow LF of CRLF
        const line = this.buf;
        this.buf = "";
        this.pos = 0;
        this.onEcho("\r\n");
        this.submitted.push(line); // queued: bursts carry multiple Enters
        result = { action: "submit", line };
        i += 1;
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        this.backspace();
        i += 1;
        continue;
      }
      if (ch === "\x03") {
        this.reset();
        this.onEcho("^C\r\n");
        result = { action: "interrupt" };
        i += 1;
        continue;
      }
      if (ch === "\x04") {
        // Readline convention: Ctrl+D on an empty line = EOF; on a non-empty
        // line = delete the character under the cursor.
        if (this.buf.length === 0) {
          result = { action: "eof" };
        } else {
          this.deleteForward();
        }
        i += 1;
        continue;
      }
      if (ch === "\x0c") {
        this.onEcho("\x1b[2J\x1b[H");
        i += 1;
        continue;
      }
      if (ch < " ") {
        i += 1;
        continue; // other control chars: ignore (tab has no completion engine)
      }

      // ── Printable (astral-safe: surrogate pairs move as one char) ────
      const cp = [...stream.slice(i)][0]!;
      this.insert(cp);
      i += cp.length;
    }
    return result;
  }

  // ─── Editing primitives (cursor-aware) ──────────────────────────────────

  private insert(cp: string): void {
    const chars = [...this.buf];
    const atEnd = this.pos === chars.length;
    chars.splice(this.pos, 0, cp);
    this.buf = chars.join("");
    this.pos += 1;
    if (atEnd) {
      this.onEcho(cp); // common case: append, one char
    } else {
      const tail = chars.slice(this.pos).join("");
      this.onEcho(`${tail}\x1b[${tail.length}D`); // mid-line: repaint tail
    }
  }

  private backspace(): void {
    if (this.pos === 0) return;
    const chars = [...this.buf];
    const removed = chars[this.pos - 1]!;
    chars.splice(this.pos - 1, 1);
    this.buf = chars.join("");
    this.pos -= 1;
    if (this.pos === chars.length) {
      // Common case: delete at end — one wide backspace covers astral too.
      this.onEcho(`\b${removed.length === 2 ? "  " : " "}\b`);
    } else {
      const tail = chars.slice(this.pos).join("");
      this.onEcho(`\b${tail} \x1b[${tail.length + 1}D`);
    }
  }

  private deleteForward(): void {
    const chars = [...this.buf];
    if (this.pos >= chars.length) return;
    chars.splice(this.pos, 1);
    this.buf = chars.join("");
    const tail = chars.slice(this.pos).join("");
    this.onEcho(`${tail} \x1b[${tail.length + 1}D`);
  }

  private move(delta: -1 | 1): void {
    const len = [...this.buf].length;
    const next = this.pos + delta;
    if (next < 0 || next > len) return;
    this.pos = next;
    this.onEcho(delta === -1 ? "\b" : "\x1b[C");
  }

  private jumpStart(): void {
    if (this.pos > 0) {
      this.onEcho(`\x1b[${this.pos}D`);
      this.pos = 0;
    }
  }

  private jumpEnd(): void {
    const len = [...this.buf].length;
    if (this.pos < len) {
      this.onEcho(`\x1b[${len - this.pos}C`);
      this.pos = len;
    }
  }

  private killToEnd(): void {
    const chars = [...this.buf];
    if (this.pos >= chars.length) return;
    chars.splice(this.pos);
    this.buf = chars.join("");
    this.onEcho("\x1b[K");
  }

  private killToStart(): void {
    if (this.pos === 0) return;
    this.buf = [...this.buf].slice(this.pos).join("");
    this.pos = 0;
    this.repaint();
  }

  private killWord(): void {
    const chars = [...this.buf];
    let i = this.pos;
    while (i > 0 && chars[i - 1] === " ") i -= 1;
    while (i > 0 && chars[i - 1] !== " ") i -= 1;
    chars.splice(i, this.pos - i);
    this.buf = chars.join("");
    this.pos = i;
    this.repaint();
  }

  private loadHistory(dir: -1 | 1): void {
    if (!this.historyNav) return;
    const entry = this.historyNav(dir);
    if (entry === null) return;
    this.buf = entry;
    this.pos = [...entry].length;
    this.repaint();
  }

  // ─── Escape dispatch ─────────────────────────────────────────────────────

  private applyEscape(seq: string): void {
    // WSL/terminfo F-key variant comes through the CSI scan as ESC [[ <A-E>;
    // handle it before generic CSI. (The scan stops at the second '['.)
    if (seq.length === 4 && seq.startsWith("\x1b[[") && /[A-E]/.test(seq[3]!)) {
      switch (seq[3]) {
        case "A": return this.loadHistory(-1);
        case "B": return this.loadHistory(1);
        case "C": return this.move(1);
        case "D": return this.move(-1);
        default: return;
      }
    }
    if (seq.startsWith("\x1b[")) {
      const final = seq[seq.length - 1]!;
      const params = seq.slice(2, -1);
      switch (final) {
        case "A": return this.loadHistory(-1);
        case "B": return this.loadHistory(1);
        case "C": return this.move(1);
        case "D": return this.move(-1);
        case "H": return this.jumpStart();
        case "F": return this.jumpEnd();
        case "~": {
          // VT-style: ESC [ <n> ~  (Home=1, Del=3, End=4)
          if (params === "1") return this.jumpStart();
          if (params === "3") return this.deleteForward();
          if (params === "4") return this.jumpEnd();
          return; // Ins/PgUp/PgDn: no-op
        }
        default:
          return; // unknown CSI (modifiers etc.): swallow, never leak
      }
    }
    if (seq.startsWith("\x1bO")) {
      // SS3: application-mode arrows, Putty F1-F4.
      switch (seq[seq.length - 1]) {
        case "A": return this.loadHistory(-1);
        case "B": return this.loadHistory(1);
        case "C": return this.move(1);
        case "D": return this.move(-1);
        case "H": return this.jumpStart();
        case "F": return this.jumpEnd();
        default: return;
      }
    }
    if (seq.length === 2) {
      // Alt-chord: Alt+Backspace kills the previous word; Alt+letter inserts
      // the letter (the session has no meta commands).
      const k = seq[1]!;
      if (k === "\x7f") return this.killWord();
      if (k >= " ") this.insert(k);
    }
  }
}

/**
 * Extract one escape sequence starting at `s[start] === ESC`, or null when
 * incomplete (more bytes needed). Recognizes:
 *   ESC [ <params> <final@→~>  (CSI — arrows, Home/End, Del 3~, modifiers)
 *   ESC [ [ A-E                (WSL/terminfo F1-F5 variant)
 *   ESC O <letter>             (SS3 — application-mode arrows, F1-F4)
 *   ESC <one char>             (Alt-chord)
 */
export function takeEscape(s: string, start: number): string | null {
  if (s[start] !== "\x1b") return null;
  const a = s[start + 1];
  if (a === undefined) return null; // lone ESC so far
  if (a === "O") {
    return s[start + 2] === undefined ? null : s.slice(start, start + 3);
  }
  if (a === "[") {
    // WSL variant ESC [[A: second '[' then a final letter.
    if (s[start + 2] === "[") {
      const f = s[start + 3];
      if (f === undefined) return null;
      return /[A-E]/.test(f) ? s.slice(start, start + 4) : s.slice(start, start + 3);
    }
    // Generic CSI: scan for the final byte 0x40–0x7E.
    for (let j = start + 2; j < s.length; j += 1) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return s.slice(start, j + 1);
    }
    return null;
  }
  // Alt-chord: ESC + one character.
  return s.slice(start, start + 2);
}
