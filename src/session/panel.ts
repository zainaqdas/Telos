/**
 * Docked input panel (v0.1.8) — Pi/Hermes-style UI.
 *
 * The terminal is split with a DECSTBM scroll region:
 *
 *   ┌ transcript (scrolls natively, keeps its scrollback) ┐
 *   │ …                                                   │
 *   ├──────────────────────────────────────────────────────┤
 *   │ status line: budget · model · elapsed               │  ← panel, stuck
 *   │ > input box (line editor renders INSIDE the box)    │     to the bottom
 *   └──────────────────────────────────────────────────────┘
 *
 * Transcript lines are printed by moving the cursor into the scroll region
 * (saved cursor position → cursor to region → write → restore). The panel
 * never scrolls away because it lives BELOW the scroll region — the terminal
 * itself re-renders it at the bottom regardless of how much scrolls above.
 * TTY-only: piped sessions keep linear output (panel is never installed).
 *
 * Terminal discipline on teardown: leave the alternate... no — we never use
 * the alternate screen (scrollback is preserved). Teardown just resets
 * scroll region, modes and cursor visibility, and prints a final newline.
 */

export interface PanelOptions {
  write: (s: string) => void;
  /** Terminal width/height in cells. */
  width: () => number;
  height: () => number;
  /** Panel height: 2 (status + input) … 6. Default 3 (status, input, hint). */
  panelHeight?: number;
  /** Render the live status line (budget, model, elapsed…). */
  renderStatus: () => string;
}

const ANSI = {
  dim: "\x1b[2m",
  faint: "\x1b[22m",
  clearRight: "\x1b[K",
  reset: "\x1b[0m",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
} as const;

interface BoxLines {
  status: string;
  input: string[];
  cursorCol: number;
  windowStart: number;
}

