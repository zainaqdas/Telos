import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { ToolDefinition, ToolRegistry, ToolResult } from "./registry.ts";
import { safePath, truncateOutput } from "./util.ts";
import { CancellationController, killTree } from "../runtime/cancellation.ts";

/**
 * Shell + Git tools (Parts 44–46). The shell tool spawns children in their
 * own process group so cancellation terminates the whole tree (Part 47),
 * and integrates with the CancellationController.
 */

const DANGEROUS = [
  /\brm\s+-rf?\s+(?:--\s+)?(?:\/|~|\$HOME)(?:\s|$)/,
  /\bmkfs\b/,
  /\bdd\s+if=\/dev\/(?:zero|random)\s+of=\/dev\/(?:sd|nvme|disk)/,
  /\b:\(\)\s*\{\s*:\|\:&\s*\}\s*;:/, // fork bomb
  /\b(shutdown|reboot|halt|poweroff)\b/,
];

export interface ShellDeps {
  cancellation: CancellationController;
}

function result(ok: boolean, output: string, meta?: Record<string, unknown>, errorCategory?: string): ToolResult {
  return { ok, output, meta, errorCategory };
}

export function registerShellTools(registry: ToolRegistry, deps: ShellDeps): void {
  registry.register({
    name: "run_shell",
    description:
      "Run a shell command in the workspace. Output (stdout+stderr) is captured with exit code and duration. Long-running commands are killed at the timeout. Destructive system commands are refused.",
    permission: "shell",
    mutative: true,
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "Optional subdirectory of the workspace" },
        timeout_seconds: { type: "integer", description: "Per-call timeout; capped by runtime config" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const command = String(args["command"] ?? "").trim();
      if (!command) return result(false, "run_shell: command required", undefined, "bad_args");

      for (const re of DANGEROUS) {
        if (re.test(command)) {
          return result(false, `run_shell: refused destructive command: ${command.slice(0, 120)}`, undefined, "destructive_refused");
        }
      }

      const cwd = args["cwd"] ? safePath(ctx, String(args["cwd"])) : ctx.root;
      const timeoutMs = Math.min(
        typeof args["timeout_seconds"] === "number" && args["timeout_seconds"] > 0 ? args["timeout_seconds"] * 1000 : ctx.shellTimeoutSeconds * 1000,
        600_000,
      );

      return await new Promise<ToolResult>((resolve) => {
        // detached + group kill => grandchildren die too (mandatory, Part 47).
        // Inherited test-runner markers (NODE_TEST_CONTEXT) change how an
        // inner `node --test` behaves (it can exit 0 without running its
        // assertions), so they are stripped from the child environment.
        const env: Record<string, string | undefined> = { ...process.env, TELOS: "1" };
        for (const k of Object.keys(env)) {
          if (k === "NODE_TEST_CONTEXT" || k.startsWith("NODE_TEST_")) delete env[k];
        }
        const child = spawn("/bin/sh", ["-c", command], {
          cwd,
          detached: platform() !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
        // Bind to the per-execution scope when one is provided (worker /stop),
        // else the session controller (Ctrl+C still kills everything).
        (ctx.cancellation ?? deps.cancellation).track(child);

        let stdout = "";
        let stderr = "";
        let settled = false;
        let truncated = false;
        const CAP = 1_000_000;
        child.stdout!.on("data", (d: Buffer) => {
          if (stdout.length < CAP) stdout += d.toString();
          else truncated = true;
        });
        child.stderr!.on("data", (d: Buffer) => {
          if (stderr.length < CAP) stderr += d.toString();
          else truncated = true;
        });

        const timer = setTimeout(() => {
          if (!settled) {
            killTree(child);
            settle(result(false, `run_shell: command timed out after ${Math.round(timeoutMs / 1000)}s and was killed`, undefined, "timeout"));
          }
        }, timeoutMs);

        const settle = (r: ToolResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const combined = truncated
            ? `${stdout}\n${stderr}\n… [output truncated]`
            : `${stdout}${stderr && stdout ? "\n" : ""}${stderr}`;
          const t = truncateOutput(ctx.redact(combined).trimEnd() || "(no output)", ctx.maxOutputBytes);
          resolve(t.text === r.output ? r : { ...r, output: r.output || t.text });
        };

        child.on("error", (err) => {
          settle(result(false, `run_shell: spawn failed: ${err.message}`, undefined, "spawn_error"));
        });

        child.on("close", (code, signal) => {
          if (settled && code === null) return; // already resolved via timeout path
          const wasCancelled = (ctx.cancellation ?? deps.cancellation).isCancelled;
          if (wasCancelled) {
            settle(result(false, "run_shell: cancelled by user", undefined, "cancelled"));
            return;
          }
          const t = truncateOutput(ctx.redact((`${stdout}\n${stderr}`.trim()) || "(no output)"), ctx.maxOutputBytes);
          const header = `exit ${code ?? "signal:" + signal}`;
          settle(
            code === 0
              ? result(true, `${header}\n${t.text}`, { exitCode: 0, durationHint: undefined })
              : result(false, `${header}\n${t.text}`, { exitCode: code }, "command_failed"),
          );
        });
      });
    },
  });

  // ─── Git tools ──────────────────────────────────────────────────────────────

  const git = (sub: string, description: string, extraSchema: Record<string, unknown> = {}): ToolDefinition => ({
    name: `git_${sub}`,
    description,
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: { type: "object", properties: extraSchema, additionalProperties: false },
    async execute(args, ctx) {
      void args;
      const child = spawn("git", ["--no-pager", sub], {
        cwd: ctx.root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      if (code !== 0) return result(false, `git ${sub} failed: ${err.trim() || `exit ${code}`}`, { exitCode: code }, "git_error");
      const t = truncateOutput(ctx.redact(out), ctx.maxOutputBytes);
      return result(true, t.text || "(empty)", { truncated: t.truncated });
    },
  });

  registry.register(git("status", "Show working-tree status (branch, staged/unstaged/untracked files)."));
  registry.register(git("diff", "Show unstaged changes as a unified diff."));
  registry.register(git("log", "Show recent commit history (oneline, last 20)."));
}
