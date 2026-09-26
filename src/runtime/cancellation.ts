import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Real cancellation (Part 47): stopping is not "stop reading stdout".
 * Cancel terminates the task, every registered child process, and their
 * process trees, then returns control to the user.
 */
export class CancellationController {
  private controller = new AbortController();
  private readonly children = new Set<import("node:child_process").ChildProcess>();
  private cancelled = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isCancelled(): boolean {
    return this.cancelled || this.controller.signal.aborted;
  }

  /** Abort everything: model streams, shell children, their trees. */
  cancel(reason = "user requested cancellation"): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort(reason);
    for (const child of this.children) {
      killTree(child);
    }
    this.children.clear();
  }

  /**
   * Start a fresh cancellation scope (Part 62: cancel stops the CURRENT task,
   * not the rest of the session). The latch must never poison subsequent
   * runs — a session where /cancel works once and every later instruction
   * self-cancels is broken. The old signal stays aborted for anyone still
   * holding it; new consumers get a live signal.
   */
  resetIfCancelled(): void {
    if (!this.cancelled) return;
    this.cancelled = false;
    this.controller = new AbortController();
  }

  /** Register a child process so a later cancel() takes it down too. */
  track(child: import("node:child_process").ChildProcess): void {
    if (this.cancelled) {
      killTree(child);
      return;
    }
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
  }
}

type ChildProcess = import("node:child_process").ChildProcess;

/**
 * Terminate a child and its process group/tree.
 * Children must be spawned with `detached: true` on POSIX so they lead their
 * own process group and a group signal reaches grandchildren.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (platform() === "win32") {
      // taskkill /T walks the tree; /F forces it.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", detached: false });
    } else {
      // Negative pid signals the whole process group.
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          if (child.exitCode === null && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000).unref();
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Convenience: is this abort due to user cancellation? */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