/** Panel layout math (pure, unit-testable). */
export function panelLines(opts: {
  width: number;
  panelHeight: number;
  input: string;
  /** Code-point cursor offset into `input`. */
  cursor: number;
  status: string;
  busy: boolean;
}): BoxLines {
  const w = Math.max(20, opts.width);
  const h = Math.max(2, Math.min(6, opts.panelHeight));
  // Row anatomy: │ + space + content(maxVisible) + space + │ = w visible cols.
  const maxVisible = Math.max(1, w - 4);

  // Horizontal window over the input so the cursor is always visible.
  const chars = [...opts.input];
  let start = 0;
  if (opts.cursor >= maxVisible) start = opts.cursor - maxVisible + 1;
  const visible = chars.slice(start, start + maxVisible).join("");
  const cursorCol = opts.cursor - start;

  const status = truncateVisible(opts.status, maxVisible);
  const statusRow = `${ANSI.dim}│${ANSI.faint} ${status}${" ".repeat(Math.max(0, maxVisible - visibleLen(status)))} ${ANSI.dim}│${ANSI.faint}`;

  const inputRow = `${ANSI.dim}│${ANSI.faint} ${visible}${" ".repeat(Math.max(0, maxVisible - [...visible].length))} ${ANSI.dim}│${ANSI.faint}`;

  const lines: string[] = [statusRow, inputRow];
  if (h > 2) {
    const hint = opts.busy ? "Ctrl+C cancel · type to queue a steering line" : "Enter send · ↑/↓ history · Ctrl+C exit";
    const hintRow = `${ANSI.dim}│${ANSI.faint} ${truncateVisible(hint, maxVisible)}${" ".repeat(Math.max(0, maxVisible - visibleLen(hint)))} ${ANSI.dim}│${ANSI.faint}`;
    lines.push(hintRow);
  }
  return { status: lines[0]!, input: lines.slice(1), cursorCol, windowStart: start };
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
  private rows = 0;
  private installed = false;
  private lastStatus = "";
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PanelOptions) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.installed;
  }

  /** Panel height in rows (incl. top border). */
  get height(): number {
    return Math.max(2, Math.min(6, this.opts.panelHeight ?? 3)) + 1; // + top border
  }

  /**
   * Install: set the scroll region so the panel area is BELOW it, park the
   * cursor in the transcript region, and draw the panel.
   */
  install(): void {
    const w = this.opts.width();
    const h = this.opts.height();
    // Refuse when the terminal lies (0×0) or is too small for a usable panel:
    // a broken region is worse than linear output. Output falls through to
    // plain stdout when not installed.
    if (!Number.isFinite(w) || !Number.isFinite(h) || h < this.height + 4 || w < 30) return;
    this.installed = true;
    const rows = this.height;
    this.writeRaw(
      [
        ANSI.hideCursor,
        // Scroll region: rows 1..(h - rows). Everything below never scrolls.
        `\x1b[1;${Math.max(1, h - rows)}r`,
        // Park cursor inside the scroll region.
        `\x1b[${Math.max(1, h - rows)};1H`,
      ].join(""),
    );
    this.draw();
  }

  /** Teardown on exit: reset region, show cursor, newline past the panel. */
  teardown(): void {
    if (!this.installed) return;
    this.installed = false;
    this.writeRaw(
      [
        `\x1b[${this.opts.height()};1H`, // bottom of screen
        ANSI.reset,
        `\x1b[r`, // reset scroll region
        ANSI.showCursor,
        "\n",
      ].join(""),
    );
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
  }

  /**
   * Print one transcript line into the scroll region (the panel is untouched:
   * we jump above it, write, and jump back to the saved panel cursor).
   */
  print(line: string): void {
    if (!this.installed) {
      this.opts.write(line.endsWith("\n") || line === "" ? line : `${line}\n`);
      return;
    }
    const h = this.opts.height();
    const regionBottom = Math.max(1, h - this.height);
    const text = line.endsWith("\n") || line === "" ? line : `${line}\n`;
    // ANSI save/restore is per-screen; the panel cursor lives at the input
    // row. We re-position explicitly: save → region bottom → text → panel.
    this.writeRaw(`\x1b7\x1b[${regionBottom};1H${text}\x1b8`);
    this.drawInput(); // keep input row fresh (col counts can change)
  }

  /** Refresh the status row (budget bar etc.). Cheap; called on changes. */
  setStatus(status: string): void {
    if (!this.installed) return;
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.draw();
  }

  /** Repaint the input row from the editor's current buffer/cursor. */
  drawInput(): void {
    if (!this.installed) return;
    this.draw();
  }

  /** Full panel repaint at its fixed screen position. */
  private draw(): void {
    if (!this.installed) return;
    const w = this.opts.width();
    const h = this.opts.height();
    const rows = this.height;
    const top = h - rows + 1; // 1-based row of the panel's top border
    const view = panelLines({
      width: w,
      panelHeight: rows - 1,
      input: this.inputBuffer,
      cursor: this.inputCursor,
      status: this.currentStatus,
      busy: this.busyFlag,
    });
    const parts: string[] = ["\r"];
    parts.push(`\x1b[${top};1H${ANSI.dim}╭${"─".repeat(Math.max(0, w - 2))}╮${ANSI.faint}`);
    parts.push(`\x1b[${top + 1};1H${view.status}`);
    view.input.forEach((row, i) => parts.push(`\x1b[${top + 2 + i};1H${row}`));
    // Place the terminal cursor at the editor position inside the input row.
    const cursorRow = top + 2; // panel interior: status, then input row
    parts.push(`\x1b[${cursorRow};${2 + Math.max(0, view.cursorCol)}H`);
    this.writeRaw(parts.join(""));
  }

  // The session feeds the panel the editor state each frame:
  private inputBuffer = "";
  private inputCursor = 0;
  private currentStatus = "";
  private busyFlag = false;

  /** Called by the session on every editor state change. */
  setInput(buffer: string, cursor: number): void {
    this.inputBuffer = buffer;
    this.inputCursor = cursor;
    if (this.installed) this.draw();
  }

  setBusy(busy: boolean): void {
    if (this.busyFlag === busy) return;
    this.busyFlag = busy;
    if (this.installed) this.draw();
  }

  /** Handle terminal resize: recompute region + repaint. Debounced. */
  onResize(): void {
    if (!this.installed) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      const h = this.opts.height();
      const rows = this.height;
      this.writeRaw(`\x1b[r\x1b[1;${Math.max(1, h - rows)}r\x1b[${Math.max(1, h - rows)};1H`);
      this.lastStatus = "";
      this.draw();
    }, 80);
    if (typeof this.resizeTimer.unref === "function") this.resizeTimer.unref();
  }

  private writeRaw(s: string): void {
    try {
      this.opts.write(s);
    } catch {
      /* panel must never break the session */
    }
  }
}
