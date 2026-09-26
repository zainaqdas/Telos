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
import { reduce } from "../events/state.ts";
import { CompletionGate } from "../gate/gate.ts";
import { ManagerLoop } from "../manager/loop.ts";
import { profileRepository } from "../context/profile.ts";
import { StreamPrinter, streamWidth } from "./stream-printer.ts";
import { loadSkills } from "../skills/loader.ts";
import { SkillRouter } from "../skills/router.ts";
import { MemoryStore } from "../memory/store.ts";
import { FailureLearner } from "../memory/pipeline.ts";
import { Orchestrator } from "../workers/orchestrator.ts";
import { loadExternalToolSpecs, registerExternalTools } from "../tools/external.ts";
import { providerCatalog } from "../providers/index.ts";
import { EditJournal, journalWriteTools, undoLastEdit } from "./journal.ts";


/**
 * Interactive session (Part 60/62): terminal-native, minimal, no web UI.
 * The user stays boss: interrupt (Ctrl+C), correct mid-flight, inspect state,
 * inspect diff, stop. Slash commands map 1:1 to real operations.
 */

interface SessionOpts {
  projectRoot: string;
  resume?: boolean;
}

/** /new (Part 61): rebind every event-log consumer to the fresh task log. */
function swapEventLog(
  fresh: EventLog,
  consumers: { manager: ManagerLoop; orchestrator: Orchestrator; budget: BudgetEnforcer },
): void {
  consumers.manager.attachEvents(fresh);
  consumers.orchestrator.attachEvents(fresh);
  consumers.budget.resetUsage();
}

