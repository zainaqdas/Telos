import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, STATE_DIRNAME } from "../config/loader.ts";
import type { SynergonConfig } from "../config/schema.ts";
import { createProvider, resolveApiKey } from "../providers/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { registerFilesystemTools } from "../tools/fs-tools.ts";
import { registerShellTools } from "../tools/shell-tools.ts";
import { makeContext, installSecret } from "../tools/util.ts";
import { BudgetEnforcer, type BudgetLimits } from "../runtime/usage.ts";
import { CancellationController } from "../runtime/cancellation.ts";
import { EventLog } from "../events/log.ts";
import { CompletionGate } from "../gate/gate.ts";
import { ManagerLoop } from "../manager/loop.ts";
import { profileRepository } from "../context/profile.ts";
import { StreamPrinter, streamWidth } from "./stream-printer.ts";
import { loadSkills } from "../skills/loader.ts";
import { SkillRouter } from "../skills/router.ts";
import { MemoryStore } from "../memory/store.ts";
import { FailureLearner } from "../memory/pipeline.ts";

/**
 * Interactive session (Part 60/62): terminal-native, minimal, no web UI.
 * The user stays boss: interrupt (Ctrl+C), correct mid-flight, inspect state,
 * inspect diff, stop. Slash commands map 1:1 to real operations.
 */

interface SessionOpts {
  projectRoot: string;
  resume?: boolean;
}

