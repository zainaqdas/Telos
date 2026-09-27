/**
 * Docked input panel (v0.1.8) — Pi/Hermes-style UI.
 *
 * The terminal is split with a DECSTBM scroll region:
 *
 *   ┌ transcript (scrolls natively, keeps its scrollback) ┐
 *   │ …                                                   │
 *   ├──────────────────────────────────────────────────────┤
 *   │ status line: budget · model · activity               │  ← panel, stuck
 *   │ > input box (the line editor renders INSIDE)        │     to the bottom
 *   │ hint row                                            │
 *   └──────────────────────────────────────────────────────┘
 *
 * Cursor model (the invariant that makes this work):
 *   - After every panel repaint the REAL cursor is parked inside the panel,
 *     at the editor position, and a DECSC (\x1b7) has saved the transcript
 *     write position (end of the last transcript write, inside the region).
 *   - Any transcript write first DECRCs (\x1b8) back to that position, writes
 *     raw text (the region wraps/scrolls it), then schedules a panel repaint
 *     which re-saves. Streaming deltas therefore land exactly where the last
 *     one ended — no per-delta jump-to-row, no overwriting the panel.
 *   - The panel is BELOW the scroll region, so scrolling transcript never
 *     moves it, and panel repaints never scroll the transcript.
 *
 * Single stdout owner (P0): the panel is the ONLY component that emits cursor
 * control in TTY mode. Spinner/ThinkingWindow are retired to pipe mode only;
 * activity is STATE here (the activity label in the status row), never another
 * writer. Repaints are deduped — an identical frame is not rewritten — and
 * SIGWINCH resets the layout instead of nudging it.
 *
 * TTY-only: when not installed (pipe, tiny/lying terminal), every call
 * degenerates to plain stdout writes — linear output, zero escapes.
 */

export interface PanelOptions {
  write: (s: string) => void;
  width: () => number;
  height: () => number;
  /** Panel interior rows: 2 (status+input) … 5. Default 3 (+ hint). */
  panelHeight?: number;
  /** Live status line content (budget, model, tools…). */
  renderStatus: () => string;
}

const ANSI = {
  dim: "\x1b[2m",
  faint: "\x1b[22m",
  clearRight: "\x1b[K",
  reset: "\x1b[0m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  save: "\x1b7",
  restore: "\x1b8",
} as const;

/** Panel layout math (pure, unit-testable). */
export function panelLines(opts: {
  width: number;
  panelHeight: number;
  input: string;
  cursor: number;
  status: string;
  busy: boolean;
  /** Activity label rendered in the status row (e.g. "◐ thinking 8.4s"). */
  activity?: string;
}): { status: string; input: string[]; cursorCol: number } {
  const w = Math.max(20, opts.width);
  const h = Math.max(2, Math.min(5, opts.panelHeight));
  // Row anatomy: │ + space + content(maxVisible) + space + │ = w visible cols.
  const maxVisible = Math.max(1, w - 4);

  // Horizontal window over the input so the cursor is always visible.
  const chars = [...opts.input];
  let start = 0;
  if (opts.cursor >= maxVisible) start = opts.cursor - maxVisible + 1;
  const visible = chars.slice(start, start + maxVisible).join("");
  const cursorCol = opts.cursor - start;

  const statusWithActivity = opts.activity ? `${opts.status} · ${opts.activity}` : opts.status;
  const status = truncateVisible(statusWithActivity, maxVisible);
  const statusRow = `${ANSI.dim}│${ANSI.faint} ${status}${" ".repeat(Math.max(0, maxVisible - visibleLen(status)))} ${ANSI.dim}│${ANSI.faint}`;
  const inputRow = `${ANSI.dim}│${ANSI.faint} ${visible}${" ".repeat(Math.max(0, maxVisible - [...visible].length))} ${ANSI.dim}│${ANSI.faint}`;

  const lines: string[] = [statusRow, inputRow];
  if (h > 2) {
    const hint = opts.busy ? "Ctrl+C cancel · type to queue a steering line" : "Enter send · ↑/↓ history · Ctrl+C exit";
    lines.push(`${ANSI.dim}│${ANSI.faint} ${truncateVisible(hint, maxVisible)}${" ".repeat(Math.max(0, maxVisible - visibleLen(hint)))} ${ANSI.dim}│${ANSI.faint}`);
  }
  return { status: lines[0]!, input: lines.slice(1), cursorCol };
}