export async function runSession(opts: SessionOpts): Promise<number> {
  const config = loadConfig(opts.projectRoot);
  const stateDir = join(opts.projectRoot, STATE_DIRNAME);
  mkdirSync(join(stateDir, "events"), { recursive: true });

  const apiKey = resolveApiKey(config.model.apiKeyEnv);
  installSecret(apiKey);
  const provider = createProvider({
    provider: config.model.provider,
    apiKey,
    baseUrl: config.model.baseUrl,
    streamTimeoutSeconds: config.runtime.streamTimeoutSeconds,
  });

  const registry = new ToolRegistry();
  registerFilesystemTools(registry);
  const cancellation = new CancellationController();
  registerShellTools(registry, { cancellation });

  let taskId = `t-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  let events = new EventLog(join(stateDir, "events"), taskId);
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

  let gate = new CompletionGate(() => events.readAll());
  const ctx = makeContext(opts.projectRoot, { shellTimeoutSeconds: config.runtime.shellTimeoutSeconds });

  // Skill Engine (Phase 3): load + route deterministically; activation and
  // constraints are runtime-enforced.
  const skills = loadSkills(opts.projectRoot);
  const skillRouter = new SkillRouter({ skills, events, profile });

  // Memory Engine (Phase 4): JSONL stores + failure learning pipeline.
  const memoryStore = new MemoryStore(opts.projectRoot);
  const learner = new FailureLearner(memoryStore);

  // Orchestration (Phase 5): workers spawn only via the budget-enforced
  // delegate tool; the Manager stays the primary builder.
  const orchestrator = new Orchestrator({
    provider,
    model: config.model.name,
    config,
    registry,
    events,
    budget,
    cancellation,
    ctx,
    learner,
  });
  registry.register(orchestrator.delegateTool());
  registry.register(orchestrator.continueTool());
  registry.register(orchestrator.decisionTool());

  // User-declared external tools (Part 94): compiled into the same registry
  // shape; collisions never shadow builtins, bad declarations never break the
  // session.
  const external = registerExternalTools(registry, loadExternalToolSpecs(opts.projectRoot));
  for (const name of external.registered) out(`  ⚙ external tool registered: ${name}`);
  for (const s of external.skipped) out(`  ⚙ external tool skipped: ${s.reason}`);

  // Edit journal (Part 61): /undo restores the pre-edit content of the most
  // recent successful workspace write. Cleared on /new — a fresh task must
  // never undo edits belonging to the previous task.
  const journal = new EditJournal();
  journalWriteTools(registry, journal);

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
    /** Compaction (Part 68): reducer-informed, threshold-gated (0 disables). */
    compaction: { thresholdTokens: config.runtime.compactionThresholdTokens ?? 60_000, eventSource: () => events.readAll() },
    onNotice: (text) => {
      if (text.startsWith("Runtime lesson")) out(`  ℹ ${text.slice(0, 140)}`);
      else if (text.startsWith("PROJECT MEMORY") && process.env["SYNERGON_DEBUG_MEMORY"] === "1") {
        out(`  ℹ memory injected:`);
        for (const line of text.split("\n").slice(1)) out(`    ${line.slice(0, 130)}`);
      }
    },
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
      // Typed cancellation must act immediately, not queue behind the run it
      // cancels (Part 62: the user remains boss).
      if (trimmed === "/cancel") {
        manager.requestCancel();
        out("\n[cancel requested]");
        return;
      }
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

  const processLine = async (trimmed: string, isCorrection = false): Promise<void> => {
    if (trimmed.startsWith("/")) {
      if (trimmed === "/correct" || trimmed.startsWith("/correct ")) {
        const text = trimmed.slice("/correct".length).trim();
        if (!text) {
          out("usage: /correct <correction text>");
          prompt();
          return;
        }
        if (manager.isBusy()) {
          manager.requestCancel();
          await new Promise((r) => setTimeout(r, 200));
        }
        out("[correction received — invalidating conflicting work]");
        // Correction propagation (Part 92): waiting workers re-evaluate their
        // report against the correction; their stale proposals go needs_rework.
        try {
          const resumed = await orchestrator.propagateCorrection(text);
          if (resumed.length) out(`[correction propagated to ${resumed.length} waiting worker(s): ${resumed.join(", ")}]`);
        } catch {
          /* propagation must never block the correction itself */
        }
        await runInstruction(text, true);
        return;
      }
      const handled = await handleSlashCommand(trimmed, {
        config,
        budget,
        events,
        manager,
        shutdown,
        projectRoot: opts.projectRoot,
        learnerStore: learner.store,
        orchestrator,
        journal,
        lastInstruction,
        runInstruction,
        providerCapabilities: () => provider.capabilities(config.model.name),
        compactNow: () => manager.compactNow(),
        resetTask: (newTaskId: string) => {
          // Fresh task identity: new EventLog + reset budget, gate and
          // orchestrator rebind to it (worker sessions are task-scoped and
          // empty here — /new is refused while anything is running).
          taskId = newTaskId;
          const fresh = new EventLog(join(stateDir, "events"), taskId);
          fresh.append("task_started", { title: "interactive session", limits: {
            max_total_tokens: limits.maxTotalTokens,
            max_tool_calls: limits.maxToolCalls,
            max_worker_spawns: limits.maxWorkerSpawns,
            max_parallel_workers: limits.maxParallelWorkers,
            max_wall_time_seconds: limits.maxWallTimeSeconds,
          } });
          events = fresh;
          gate = new CompletionGate(() => events.readAll());
          manager.attachEvents(fresh);
          orchestrator.attachEvents(fresh);
          budget.resetUsage();
        },
      });
      prompt();
      if (handled === "exit") shutdown(0);
      return;
    }
    await runInstruction(trimmed, isCorrection);
  };

  let lastInstruction = ""; // for /retry (Part 61)

  const runInstruction = async (text: string, isCorrection: boolean): Promise<void> => {
    rendering = true;
    const started = Date.now();
    lastInstruction = text;
    try {
      const result = await manager.run(text, { isCorrection, onText: (delta) => printer.push(delta),
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
      renderBudgetBar(budget, orchestrator.waitingWorkerIds().length);
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
    orchestrator: Orchestrator;
    journal: EditJournal;
    lastInstruction: string;
    runInstruction: (text: string, isCorrection: boolean) => Promise<void>;
    providerCapabilities: () => import("../providers/types.ts").Capabilities;
    compactNow: () => { compacted: boolean; removed: number; savedTokens: number };
    resetTask: (taskId: string) => void;
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
        "/collab          open proposals, blockers, and unresolved objections",
        "/waive <id> [for <Nh|Nd>] [reason]   waive an open blocker (user-only; optional expiry, then it is open again)",
        "/undo            restore the pre-edit content of the last workspace write",
        "/retry           re-run the previous instruction",
        "/compact         fold older transcript into a digest (corrections/blockers/requirements survive)",
        "/new, /clear     fresh task: clears transcript, journal, gate state (memory persists)",
        "/provider        list providers, key presence, and the active one",
        "/models          capabilities of the active model + known models for the provider",
        "/cancel          cancel the running task (works mid-run)",
        "/correct <text>  send a correction (highest priority, invalidates conflicting work)",
        "/model           show configured model (change via config/env)",
        "/exit            quit Synergon",
      ].join("\n"));
      return;
    case "status": {
      const u = deps.budget.used;
      const l = deps.budget.limitsValue;
      const waiting = deps.orchestrator.waitingWorkerIds();
      const state = reduce(deps.events.readAll());
      const activeProposals = [...state.proposals.values()].filter((p) => p.status === "active").length;
      const needsRework = [...state.proposals.values()].filter((p) => p.status === "needs_rework").length;
      const openBlockers = state.blockers.filter((b) => b.status === "open").length;
      const openObjections = state.objections.filter((o) => !o.resolved).length;
      out([
        `model      ${deps.config.model.provider}/${deps.config.model.name}`,
        `tokens     ${u.tokens} / ${l.maxTotalTokens}`,
        `tool calls ${u.toolCalls} / ${l.maxToolCalls}`,
        `workers    ${u.workersSpawned} / ${l.maxWorkerSpawns} (parallel ${u.runningWorkers}/${l.maxParallelWorkers})`,
        `waiting    ${waiting.length ? waiting.join(", ") : "(none)"}`,
        `collab     proposals ${activeProposals} active / ${needsRework} needs-rework · blockers ${openBlockers} open · objections ${openObjections} unresolved`,
        `wall time  ${Math.round((Date.now() - u.startedAt) / 1000)}s / ${l.maxWallTimeSeconds}s`,
      ].join("\n"));
      return;
    }
    case "diff": {
      const res = spawnSync("git", ["--no-pager", "diff", "--stat"], { cwd: deps.projectRoot, encoding: "utf8" });
      out(res.stdout || "(no unstaged changes)");
      return;
    }
    case "collab": {
      const state = reduce(deps.events.readAll());
      const proposals = [...state.proposals.entries()];
      const blockers = state.blockers.filter((b) => b.status === "open" || b.status === "waived");
      const objections = state.objections.filter((o) => !o.resolved);
      if (!proposals.length && !blockers.length && !objections.length) {
        out("(no open proposals, blockers, or objections)");
        return;
      }
      for (const [id, p] of proposals) out(`PROPOSAL ${id} [${p.status}] (${p.raisedBy}): ${p.statement}`);
      for (const b of blockers) out(`BLOCKER ${b.id} [${b.status}]: ${b.reason}`);
      for (const o of objections) out(`OBJECTION ${o.id || "(legacy)"}${o.debate ? ` [debate: ${o.debate.verdict}]` : ""} (${o.raisedBy}): ${o.statement}`);
      return;
    }
    case "waive": {
      // User-only waiver (Part 95): no model-facing tool exists for this — a
      // waiver is a human decision, recorded as a blocker_waived event.
      // Optional `for Nh` makes it a temporary reprieve (Phase 9): after the
      // TTL the gate treats the blocker as open again.
      const id = args[0] ?? "";
      const state = reduce(deps.events.readAll());
      const openBlockers = state.blockers.filter((b) => b.status === "open");
      const blocker = openBlockers.find((b) => b.id === id);
      if (!blocker) {
        out(`usage: /waive <blocker-id> [reason] | /waive <blocker-id> for <Nh|Nd> [reason] — open blockers: ${openBlockers.map((b) => b.id).join(", ") || "(none)"}`);
        return;
      }
      let ttlHours: number | undefined;
      let reasonParts = args.slice(1);
      const forIdx = reasonParts.findIndex((w) => /^for$/i.test(w));
      if (forIdx >= 0 && typeof reasonParts[forIdx + 1] === "string") {
        const m = /^(\d+(?:\.\d+)?)(h|d)$/i.exec(String(reasonParts[forIdx + 1]));
        if (m) {
          ttlHours = Number(m[1]) * (m[2]?.toLowerCase() === "d" ? 24 : 1);
          reasonParts = [...reasonParts.slice(0, forIdx), ...reasonParts.slice(forIdx + 2)];
        }
      }
      const event = { id: blocker.id, reason: reasonParts.join(" ") || "user waived via /waive" };
      deps.events.append("blocker_waived", ttlHours !== undefined ? { ...event, expires_at: Date.now() + ttlHours * 3_600_000 } : event);
      out(`[blocker ${blocker.id} waived${ttlHours !== undefined ? ` for ${ttlHours}h — the gate treats it as open again after that` : " — stays visible as waived; gate no longer blocked by it"}]`);
      return;
    }
    case "undo": {
      if (deps.manager.isBusy()) {
        out("(cannot undo while a task is running)");
        return;
      }
      const done = await undoLastEdit(deps.journal, deps.projectRoot);
      out(done ? `[undone: ${done}]` : `(nothing to undo — journal is empty)`);
      return;
    }
    case "retry": {
      if (deps.manager.isBusy()) {
        out("(a task is already running)");
        return;
      }
      if (!deps.lastInstruction) {
        out("(no previous instruction to retry)");
        return;
      }
      out(`[retrying: ${deps.lastInstruction.slice(0, 80)}]`);
      await deps.runInstruction(deps.lastInstruction, false);
      return;
    }
    case "new":
    case "clear": {
      if (deps.manager.isBusy()) {
        out("(cancel the running task first)");
        return;
      }
      deps.journal.clear();
      deps.manager.reset();
      const taskId = `t-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
      deps.resetTask(taskId);
      out(`[fresh task ${taskId} — transcript, journal, and gate state cleared; memory persists]`);
      return;
    }
    case "provider": {
      for (const p of providerCatalog()) {
        const keyEnv = p.id === deps.config.model.provider ? deps.config.model.apiKeyEnv : p.defaultKeyEnv;
        const hasKey = Boolean(process.env[keyEnv]);
        out(`${p.status === "available" ? "✓" : "…"} ${p.id}  [${keyEnv}: ${hasKey ? "present" : "missing"}]${p.id === deps.config.model.provider ? "  ← active" : ""}\n    ${p.note ?? ""}`);
      }
      return;
    }
    case "models": {
      const caps = deps.providerCapabilities();
      out(`active provider ${deps.config.model.provider} — capabilities of ${deps.config.model.name || "(unset)"}:`);
      out(`  tools=${caps.supportsTools ? "yes" : "no"}  vision=${caps.supportsVision ? "yes" : "no"}  streaming=${caps.supportsStreaming ? "yes" : "no"}  structured=${caps.supportsStructuredOutput ? "yes" : "no"}  context=${caps.contextLimit}`);
      const models = providerCatalog().find((p) => p.id === deps.config.model.provider)?.models ?? [];
      out(models.length ? `known models: ${models.join(", ")}` : "known models: (openai-compatible endpoint — set model.name manually)");
      return;
    }
    case "compact": {
      const r = deps.compactNow();
      out(r.compacted ? `[compacted: ${r.removed} older messages folded into the digest, ~${r.savedTokens} tokens saved]` : `(transcript under threshold — nothing to compact)`);
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

function renderBudgetBar(budget: BudgetEnforcer, waitingWorkers = 0): void {
  const u = budget.used;
  const l = budget.limitsValue;
  const tokPct = Math.min(100, Math.round((u.tokens / Math.max(1, l.maxTotalTokens)) * 100));
  const toolPct = Math.min(100, Math.round((u.toolCalls / Math.max(1, l.maxToolCalls)) * 100));
  const waitInfo = waitingWorkers > 0 ? ` · waiting: ${waitingWorkers}` : "";
  out(`budget: tokens ${u.tokens}/${l.maxTotalTokens} (${tokPct}%) · tools ${u.toolCalls}/${l.maxToolCalls} (${toolPct}%)${waitInfo}`);
}
