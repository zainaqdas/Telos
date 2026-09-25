/**
 * StreamPrinter (Part 60: terminal-native, minimal).
 *
 * Model text arrives as many small deltas. Writing each delta through a
 * newline-appending helper put every SSE chunk on its own line — the source
 * of the "~20 column" wrapping in captured output. The printer writes deltas
 * contiguously instead:
 *
 *   - TTY (width = Infinity): raw passthrough; the terminal wraps naturally.
 *   - non-TTY: greedy word-boundary wrapping at the terminal width, so piped
 *     or logged output reads like the interactive session.
 *
 * Interleaved lines (tool activity, status) call newline() first so they
 * never split a word that is still being streamed.
 */
export class StreamPrinter {
  private lineLen = 0;
  private word = "";
  private pendingSpace = 0;
  private readonly width: number;
  private readonly write: (s: string) => void;

  constructor(opts: { width: number; write?: (s: string) => void }) {
    this.width = opts.width;
    this.write = opts.write ?? ((s: string) => process.stdout.write(s));
  }

  /** Feed one streamed text delta. */
  push(delta: string): void {
    if (!Number.isFinite(this.width)) {
      this.write(delta);
      return;
    }
    for (const ch of delta) {
      if (ch === "\n") {
        this.flushWord();
        this.dropSpace();
        this.write("\n");
        this.lineLen = 0;
      } else if (ch === " " || ch === "\t" || ch === "\r") {
        this.flushWord();
        this.pendingSpace += 1;
      } else {
        this.word += ch;
      }
    }
  }

  /** Flush pending streamed text and move to a fresh line (before tool/status lines). */
  newline(): void {
    if (!Number.isFinite(this.width)) {
      this.write("\n");
      return;
    }
    if (this.lineLen > 0 || this.word.length > 0 || this.pendingSpace > 0) {
      this.flushWord();
      this.dropSpace();
      this.write("\n");
      this.lineLen = 0;
    }
  }

  /** Flush any pending streamed text at the end of a run (no trailing newline). */
  end(): void {
    if (!Number.isFinite(this.width)) return;
    this.flushWord();
    this.dropSpace();
  }

  private flushWord(): void {
    if (!this.word) return;
    // A deferred space is written only if the word fits on this line —
    // otherwise the break replaces it (no trailing whitespace, no leading spaces).
    if (this.pendingSpace > 0 && this.lineLen > 0) {
      if (this.lineLen + this.pendingSpace + this.word.length <= this.width) {
        this.write(" ".repeat(this.pendingSpace));
        this.lineLen += this.pendingSpace;
      } else {
        this.write("\n");
        this.lineLen = 0;
      }
    }
    this.pendingSpace = 0;
    // Hard-break words longer than the whole line.
    while (this.width > 0 && this.lineLen + this.word.length > this.width) {
      const take = Math.max(1, this.width - this.lineLen);
      this.write(this.word.slice(0, take));
      this.write("\n");
      this.word = this.word.slice(take);
      this.lineLen = 0;
    }
    this.write(this.word);
    this.lineLen += this.word.length;
    this.word = "";
  }

  private dropSpace(): void {
    this.pendingSpace = 0;
  }
}

/** Best-effort terminal width for non-TTY output; TTY sessions pass Infinity. */
export function streamWidth(stdout: { columns?: number | undefined }, env: NodeJS.ProcessEnv): number {
  const cols = Number(env["COLUMNS"]) || stdout.columns || 100;
  return Math.max(20, cols);
}
