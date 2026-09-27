/**
 * Thinking window + activity spinner (v0.1.8 UX fixes).
 *
 * Two problems from live use:
 * 1. Thinking streamed as ordinary dimmed text, scrolling the answer away —
 *    long reasoning pushed real work out of view (the Freebuff-style fix is a
 *    CONTAINED window: a fixed-height box that always shows the LATEST
 *    thinking; older lines scroll out of the box, never the screen).
 * 2. Long model latency (TTFT) looked like a hang — nothing moved for 10–60s
 *    before the first token. A spinner with elapsed seconds runs from the
 *    moment the request starts.
 *
 * Both render only on TTY (raw mode): on a pipe the old dimmed streaming and
 * no spinner remain, so logs stay linear. Pure line math (buildThinkingBox)
 * is exported for unit tests.
 */

const ANSI = {
  dim: "\x1b[2m",
  faint: "\x1b[22m",
  clearRight: "\x1b[K",
  cursorUp: (n: number): string => (n > 0 ? `\x1b[${n}A` : ""),
  cursorDown: (n: number): string => (n > 0 ? `\x1b[${n}B` : ""),
  cursorBack: (n: number): string => (n > 0 ? `\x1b[${n}D` : ""),
  save: "\x1b[s",
  restore: "\x1b[u",
} as const;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Build the lines of the thinking box for a given content snapshot.
 * Pure: no terminal I/O. Returns exactly `height` visual lines (border rows
 * included). The box keeps the LAST `height - 2` content lines — when the
 * stream exceeds the box, the top scrolls out of the BOX, not the screen.
 */
export function buildThinkingBox(content: string, width: number, height: number): string[] {
  const w = Math.max(20, width);
  const h = Math.max(3, height);
  const inner = w - 4; // "│ " + content + " │" → content width = w - 4
  const innerRows = h - 2;

  // Wrap into visual rows (code-point aware), then take the tail.
  const rows: string[] = [];
  for (const rawLine of content.split("\n")) {
    if (rawLine.length === 0) {
      rows.push("");
      continue;
    }
    let current = "";
    for (const ch of rawLine) {
      if ([...current].length + [...ch].length > inner) {
        rows.push(current);
        current = ch;
      } else {
        current += ch;
      }
    }
    if (current) rows.push(current);
  }
  const visible = rows.slice(-innerRows);
  while (visible.length < innerRows) visible.unshift("");

  const lines: string[] = [];
  lines.push(`${ANSI.dim}╭${"─".repeat(w - 2)}╮${ANSI.faint}`);
  for (const row of visible) {
    const pad = " ".repeat(Math.max(0, inner - [...row].length));
    lines.push(`${ANSI.dim}│${ANSI.faint} ${row}${pad} ${ANSI.dim}│${ANSI.faint}`);
  }
  lines.push(`${ANSI.dim}╰${"─".repeat(w - 2)}╯${ANSI.faint}`);
  return lines;
}

export interface ThinkingWindowOptions {
  /** Terminal writes. */
  write: (s: string) => void;
  /** Terminal width in columns; Infinity disables the box (pipe mode). */
  width: number;
  /** Box height in rows (borders included). Default 6. */
  height?: number;
}

/**
 * Contained thinking window. `push(delta)` streams reasoning into the box;
 * the box is REDRAWN in place (cursor-up over its own rows), so the screen
 * never scrolls no matter how long the thinking gets. `end()` erases the box
 * entirely before the answer starts (Freebuff behavior: thinking is transient,
 * the answer is what stays).
 */
export class ThinkingWindow {
  private content = "";
  private drawnRows = 0;
  private readonly write: (s: string) => void;
  private readonly width: number;
  private readonly height: number;
  private saved = false;

  constructor(opts: ThinkingWindowOptions) {
    this.write = opts.write;
    this.width = opts.width;
    this.height = opts.height ?? 6;
  }

  get active(): boolean {
    return this.drawnRows > 0;
  }

  /** Stream one reasoning delta into the contained box. */
  push(delta: string): void {
    this.content += delta;
    if (!Number.isFinite(this.width)) {
      this.write(`${ANSI.dim}${delta}${ANSI.faint}`); // pipe: old behavior
      return;
    }
    this.redraw();
  }

  private redraw(): void {
    const lines = buildThinkingBox(this.content, this.width, this.height);
    const out: string[] = [];
    if (this.saved) {
      // Return to the box's top-left and repaint over the old rows.
      out.push("\r", ANSI.cursorUp(this.drawnRows));
    } else {
      out.push("\r\n", ANSI.save);
      this.saved = true;
    }
    out.push(lines.join("\n"));
    this.drawnRows = lines.length;
    this.write(out.join(""));
  }

  /** Erase the box completely (called when answer text starts or run ends). */
  end(): void {
    if (!this.saved) return;
    const erase: string[] = ["\r", ANSI.cursorUp(this.drawnRows)];
    for (let i = 0; i < this.drawnRows; i += 1) erase.push(`${ANSI.clearRight}\n`);
    erase.push(ANSI.cursorUp(this.drawnRows), ANSI.restore);
    this.write(erase.join(""));
    this.content = "";
    this.drawnRows = 0;
    this.saved = false;
  }
}

export interface SpinnerOptions {
  write: (s: string) => void;
  /** Frame interval ms. Default 120. */
  intervalMs?: number;
}

/**
 * Activity spinner with elapsed seconds — instant feedback during model
 * latency ("stuck for a while" fix). Timer is unref'd so it never holds the
 * process open. Only meaningful on TTY; pipe callers just don't start it.
 */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private startedAt = 0;
  private readonly write: (s: string) => void;
  private readonly intervalMs: number;
  private live = false;

  /** True while the spinner is animating (used to defer to first token). */
  get running(): boolean {
    return this.live;
  }

  constructor(opts: SpinnerOptions) {
    this.write = opts.write;
    this.intervalMs = opts.intervalMs ?? 120;
  }

  start(label = "thinking"): void {
    if (this.live || !Number.isFinite(this.terminalWidth())) return;
    this.live = true;
    this.frame = 0;
    this.startedAt = Date.now();
    const render = (): void => {
      const secs = ((Date.now() - this.startedAt) / 1000).toFixed(1);
      this.write(`\r${ANSI.dim}${SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]} ${label}… ${secs}s${ANSI.clearRight}${ANSI.faint}`);
      this.frame += 1;
    };
    render();
    this.timer = setInterval(render, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private terminalWidth(): number {
    return (process.stdout as { columns?: number }).columns ?? 100;
  }

  /** Stop the spinner and clear its line. Safe to call when not running. */
  stop(): void {
    if (!this.live) return;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.write(`\r${ANSI.clearRight}`);
    this.live = false;
  }
}
