import { spawn, type ChildProcess } from "node:child_process";

/**
 * MCP stdio client (Part 55). Speaks JSON-RPC 2.0 over a child process's
 * stdio — the standard MCP transport for local servers — with zero
 * dependencies. Lifecycle: start → initialize handshake → tools/list →
 * tools/call → stop. Every request is timeout-guarded; a server that dies
 * or hangs fails its calls without taking the session down.
 *
 * Protocol minimum (2024-11-05 spec): initialize → initialized notification
 * → tools/list → tools/call. One server process per session, shared by the
 * Manager and any workers whose role the user declared.
 */

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint etc.); undefined when the server omits them. */
  annotations?: unknown;
}

export interface McpCallResult {
  ok: boolean;
  /** Concatenated text content of the response (MCP content blocks). */
  output: string;
  /** Raw content blocks for structured consumers. */
  content?: Array<Record<string, unknown>>;
  error?: string;
}

export class McpClient {
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private initialized = false;
  private buffer = "";
  private readonly serverName: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly env?: Record<string, string>;
  private readonly requestTimeoutMs: number;

  constructor(serverName: string, command: string, args: string[], env?: Record<string, string>, requestTimeoutMs = 30_000) {
    this.serverName = serverName;
    this.command = command;
    this.args = args;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  get running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  get exitCode(): number | null {
    return this.child?.exitCode ?? null;
  }

  /** Spawn the server and perform the initialize handshake. */
  async start(): Promise<void> {
    if (this.running) return;
    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
      // Not detached: an MCP server is a session child — it must die with us.
      detached: false,
    });
    this.child.stdout!.on("data", (d: Buffer) => this.onData(d.toString()));
    // stderr is diagnostic (servers log here); keep the last lines for errors.
    let errTail = "";
    this.child.stderr!.on("data", (d: Buffer) => {
      errTail = (errTail + d.toString()).slice(-2000);
    });
    this.child.once("exit", (code, signal) => {
      // Reject every in-flight request; the server failing must not hang calls.
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server '${this.serverName}' exited (code ${code ?? "signal " + signal})${errTail ? `: ${errTail.trim().slice(-200)}` : ""}`));
      }
      this.pending.clear();
      this.initialized = false;
    });

    const result = (await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "telos", version: "0.1.0" },
    })) as { serverInfo?: { name?: string } };
    this.notify("notifications/initialized");
    this.initialized = true;
    void result;
  }

  /** List tools exposed by the server (annotations carried through when the server provides them). */
  async listTools(): Promise<McpToolInfo[]> {
    if (!this.running || !this.initialized) return [];
    const res = (await this.request("tools/list", {})) as { tools?: Array<Record<string, unknown>> };
    return (res.tools ?? []).map((t) => ({
      name: String(t["name"] ?? ""),
      description: typeof t["description"] === "string" ? t["description"] : undefined,
      inputSchema: (t["inputSchema"] ?? {}) as Record<string, unknown>,
      annotations: t["annotations"],
    })).filter((t) => t.name);
  }

  /** Invoke a tool. MCP errors (isError) and transport failures both fail. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.running || !this.initialized) {
      return { ok: false, output: "", error: `MCP server '${this.serverName}' is not running` };
    }
    try {
      const res = (await this.request("tools/call", { name, arguments: args })) as {
        content?: Array<Record<string, unknown>>;
        isError?: boolean;
      };
      const blocks = res.content ?? [];
      const text = blocks
        .map((b) => (b["type"] === "text" ? String(b["text"] ?? "") : `[${String(b["type"] ?? "block")}]`))
        .join("\n")
        .trim();
      if (res.isError) return { ok: false, output: text, content: blocks, error: text || "tool reported an error" };
      return { ok: true, output: text || "(no output)", content: blocks };
    } catch (err) {
      return { ok: false, output: "", error: (err as Error).message };
    }
  }

  /** Kill the server process; in-flight calls reject via the exit handler. */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 1500).unref();
    } catch {
      /* already gone */
    }
  }

  /**
   * Cancellation lifecycle (P1): MCP processes participate in the same
   * cancellation model as shell children. On abort: stop the child (the
   * server is task-owned), which rejects every pending request through the
   * exit handler and leaves no orphaned MCP server behind.
   */
  bindCancellation(signal?: AbortSignal): void {
    if (!signal) return;
    if (signal.aborted) {
      this.stop();
      return;
    }
    const onAbort = (): void => this.stop();
    signal.addEventListener("abort", onAbort, { once: true });
  }

  // ─── JSON-RPC plumbing ───────────────────────────────────────────────────────

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return Promise.reject(new Error(`MCP server '${this.serverName}' is not running`));
    }
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP '${this.serverName}' ${method} timed out after ${this.requestTimeoutMs / 1000}s`));
      }, this.requestTimeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(message);
    });
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Framing: newline-delimited JSON per MCP stdio transport. */
  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // tolerate server log noise on stdout
      }
      const id = msg["id"];
      if (typeof id !== "number") continue; // notifications/requests from server: ignored for now
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg["error"]) {
        const err = msg["error"] as Record<string, unknown>;
        pending.reject(new Error(`MCP error ${err["code"]}: ${String(err["message"] ?? "unknown")}`));
      } else {
        pending.resolve(msg["result"] ?? {});
      }
    }
  }
}
