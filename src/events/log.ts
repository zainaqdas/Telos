import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, EventKind } from "./types.ts";

/**
 * Append-only JSONL event log. Single writer per task; the file is the
 * authority. A crash mid-write loses at most one unterminated line, which is
 * trimmed on the next open so the log stays parseable.
 */
export class EventLog {
  private readonly path: string;
  private seq = 0;
  private readonly startedAt = Date.now();
  private crashed = false;
  readonly eventsDir: string;
  readonly taskId: string;

  constructor(eventsDir: string, taskId: string) {
    this.eventsDir = eventsDir;
    this.taskId = taskId;
    mkdirSync(eventsDir, { recursive: true });
    this.path = join(eventsDir, `${taskId}.jsonl`);
    if (existsSync(this.path)) {
      // Resume keeps seq monotonic within the same file.
      this.seq = readLines(this.path).length;
    }
  }

  get file(): string {
    return this.path;
  }

  append(kind: EventKind, data: Record<string, unknown> = {}): AgentEvent {
    if (this.crashed) throw new Error("event log unusable after I/O error; refusing to write");
    this.seq += 1;
    const event: AgentEvent = { seq: this.seq, t: Date.now() - this.startedAt, taskId: this.taskId, kind, data };
    try {
      appendFileSync(this.path, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      // First failure: trim a possibly partial final line so the log stays parseable.
      if (!this.crashed) {
        this.crashed = true;
        try {
          trimLastLine(this.path);
        } catch {
          /* nothing more we can do */
        }
      }
      throw err;
    }
    return event;
  }

  /** Read all events back (used by tests and future resume). */
  readAll(): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const line of readLines(this.path)) {
      try {
        out.push(JSON.parse(line) as AgentEvent);
      } catch {
        /* skip torn tail line */
      }
    }
    return out;
  }
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return [];
  }
}

function trimLastLine(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  lines.pop(); // trailing empty after last \n
  const last = lines.pop();
  if (last === undefined) return;
  try {
    JSON.parse(last);
    return; // last line was complete
  } catch {
    writeFileSync(path, lines.join("\n") + "\n", "utf8"); // drop the torn line
  }
}