export async function runSession(opts: SessionOpts): Promise<number> {
  const config = loadConfig(opts.projectRoot);
  const stateDir = join(opts.projectRoot, STATE_DIRNAME);
  mkdirSync(join(stateDir, "events"), { recursive: true });

  const apiKey = resolveApiKey(config.model.apiKeyEnv);
  installSecret(apiKey);
  const provider = createProvider({ provider: config.model.provider, apiKey, baseUrl: config.model.baseUrl });

  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });

  const taskId = `t-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  const events = new EventLog(join(stateDir, "events"), taskId);
  const limits: BudgetLimits = {
    maxTotalTokens: config.runtime.maxTotalTokens,
    maxToolCalls: config.runtime.maxToolCalls,
    maxWorkerSpawns: config.runtime.maxWorkerSpawns,
    maxParallelWorkers: config.runtime.maxParallelWorkers,
    maxWallTimeSeconds: config.runtime.maxWallTimeSeconds,
  };
  const budget = new BudgetEnforcer(limits);
  events.append("task_started", { title: "interactive session", limits: {
    max_total_tokens: limits.maxTotalTokens,
    max_tool_calls: limits.maxToolCalls,
    max_worker_spawns: limits.maxWorkerSpawns,
    max_parallel_workers: limits.maxParallelWorkers,
    max_wall_time_seconds: limits.maxWallTimeSeconds,
  } });

  // Context Engine (Phase 2): focused repo profile injected into the system prompt.
  let repoProfile: string | undefined;
  let profile: import("../context/profile.ts").RepoProfile | undefined;
  try {
    profile = await profileRepository(opts.projectRoot);
    repoProfile = profile.profileText;
  } catch {
    repoProfile = undefined; // profiling must never block a session
  }

  const gate = new CompletionGate(() => events.readAll());
  const ctx = makeContext(opts.projectRoot, { shellTimeoutSeconds: config.runtime.shellTimeoutSeconds });

  // Skill Engine (Phase 3): load + route deterministically; activation and
  // constraints are runtime-enforced.
  const skills = loadSkills(opts.projectRoot);
  const skillRouter = new SkillRouter({ skills, events, profile });

  // Memory Engine (Phase 4): JSONL stores + failure learning pipeline.
  const memoryStore = new MemoryStore(opts.projectRoot);
  const learner = new FailureLearner(memoryStore);

  const manager = new ManagerLoop({
    provider,
    model: config.model.name,
    config,
    registry,
    events,
    budget,
    cancellation,
    ctx,
    gate,
    skillRouter,
    learner,
    repoProfile,
  });

  // ─── Terminal setup ─────────────────────────────────────────────────────────
  const stdin = process.stdin;
  const isRawSupported = stdin.isTTY === true;
  if (isRawSupported) {
    stdin.setRawMode(true);
  }
  let lineBuffer = "";
  let rendering = false;
  const pendingLines: string[] = [];
  let processing = false;

  printBanner(config, taskId);
  renderBudgetBar(budget);

  // Streamed model text goes through the printer: raw passthrough on a TTY
  // (the terminal wraps), word-boundary wrapping at terminal width otherwise.
  const printer = new StreamPrinter({ width: isRawSupported ? Number.POSITIVE_INFINITY : streamWidth(process.stdout, process.env) });

  const prompt = (): void => {
    process.stdout.write(`\n> `);
  };
  prompt();

  const onKeypress = (buf: Buffer): void => {
    for (const byte of buf) {
      if (byte === 0x03) {
        // Ctrl+C: cancel the running task first; exit if idle or pressed twice.
        if (manager.isBusy()) {
          printer.end();
          cancellation.cancel("user pressed Ctrl+C");
          out("\n[cancellation signal sent — terminating task and child processes]");
        } else if (lineBuffer.length > 0) {
          lineBuffer = "";
          out("\n[cleared]");
          prompt();
        } else {
          shutdown(0);
        }
        return;
      }
      if (byte === 0x04) {
        shutdown(0);
        return;
      }
      if (byte === 0x0d || byte === 0x0a) {
        const line = lineBuffer;
        lineBuffer = "";
        out("");
        void handleLine(line);
        return;
      }
      if (byte === 0x7f || byte === 0x08) {
        if (lineBuffer.length > 0) lineBuffer = lineBuffer.slice(0, -1);
        continue;
      }
      if (byte < 0x20) continue;
      lineBuffer += String.fromCharCode(byte);
    }
    if (!rendering) {
      process.stdout.write(`\r> ${lineBuffer}`);
    }
  };

  stdin.on("data", onKeypress);

  const shutdown = (code: number): void => {
    if (isRawSupported) stdin.setRawMode(false);
    stdin.removeListener("data", onKeypress);
    cancellation.cancel("session shutdown");
    // Only record cancellation if the task did not already complete —
    // a completed task must not also be marked cancelled in the log.
    const alreadyCompleted = events.readAll().some((e) => e.kind === "task_completed");
    if (!alreadyCompleted) events.append("task_cancelled", { reason: "session ended" });
    out(`\nevent log: ${events.file}`);
    process.exit(code);
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      prompt();
      return;
    }
    // While a run is active, queue further input and process it sequentially
    // when the run finishes — never concurrently (Part 15 corrections arrive
    // this way during long runs).
    if (manager.isBusy()) {
      pendingLines.push(trimmed);
      return;
    }
    processing = true;
    try {
      await processLine(trimmed);
    } finally {
      processing = false;
    }
    // Drain anything queued during the run.
    while (pendingLines.length > 0) {
      const next = pendingLines.shift()!;
      if (next === "/exit" || next === "/quit") {
        shutdown(0);
        return;
      }
      if (manager.isBusy()) {
        pendingLines.unshift(next);
        return;
      }
      try {
        await processLine(next);
      } catch {
        /* processLine handles its own errors */
      }
    }
  };

  const processLine = async (trimmed: string): Promise<void> => {
    if (trimmed.startsWith("/")) {
      const handled = await handleSlashCommand(trimmed, { config, budget, events, manager, shutdown, projectRoot: opts.projectRoot, learnerStore: learner.store });
      prompt();
      if (handled === "exit") shutdown(0);
      return;
    }

    rendering = true;
    const started = Date.now();
    try {
      const result = await manager.run(trimmed, {
        onText: (delta) => printer.push(delta),
        onTool: (name, summary) => {
          printer.newline();
          out(`  ⚙ ${name}  ${summary}`);
        },
      });
      printer.end();
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      out(`\n[${result.status} in ${elapsed}s]`);
      if (result.gate) out(`Gate: ${result.gate.verdict} — ${result.gate.summary}`);
      if (result.detail) out(`detail: ${result.detail}`);
      renderBudgetBar(budget);
    } catch (err) {
      out(`\nerror: ${(err as Error).message}`);
    } finally {
      rendering = false;
      prompt();
    }
  };

  // Keep the process alive while idle (Ctrl+C or /exit terminates).
  await new Promise<never>(() => undefined);
  return 0; // unreachable
}

// ─── Slash commands (Part 61) ─────────────────────────────────────────────────

async function handleSlashCommand(
  line: string,
  deps: {
    config: SynergonConfig;
    budget: BudgetEnforcer;
    events: EventLog;
    manager: ManagerLoop;
    shutdown: (code: number) => void;
    projectRoot: string;
    learnerStore: MemoryStore;
  },
): Promise<"exit" | undefined> {
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case "profile": {
      try {
        const p = await profileRepository(deps.projectRoot);
        out(p.profileText);
      } catch (err) {
        out(`profile failed: ${(err as Error).message}`);
      }
      return;
    }
    case "memory": {
      const store = deps.learnerStore;
      const c = store.counts();
      out(
        `memory: ${c.user_rule} rules · ${c.lesson} lessons · ${c.rejected_approach} rejected · ${c.fact} facts · ${c.decision} decisions · ${c.failure} failures\nlocation: .project-agent/memory/`,
      );
      const rules = store.all("user_rule");
      if (rules.length) out("rules:\n" + rules.map((r) => `  - ${r.statement}`).join("\n"));
      const lessons = store.all("lesson");
      if (lessons.length) out("lessons:\n" + lessons.map((r) => `  - ${r.statement}`).join("\n"));
      const rejected = store.all("rejected_approach");
      if (rejected.length) out("rejected:\n" + rejected.map((r) => `  - ${r.key}${r.reason ? ` — ${r.reason}` : ""}`).join("\n"));
      return;
    }
    case "skills": {
      const loaded = loadSkills(deps.projectRoot);
      if (!loaded.length) {
        out("(no skills loaded)");
        return;
      }
      for (const s of loaded) {
        out(
          `${s.name}  [${s.source}]  auto=${s.autoInvoke ? "on" : "off"}  priority=${s.priority}\n  ${s.description}\n  checklist: ${s.checklist.map((c) => c.requirementId).join(", ") || "(none)"}\n  constraints: ${s.constraints.map((c) => `${c.id}:${c.severity}`).join(", ") || "(none)"}`,
        );
      }
      return;
    }
    case "help":
      out([
        "/help            this text",
        "/status          budget usage, task state, model",
        "/profile         repository profile (languages, commands, instructions)",
        "/skills          list loaded skills (source, checklist, constraints)",
        "/memory          show durable memory (rules, lessons, rejected approaches)",
        "/diff            git diff of the workspace",
        "/cancel          cancel the running task",
        "/model           show configured model (change via config/env)",
        "/exit            quit Synergon",
      ].join("\n"));
      return;
    case "status": {
      const u = deps.budget.used;
      const l = deps.budget.limitsValue;
      out([
        `model      ${deps.config.model.provider}/${deps.config.model.name}`,
        `tokens     ${u.tokens} / ${l.maxTotalTokens}`,
        `tool calls ${u.toolCalls} / ${l.maxToolCalls}`,
        `workers    ${u.workersSpawned} / ${l.maxWorkerSpawns} (parallel ${u.runningWorkers}/${l.maxParallelWorkers})`,
        `wall time  ${Math.round((Date.now() - u.startedAt) / 1000)}s / ${l.maxWallTimeSeconds}s`,
      ].join("\n"));
      return;
    }
    case "diff": {
      const res = spawnSync("git", ["--no-pager", "diff", "--stat"], { cwd: deps.projectRoot, encoding: "utf8" });
      out(res.stdout || "(no unstaged changes)");
      return;
    }
    case "cancel":
      deps.manager.requestCancel();
      out("[cancel requested]");
      return;
    case "model":
      out(`${deps.config.model.provider} / ${deps.config.model.name || "(unset)"}`);
      return;
    case "exit":
    case "quit":
      return "exit";
    default:
      out(`unknown command: /${cmd} — try /help`);
      return;
  }
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}

function printBanner(config: SynergonConfig, taskId: string): void {
  const keyEnv = config.model.apiKeyEnv;
  const hasKey = Boolean(process.env[keyEnv]);
  out([
    `Synergon — ${config.model.provider}/${config.model.name || "(model unset)"}  [${keyEnv}: ${hasKey ? "present" : "MISSING"}]`,
    `task ${taskId}`,
    `budgets: ${config.runtime.maxTotalTokens} tokens · ${config.runtime.maxToolCalls} tool calls · ${config.runtime.maxWallTimeSeconds}s wall`,
    `Ctrl+C cancels the running task · Ctrl+C again exits · /help for commands`,
  ].join("\n"));
}

function renderBudgetBar(budget: BudgetEnforcer): void {
  const u = budget.used;
  const l = budget.limitsValue;
  const tokPct = Math.min(100, Math.round((u.tokens / Math.max(1, l.maxTotalTokens)) * 100));
  const toolPct = Math.min(100, Math.round((u.toolCalls / Math.max(1, l.maxToolCalls)) * 100));
  out(`budget: tokens ${u.tokens}/${l.maxTotalTokens} (${tokPct}%) · tools ${u.toolCalls}/${l.maxToolCalls} (${toolPct}%)`);
}
