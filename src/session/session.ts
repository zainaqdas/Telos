import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, STATE_DIRNAME } from "../config/loader.ts";
import type { TelosConfig } from "../config/schema.ts";
import { createProvider, resolveApiKey } from "../providers/index.ts";
import { resolveModelLimits, compactionThreshold, noteObservedCap, effectiveMaxOutput } from "../providers/catalog.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { registerFilesystemTools } from "../tools/fs-tools.ts";
import { registerShellTools } from "../tools/shell-tools.ts";
import { registerWebTools } from "../tools/web.ts";
import { registerBrowserTools, closeBrowserSession } from "../tools/browser.ts";
import { parseMcpServers } from "../mcp/config.ts";
import { parseToml } from "../config/toml.ts";
import { registerMcpServer, closeMcpClients } from "../mcp/tools.ts";
import { McpClient } from "../mcp/client.ts";
import { makeContext, installSecret } from "../tools/util.ts";
import { BudgetEnforcer, type BudgetLimits } from "../runtime/usage.ts";
import { CancellationController } from "../runtime/cancellation.ts";
import { EventLog } from "../events/log.ts";
import { StateStore } from "../events/state-store.ts";
import { reduce } from "../events/state.ts";
import { CompletionGate } from "../gate/gate.ts";
import { ManagerLoop } from "../manager/loop.ts";
import { profileRepository } from "../context/profile.ts";
import { loadConventions } from "../context/conventions.ts";
import { registerPlanTools } from "../tools/plan-tool.ts";
import { restRenderMarkdown } from "./rest-render.ts";
import { StreamPrinter, streamWidth } from "./stream-printer.ts";
import { LineEditor } from "./line-editor.ts";
import { partitionSteering } from "../manager/steering.ts";
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

  const apiKey = resolveApiKey(config.model.apiKeyEnv, config.model.provider);
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
  registerWebTools(registry);
  registerBrowserTools(registry, { cancellation });

  let taskId = `t-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 6)}`;
  let events = new EventLog(join(stateDir, "events"), taskId);
  // Incremental derived state (Part 96): the gate consumes this instead of
  // re-reading and re-reducing the whole JSONL log after every tool result.
  const stateStore = new StateStore(events);
  const limits: BudgetLimits = {
    maxTotalTokens: config.runtime.maxTotalTokens,
    maxToolCalls: config.runtime.maxToolCalls,
    maxWorkerSpawns: config.runtime.maxWorkerSpawns,
    maxParallelWorkers: config.runtime.maxParallelWorkers,
    maxWallTimeSeconds: config.runtime.maxWallTimeSeconds,
  };
  const budget = new BudgetEnforcer(limits);
  if (config.model.pricing) budget.setPricing(config.model.pricing);
  events.append("task_started", { title: "interactive session", limits: {
    max_total_tokens: limits.maxTotalTokens,
    max_tool_calls: limits.maxToolCalls,
    max_worker_spawns: limits.maxWorkerSpawns,
    max_parallel_workers: limits.maxParallelWorkers,
    max_wall_time_seconds: limits.maxWallTimeSeconds,
  } });

  // Model catalog (Scale Batch 2): real limits drive the wire max_tokens, the
  // compaction threshold, and the banner. The limits object is mutable — an
  // observed output cap (gateway truncation) updates it for this session.
  const modelLimits = resolveModelLimits(config.model.name);
  effectiveMaxOutput(modelLimits); // sanity: never throws, warms shape

  // Context Engine (Phase 2): focused repo profile injected into the system prompt.
  let repoProfile: string | undefined;
  let repoTree: string | undefined;
  let profile: import("../context/profile.ts").RepoProfile | undefined;
  try {
    profile = await profileRepository(opts.projectRoot);
    repoProfile = profile.profileText;
    repoTree = profile.treeText ?? undefined;
  } catch {
    repoProfile = undefined; // profiling must never block a session
  }

  let gate = new CompletionGate(stateStore);
  // Conventions injection (Scale Batch 5): the repo's own AGENTS.md/TELOS.md
  // (root + parents) join the system prompt as context; the runtime still
  // enforces every invariant itself — conventions advise, never authorize.
  const conventions = loadConventions(opts.projectRoot);
  if (conventions.files.length > 0) {
    for (const f of conventions.files) out(`  ⚙ conventions: ${f}`);
  }
  const ctx = makeContext(opts.projectRoot, { shellTimeoutSeconds: config.runtime.shellTimeoutSeconds, signal: cancellation.signal });
  // Mutable so a cancellation-scope reset can re-issue the live signal.
  /** Images attached this session (Part 51): sent only when the model supports vision. */
  const attachedImages: Array<{ mediaType: string; data: string; name: string }> = [];

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
  journalWriteTools(registry, journal, async () => {
    await gitSnapshot(opts.projectRoot);
  });

  // Plan tool (Scale Batch 5): set_plan/update_plan write first-class
  // plan_updated events; the gate audits the plan and turn summaries render it.
  registerPlanTools(registry, events);

  // Plan render in turn summaries (Scale Batch 5): after each run, the current
  // plan is printed so the user sees the plot without asking.
  const renderCurrentPlan = (): void => {
    const steps = lastPlanStepsFromLog(events);
    if (steps.length === 0) return;
    const icons = { pending: "□", in_progress: "◐", done: "■" } as Record<string, string>;
    out("  plan:");
    steps.forEach((s, i) => out(`    ${icons[s.status] ?? "□"} ${i + 1}. ${s.text}`));
  };

  // MCP servers (Part 55): user-declared local stdio servers compiled into
  // the same registry. A server that fails to start is a notice, not a crash.
  const mcpClients: McpClient[] = [];
  try {
    const mcpRoot = parseToml(readFileSync(join(opts.projectRoot, STATE_DIRNAME, "config.toml"), "utf8")) as Parameters<typeof parseMcpServers>[0];
    const mcpParsed = parseMcpServers(mcpRoot);
    for (const e of mcpParsed.errors) out(`  ⚙ mcp config error: ${e}`);
    for (const spec of mcpParsed.specs) {
      const reg = await registerMcpServer(registry, spec);
      if (reg.started && reg.client) {
        out(`  ⚙ mcp server '${reg.serverName}': ${reg.tools.length} tool(s)${reg.tools.length ? ` (${reg.tools.join(", ")})` : ""}`);
        mcpClients.push(reg.client);
      } else {
        out(`  ⚙ mcp server '${reg.serverName}' unavailable: ${reg.error}`);
      }
    }
  } catch {
    /* no/!parsable config for MCP: skip silently (config errors surface elsewhere) */
  }

  const manager = new ManagerLoop({
    provider,
    model: config.model.name,
    config,
    registry,
    events,
    stateStore,
    budget,
    cancellation,
    ctx,
    gate,
    skillRouter,
    learner,
    repoProfile,
    repoTree,
    /** AGENTS.md/TELOS.md conventions (Scale Batch 5 item 15). */
    conventions,
    /** Compaction (Part 68): reducer-informed, threshold-gated (0 disables). */
    compaction: { thresholdTokens: compactionThreshold(modelLimits), eventSource: () => events.readAll() },
    /** Observed-cap learning (Scale Batch 2): truncation updates session limits. */
    onObservedOutputCap: (outputTokens: number) => {
      const before = effectiveMaxOutput(modelLimits);
      noteObservedCap(modelLimits, outputTokens);
      const after = effectiveMaxOutput(modelLimits);
      if (after < before) out(`  ℹ provider output cap observed: ~${after} tokens (completions truncated) — compaction adjusted`);
    },
    /** Mid-turn steering (Scale Batch 4): the loop polls this at every
     *  tool-call boundary; queued user lines join the context immediately.
     *  Only plain input steers — slash commands stay in the session queue
     *  (partition is runtime-owned, manager/steering.ts). */
    steering: {
      drain: () =>
        partitionSteering(pendingLines).steer.map((line) => {
          // Remove the steered line from the queue; deferred (/) lines stay.
          const idx = pendingLines.indexOf(line);
          if (idx >= 0) pendingLines.splice(idx, 1);
          return line;
        }),
    },
    onNotice: (text) => {
      if (text.startsWith("Runtime lesson")) out(`  ℹ ${text.slice(0, 140)}`);
      else if (text.startsWith("PROJECT MEMORY") && process.env["TELOS_DEBUG_MEMORY"] === "1") {
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
  let rendering = false;
  const pendingLines: string[] = [];
  let processing = false;

  // Line editor (input-quality fix): cursor-aware editing, real escape-sequence
  // parsing (arrows/Home/End/Del), ↑/↓ history — zero-dep (session/line-editor.ts).
  const inputHistory: string[] = [];
  let historyIndex = -1; // -1 = live draft line
  let historyDraft = "";
  const editor = new LineEditor({
    onEcho: (s) => {
      if (!rendering) process.stdout.write(s);
    },
    historyNav: (dir) => {
      if (rendering || inputHistory.length === 0) return null;
      if (dir === 1) {
        // ↓ toward newer; past the newest returns to the live draft.
        if (historyIndex === -1) return null;
        if (historyIndex >= inputHistory.length - 1) {
          historyIndex = -1;
          return historyDraft;
        }
        historyIndex += 1;
        return inputHistory[historyIndex] ?? "";
      }
      // ↑ toward older; first press remembers the draft being typed.
      if (historyIndex === -1) {
        historyDraft = editor.value;
        historyIndex = inputHistory.length - 1;
      } else if (historyIndex > 0) {
        historyIndex -= 1;
      }
      return inputHistory[historyIndex] ?? "";
    },
  });

  printBanner(config, taskId, modelLimits);
  renderBudgetBar(budget);

  // Streamed model text goes through the printer: raw passthrough on a TTY
  // (the terminal wraps), word-boundary wrapping at terminal width otherwise.
  const printer = new StreamPrinter({ width: isRawSupported ? Number.POSITIVE_INFINITY : streamWidth(process.stdout, process.env) });

  const prompt = (): void => {
    process.stdout.write(`\n> `);
    editor.repaint(); // reveal any input buffered while a run was busy
  };
  prompt();

  const onKeypress = (buf: Buffer): void => {
    const res = editor.feed(buf.toString("utf8"));
    // A paste burst can carry multiple Enters in one chunk: hand every
    // completed line to handleLine (it queues while busy — nothing is lost).
    for (const line of editor.takeSubmitted()) {
      if (line.trim()) {
        inputHistory.push(line);
        if (inputHistory.length > 200) inputHistory.shift();
      }
      historyIndex = -1;
      historyDraft = "";
      void handleLine(line);
    }
    if (res.action === "interrupt") {
      // Ctrl+C semantics preserved from the legacy parser:
      // busy → cancel the task; typing → clear the line; idle+empty → exit.
      if (manager.isBusy()) {
        printer.end();
        editor.reset();
        cancellation.cancel("user pressed Ctrl+C");
        out("\n[cancellation signal sent — terminating task and child processes]");
      } else if (editor.value.length > 0) {
        editor.reset();
        out("^C");
        prompt();
      } else {
        shutdown(0);
      }
      return;
    }
    if (res.action === "eof") {
      shutdown(0);
      return;
    }
    // Editing echoes are emitted by the editor itself; no per-chunk redraw
    // needed anymore (the old `\r> …` repaint is gone with lineBuffer).
  };

  if (isRawSupported) {
    stdin.on("data", onKeypress);
  } else {
    // Non-TTY (piped, harness, CI): lines arrive pre-split on stdin — the
    // keypress parser would never see Enter. Same contract: lines typed while
    // a run is busy queue as steering/corrections instead of being lost.
    let lineBuf = "";
    stdin.on("data", (buf: Buffer) => {
      lineBuf += buf.toString("utf8");
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        void handleLine(line);
      }
    });
  }

  const shutdown = (code: number): void => {
    if (isRawSupported) stdin.setRawMode(false);
    stdin.removeListener("data", onKeypress);
    void closeBrowserSession(); // no orphaned browser (same discipline as shell children)
    closeMcpClients(mcpClients); // MCP servers die with the session
    stateStore.dispose(); // release the append listener
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
        attachedImages,
        fetchModels: () => fetchModelList(config.model, apiKey),
        compactNow: () => manager.compactNow(),
        setManagerModel: (m: string) => manager.setModel(m),
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
          stateStore.attach(fresh);
          gate = new CompletionGate(stateStore);
          manager.attachEvents(fresh);
          stateStore.attach(fresh);
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
    // A previous cancellation must not poison this run: cancel stops the
    // CURRENT task, not the rest of the session (Part 62). The ctx signal is
    // re-issued so network/shell tools track the live scope.
    cancellation.resetIfCancelled();
    ctx.signal = cancellation.signal;
    // Attached images (Part 51) ride with this instruction — only when the
    // active model actually supports vision (Part 51: never send otherwise).
    const images = attachedImages.splice(0, attachedImages.length);
    try {
      const result = await manager.run(text, {
        isCorrection,
        images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
        onText: (delta) => printer.push(delta),
        onThinking: (delta) => printer.thinking(delta),
        onTool: (name, summary) => {
          printer.newline();
          out(`  ⚙ ${name}  ${summary}`);
        },
      });
      printer.end();
      // Markdown rest-render (Scale Batch 5): the raw stream already showed
      // progress live; the finished answer is re-printed cleanly — fences
      // get minimal syntax-agnostic highlighting, headings get weight.
      if (result.assistantText.trim()) {
        out("");
        restRenderMarkdown(result.assistantText, { width: isRawSupported ? Number.POSITIVE_INFINITY : streamWidth(process.stdout, process.env) });
      }
      renderCurrentPlan();
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
    config: TelosConfig;
    budget: BudgetEnforcer;
    events: EventLog;
    manager: ManagerLoop;
    shutdown: (code: number) => void;
    projectRoot: string;
    learnerStore: MemoryStore;
    orchestrator: Orchestrator;
    journal: EditJournal;
    lastInstruction: string;
    attachedImages: Array<{ mediaType: string; data: string; name: string }>;
    runInstruction: (text: string, isCorrection: boolean) => Promise<void>;
    providerCapabilities: () => import("../providers/types.ts").Capabilities;
    fetchModels: () => Promise<string[]>;
    compactNow: () => { compacted: boolean; removed: number; savedTokens: number };
    setManagerModel: (model: string) => void;
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
        "/image <file|URL>  attach an image to your next message (vision models only)",
        "/provider        list providers, key presence, and the active one",
        "/models          capabilities of the active model + known models for the provider",
        "/cancel          cancel the running task (works mid-run)",
        "/correct <text>  send a correction (highest priority, invalidates conflicting work)",
        "/model [name]    show the configured model, or switch to <name> (validated against the endpoint catalog)",
        "/stop [id]       list live workers, or stop one worker's stream and children (session keeps running)",
        "/stop-workers    stop every live worker",
        "/exit            quit Telos",
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
        `workers    ${u.workersSpawned} / ${l.maxWorkerSpawns} (parallel ${u.runningWorkers}/${l.maxParallelWorkers})${deps.orchestrator.activeWorkerIds().length ? ` · live: ${deps.orchestrator.activeWorkerIds().join(", ")} (/stop <id>)` : ""}`,
        `waiting    ${waiting.length ? waiting.join(", ") : "(none)"}`,
        `collab     proposals ${activeProposals} active / ${needsRework} needs-rework · blockers ${openBlockers} open · objections ${openObjections} unresolved`,
        `wall time  ${Math.round((Date.now() - u.startedAt) / 1000)}s / ${l.maxWallTimeSeconds}s`,
        ...(deps.budget.costEstimateUsd !== null ? [`cost est.  $${deps.budget.costEstimateUsd.toFixed(4)}${deps.config.model.pricing ? " (from declared pricing)" : ""}`] : []),
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
      // Git-backed undo first (Scale Batch 3): restore the whole workspace to
      // the snapshot taken at the start of this session's first write —
      // catches renames/deletes the journal cannot represent. Falls back to
      // the journal for non-git dirs.
      const gitUndo = await gitUndoToSnapshot(deps.projectRoot);
      if (gitUndo.restored) {
        out(`[undone: workspace restored to snapshot ${gitUndo.snapshot.slice(0, 10)} — ${gitUndo.filesChanged} file(s) changed back]`);
        return;
      }
      const done = await undoLastEdit(deps.journal, deps.projectRoot);
      out(done ? `[undone: ${done}]` : `(nothing to undo — no git snapshot and the journal is empty)`);
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
    case "image": {
      // Attach an image to the NEXT instruction (Part 51). Vision is checked
      // at send time against the active model's real capabilities.
      const target = args[0] ?? "";
      if (!target) {
        out("usage: /image <workspace-file.png|https://…> — attaches to your next message" + (deps.attachedImages.length ? ` (${deps.attachedImages.length} attached)` : ""));
        return;
      }
      try {
        let mediaType: string;
        let data: string;
        if (/^https?:\/\//i.test(target)) {
          const res = await fetch(target, { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) {
            out(`/image: HTTP ${res.status} for ${target}`);
            return;
          }
          mediaType = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
          if (!/^image\//.test(mediaType)) {
            out(`/image: not an image (${mediaType})`);
            return;
          }
          data = Buffer.from(await res.arrayBuffer()).toString("base64");
        } else {
          const p = join(deps.projectRoot, target);
          if (!existsSync(p)) {
            out(`/image: file not found: ${target}`);
            return;
          }
          mediaType = target.toLowerCase().endsWith(".jpg") || target.toLowerCase().endsWith(".jpeg") ? "image/jpeg" : target.toLowerCase().endsWith(".gif") ? "image/gif" : target.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
          data = readFileSync(p).toString("base64");
        }
        deps.attachedImages.push({ mediaType, data, name: target });
        out(`[image attached: ${target} (${mediaType}, ${Math.round((data.length * 3) / 4 / 1024)} KB) — it will be sent with your next message]`);
      } catch (err) {
        out(`/image failed: ${(err as Error).message}`);
      }
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
      // Live discovery first (Part 52: capability discovery); curated list as
      // honest fallback when the endpoint has no /models route.
      const live = await deps.fetchModels();
      if (live.length) {
        out(`available models (live): ${live.slice(0, 12).join(", ")}${live.length > 12 ? ` … +${live.length - 12} more` : ""}`);
      } else {
        const models = providerCatalog().find((p) => p.id === deps.config.model.provider)?.models ?? [];
        out(models.length ? `known models (curated): ${models.join(", ")}` : "known models: (openai-compatible endpoint — set model.name manually)");
      }
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
    case "stop": {
      // Part 62: stop workers. `/stop` lists live workers; `/stop <id>` stops
      // that worker's stream and shell children without touching the session.
      const arg = (args[0] ?? "").trim();
      if (!arg) {
        const active = deps.orchestrator.activeWorkerIds();
        out(active.length ? `active workers: ${active.join(", ")}` : "no active workers");
        return;
      }
      const r = deps.orchestrator.stopWorker(arg);
      out(r.message);
      return;
    }
    case "stop-workers": {
      const ids = deps.orchestrator.stopAllWorkers();
      out(ids.length ? `stopped: ${ids.join(", ")}` : "no active workers");
      return;
    }
    case "model": {
      // Part 61: view, and now switch. `/model` prints; `/model <name>` swaps
      // the manager's model mid-session (worker default stays worker_model).
      const target = args.join(" ").trim();
      if (!target) {
        out(`${deps.config.model.provider} / ${deps.config.model.name || "(unset)"}`);
        return;
      }
      // Live capability probe — a wrong model name should fail here, loudly,
      // not on the next instruction with a confusing provider error.
      try {
        const probe = deps.fetchModels();
        const known = await probe;
        if (known.length > 0 && !known.includes(target)) {
          out(`model "${target}" is not in the endpoint's catalog; current model unchanged (${deps.config.model.name}). Use /models to list valid names.`);
          return;
        }
      } catch {
        /* discovery is best-effort — allow the switch if the endpoint is unreachable */
      }
      deps.config.model.name = target;
      deps.setManagerModel(target);
      out(`model switched: ${deps.config.model.provider}/${target}`);
      return;
    }
    case "exit":
    case "quit":
      return "exit";
    default:
      out(`unknown command: /${cmd} — try /help`);
      return;
  }
}

// ─── Output helpers ───────────────────────────────────────────────────────────

/**
 * Live model discovery (Part 52). OpenAI-shaped endpoints expose GET /models;
 * Anthropic exposes /v1/models. Returns [] on any failure — the caller falls
 * back to the curated catalog. Never throws; discovery is best-effort.
 */
async function fetchModelList(model: { provider: string; baseUrl: string; apiKeyEnv: string }, apiKey: string): Promise<string[]> {
  const base = model.provider === "anthropic" ? model.baseUrl || "https://api.anthropic.com/v1" : model.baseUrl;
  if (!base) return [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    if (typeof timer.unref === "function") timer.unref();
    const headers: Record<string, string> = model.provider === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`${base.replace(/\/$/, "")}/models`, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
    const list = Array.isArray(body) ? body : body.data ?? [];
    return list.map((m) => String(m.id ?? "")).filter((id) => id.length > 0).sort();
  } catch {
    return [];
  }
}

// Git-backed /undo lives in session-undo.ts (Scale Batch 3); re-exported for
// the session wiring.
import { gitSnapshot, gitUndoToSnapshot } from "./session-undo.ts";

function out(text: string): void {
  process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}

/** Latest plan steps from the event log (LAST plan_updated wins). */
function lastPlanStepsFromLog(events: EventLog): Array<{ text: string; status: string }> {
  const all = events.readAll();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const ev = all[i]!;
    if (ev.kind !== "plan_updated") continue;
    const steps = ev.data["steps"];
    if (!Array.isArray(steps)) continue;
    return steps
      .map((s) => (typeof s === "object" && s !== null ? (s as Record<string, unknown>) : null))
      .filter((s): s is Record<string, unknown> => s !== null)
      .map((s) => ({ text: String(s["text"] ?? ""), status: String(s["status"] ?? "pending") }))
      .filter((s) => s.text.length > 0);
  }
  return [];
}

function printBanner(config: TelosConfig, taskId: string, limits?: { contextWindow: number; maxOutput: number; observedOutputCap?: number; source: string }): void {
  const keyEnv = config.model.apiKeyEnv;
  const hasKey = Boolean(process.env[keyEnv]);
  const limitsText = limits
    ? ` · context ${Math.round(limits.contextWindow / 1000)}k · out ${limits.observedOutputCap ? `~${Math.round(limits.observedOutputCap / 1000)}k (capped)` : `${Math.round(limits.maxOutput / 1000)}k`}`
    : "";
  out([
    `Telos — ${config.model.provider}/${config.model.name || "(model unset)"}  [${keyEnv}: ${hasKey ? "present" : "MISSING"}]${limitsText}`,
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
  // Cost appears only when the user declared pricing or the provider reports
  // it — an estimate is never invented (Part 24).
  const cost = budget.costEstimateUsd;
  const costInfo = cost !== null ? ` · $${cost.toFixed(4)}` : "";
  out(`budget: tokens ${u.tokens}/${l.maxTotalTokens} (${tokPct}%) · tools ${u.toolCalls}/${l.maxToolCalls} (${toolPct}%)${costInfo}${waitInfo}`);
}