function visibleLen(s: string): number {
  return [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")].length;
}

function truncateVisible(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

export class Panel {
  private readonly opts: PanelOptions;
  private installed = false;
  /** DECSC saved? (transcript position is restorable) */
  private transcriptSaved = false;
  /** Panel repaint pending via throttle timer? */
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialized frame of the last drawn panel — identical frames skip the write. */
  private lastFrame = "";

  constructor(opts: PanelOptions) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.installed;
  }

  /** Total panel height in rows, top border included. */
  get height(): number {
    return Math.max(2, Math.min(5, this.opts.panelHeight ?? 3)) + 1;
  }

  install(): void {
    const w = this.opts.width();
    const h = this.opts.height();
    if (!Number.isFinite(w) || !Number.isFinite(h) || h < this.height + 4 || w < 30) return;
    this.installed = true;
    const rows = this.height;
    this.writeRaw(
      [
        ANSI.hideCursor,
        `\x1b[1;${Math.max(1, h - rows)}r`, // scroll region = transcript only
        `\x1b[${Math.max(1, h - rows)};1H`, // move to region bottom = transcript position
        ANSI.save, // SAVE FIRST: the slot must hold the TRANSCRIPT position
        this.drawPanel(), // then draw the panel (cursor ends in the input row)
      ].join(""),
    );
    this.transcriptSaved = true;
  }

  teardown(): void {
    if (this.repaintTimer) clearTimeout(this.repaintTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (!this.installed) return;
    this.installed = false;
    this.lastFrame = "";
    this.writeRaw([ANSI.restore, `\x1b[${this.opts.height()};1H`, ANSI.reset, `\x1b[r`, ANSI.showCursor, "\n"].join(""));
  }

  /**
   * Write raw text into the transcript (streaming deltas included).
   * Sequence: restore to the saved TRANSCRIPT position → write (the region
   * wraps/scrolls; cursor now sits at the new end of text) → re-save THAT
   * position. The panel repaint is throttled afterwards — deltas arrive in
   * bursts, and repaints never touch the saved slot.
   */
  writeTranscript(text: string): void {
    if (!this.installed) {
      this.opts.write(text);
      return;
    }
    const head = this.transcriptSaved ? ANSI.restore : `\x1b[${Math.max(1, this.opts.height() - this.height)};1H`;
    this.writeRaw(head + text + ANSI.save);
    this.transcriptSaved = true;
    this.scheduleRepaint();
  }

  /** Print one complete transcript line (adds \n unless present). */
  print(line: string): void {
    this.writeTranscript(line.endsWith("\n") || line === "" ? line : `${line}\n`);
  }

  /** Editor state changed — repaint the panel immediately (keystroke feel). */
  setInput(buffer: string, cursor: number): void {
    this.inputBuffer = buffer;
    this.inputCursor = cursor;
    if (this.installed) this.repaintNow();
  }

  setBusy(busy: boolean): void {
    if (this.busyFlag === busy) return;
    this.busyFlag = busy;
    if (this.installed) this.repaintNow();
  }

  /**
   * Activity as STATE (P0): the status row shows what the agent is doing
   * ("◐ thinking 8.4s", "↻ retry 1/2"). One live status row — a spinner or
   * thinking box must never write to stdout while the panel is installed.
   */
  setActivity(activity: string): void {
    if (this.activityLabel === activity) return;
    this.activityLabel = activity;
    if (this.installed) this.repaintNow();
  }

  /**
   * Resize (P0): coalesced, then a FULL LAYOUT RESET — reset the scroll
   * region, re-anchor the transcript position at the new region bottom,
   * rebuild the panel. No incremental surgery on stale cursor state.
   */
  onResize(): void {
    if (!this.installed) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (!this.installed) return;
      const h = this.opts.height();
      const rows = this.height;
      this.lastFrame = ""; // force a full redraw even if content is unchanged
      this.writeRaw(`\x1b[r\x1b[1;${Math.max(1, h - rows)}r\x1b[${Math.max(1, h - rows)};1H${ANSI.save}`);
      this.transcriptSaved = true;
      this.repaintNow();
    }, 80);
    if (typeof this.resizeTimer.unref === "function") this.resizeTimer.unref();
  }

  /** Immediate: redraw the panel only. The saved slot (transcript position)
   *  is untouched — it was saved by writeTranscript/install and must survive
   *  every repaint, or the next transcript write lands in the panel. */
  private repaintNow(): void {
    if (!this.installed) return;
    if (this.repaintTimer) {
      clearTimeout(this.repaintTimer);
      this.repaintTimer = null;
    }
    const frame = this.drawPanel();
    // Identical frame (same status, input, cursor, activity): skip the write.
    // Rapid coalesced events then produce one stable render, not repaint spam.
    if (frame === this.lastFrame) return;
    this.lastFrame = frame;
    this.writeRaw(frame);
  }

  /** Throttled repaint after transcript writes (bursts of deltas). */
  private scheduleRepaint(): void {
    if (this.repaintTimer) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      this.repaintNow();
    }, 30);
    if (typeof this.repaintTimer.unref === "function") this.repaintTimer.unref();
  }

  /** Build the panel draw sequence (caller positions/returns the cursor). */
  private drawPanel(): string {
    const w = this.opts.width();
    const h = this.opts.height();
    const rows = this.height;
    const top = h - rows + 1;
    const view = panelLines({
      width: w,
      panelHeight: rows - 1,
      input: this.inputBuffer,
      cursor: this.inputCursor,
      status: this.opts.renderStatus(),
      busy: this.busyFlag,
      activity: this.activityLabel || undefined,
    });
    const parts: string[] = ["\r"];
    parts.push(`\x1b[${top};1H${ANSI.dim}╭${"─".repeat(Math.max(0, w - 2))}╮${ANSI.faint}`);
    parts.push(`\x1b[${top + 1};1H${view.status}`);
    view.input.forEach((row, i) => parts.push(`\x1b[${top + 2 + i};1H${row}`));
    // Cursor ends inside the input row at the editor position.
    parts.push(`\x1b[${top + 2};${2 + Math.max(0, view.cursorCol)}H`);
    return parts.join("");
  }

  private writeRaw(s: string): void {
    try {
      this.opts.write(s);
    } catch {
      /* panel must never break the session */
    }
  }

  // Editor state fed by the session:
  private inputBuffer = "";
  private inputCursor = 0;
  private busyFlag = false;
  private activityLabel = "";
}
