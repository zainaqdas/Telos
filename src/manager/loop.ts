import type { Provider, Message, Usage } from "../providers/types.ts";
import { ProviderError, emptyUsage, addUsage } from "../providers/types.ts";
import type { ToolRegistry, ToolExecContext } from "../tools/registry.ts";
import { validateToolArgs } from "../tools/registry.ts";
import type { BudgetEnforcer } from "../runtime/usage.ts";
import { RepetitionGuard, fingerprintCall, guardKey, classifyShellFailure, DEFAULT_GUARD_CONFIG } from "../runtime/repetition.ts";
import type { CancellationController } from "../runtime/cancellation.ts";
import type { EventLog } from "../events/log.ts";
import { reduce } from "../events/state.ts";
import type { CompletionGate, GateReport } from "../gate/gate.ts";
import type { SynergonConfig } from "../config/schema.ts";
import type { SkillRouter } from "../skills/router.ts";
import { FailureLearner } from "../memory/pipeline.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

/**
 * The Manager task loop (Part 86). One persistent Manager drives model calls,
 * executes tools, enforces runtime guards, and records every meaningful fact
 * as an event. Workers arrive in Phase 5–6; this loop is useful without them.
 */

export interface ManagerDeps {
  provider: Provider;
  model: string;
  config: SynergonConfig;
  registry: ToolRegistry;
  events: EventLog;
  budget: BudgetEnforcer;
  cancellation: CancellationController;
  ctx: ToolExecContext;
  gate?: CompletionGate;
  guard?: RepetitionGuard;
  skillRouter?: SkillRouter;
  learner?: FailureLearner;
  repoProfile?: string;
  /** Worker-mode construction: replaces the system prompt, suppresses the
   *  user_instruction event and per-instruction routing/memory injection. */
  workerPromptOverride?: { text: string; isWorker: true };
  /** Live UI hook for runtime notices (memory injection, lessons). */
  onNotice?: (text: string) => void;
}

export interface RunOptions {
  isCorrection?: boolean;
  /** Live UI hooks (streaming deltas, tool activity). */
  onText?: (delta: string) => void;
  onTool?: (name: string, argsSummary: string) => void;
}

export interface RunResult {
  status: "completed" | "incomplete" | "blocked" | "budget_exceeded" | "cancelled" | "provider_error";
  gate: GateReport | null;
  usage: Usage;
  assistantText: string;
  detail?: string;
}

const MAX_TOOL_OUTPUT_IN_TRANSCRIPT = 8_000;

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export class ManagerLoop {
  private readonly messages: Message[] = [];
  private readonly guard: RepetitionGuard;
  private readonly deps: ManagerDeps;
  private usage: Usage = emptyUsage();
  private busy = false;
  private streamRetries = 0;
  private readonly isWorker: boolean;
  private readonly rejectionHits = new Set<string>();

  constructor(deps: ManagerDeps) {
    this.deps = deps;
    this.guard = deps.guard ?? new RepetitionGuard(DEFAULT_GUARD_CONFIG);
    this.messages.push({
      role: "system",
      parts: [{ type: "text", text: deps.workerPromptOverride ? deps.workerPromptOverride.text : buildSystemPrompt(deps.config, deps.repoProfile) }],
    });
    this.isWorker = deps.workerPromptOverride?.isWorker === true;
  }

  /** True while a run() is driving the model/tools. */
  isBusy(): boolean {
    return this.busy;
  }

  /** Request cooperative cancellation of the current run. */
  requestCancel(): void {
    this.deps.cancellation.cancel("user requested cancellation");
  }

  /** Run the loop for one user instruction until the Gate rules or limits hit. */
  async run(instruction: string, opts: RunOptions = {}): Promise<RunResult> {
    const isCorrection = opts.isCorrection === true;
    this.busy = true;

    // Worker loops do not re-record instructions or re-route skills; their
    // findings enter the shared event stream through the orchestrator.
    if (!this.isWorker) {
      this.deps.events.append(isCorrection ? "user_correction" : "user_instruction", { text: instruction });
      if (isCorrection && this.deps.learner) {
      try {
        const negation = instruction.match(/\b(?:don't|do not|never|stop|no)\s+(?:use|using|add|write|touch|run)\s+([a-z0-9@/._-]+)/i);
        const directive = instruction.match(/\b(?:use|always|prefer)\s+([a-z0-9@/._-]+(?:\s+[a-z0-9@/._-]+)?)/i);
        if (negation) {
          const approach = negation[1]!.replace(/[.,!?;]+$/, "");
          this.deps.learner.recordRejection(approach, `User correction: ${instruction.slice(0, 160)}`);
          this.deps.learner.recordUserRule(`Do not use ${approach}.`);
        } else if (directive) {
          this.deps.learner.recordUserRule(`Prefer ${directive[1]!.replace(/[.,!?;]+$/, "")}.`);
        }
      } catch {
        /* rule capture must never break the run */
      }
      }
    }

    // Deterministic skill routing (Part 34): runtime activates skills, the
    // model is informed but cannot skip or invent them.
    if (!this.isWorker && this.deps.skillRouter) {
      try {
        for (const match of await this.deps.skillRouter.route(instruction)) {
          this.deps.skillRouter.activate(match);
          this.pushSystemNotice(
            `Skill activated: ${match.skill.name} (${match.reasons.join(", ")}). Checklist requirements are now tracked by the runtime: ${match.skill.checklist.map((c) => c.requirementId).join(", ")}. Constraints will be enforced automatically.`,
          );
        }
      } catch {
        /* routing must never break the run */
      }
    }

    // Memory retrieval (Part 32): capped, trust-ordered, never the archive.
    if (!this.isWorker && this.deps.learner) {
      try {
        const memory = this.deps.learner.retrieveFor(instruction);
        const formatted = this.deps.learner.formatForContext(memory);
        if (formatted) this.pushSystemNotice(formatted);
      } catch {
        /* memory must never break the run */
      }
    }
    const prefix = isCorrection ? "CORRECTION — highest priority, supersedes earlier instructions where they conflict: " : "";
    this.messages.push({ role: "user", parts: [{ type: "text", text: `${prefix}${instruction}` }] });

    let assistantText = "";

    while (true) {
      if (this.deps.cancellation.isCancelled) return this.finish("cancelled", assistantText);

      // ── Hard budget gate: the runtime decides, not the model (Part 23) ──
      const modelVerdict = this.deps.budget.check("model_call");
      if (!modelVerdict.allowed) {
        this.deps.events.append("budget_exceeded", { resource: modelVerdict.resource, message: modelVerdict.message });
        return { ...this.finish("budget_exceeded", assistantText), detail: modelVerdict.message };
      }

      // ── Stream one model turn ──
      let text = "";
      let turnUsage: Usage | undefined;
      let stopReason = "";
      const toolCalls: PendingToolCall[] = [];
      try {
        const stream = this.deps.provider.stream(
          { messages: this.messages, tools: this.deps.registry.specs(), signal: this.deps.cancellation.signal },
          this.deps.model,
        );
        for await (const chunk of stream) {
          if (chunk.type === "text_delta" && chunk.text) {
            text += chunk.text;
            opts.onText?.(chunk.text);
          } else if (chunk.type === "tool_call_delta" && chunk.toolCall) toolCalls.push(chunk.toolCall);
          else if (chunk.type === "usage" && chunk.usage) turnUsage = chunk.usage;
          else if (chunk.type === "finish") stopReason = chunk.stopReason ?? "";
        }
      } catch (err) {
        if (this.deps.cancellation.isCancelled || (err as Error).name === "AbortError") {
          return this.finish("cancelled", assistantText);
        }
        if (err instanceof ProviderError && err.retryable) {
          // Bounded recovery (Part 86): retryable stream/HTTP failures retry
          // up to maxStreamAttempts with backoff, then fail cleanly.
          if (this.streamRetries < this.deps.config.runtime.maxStreamAttempts) {
            this.streamRetries += 1;
            await sleep(500 * this.streamRetries);
            continue;
          }
          const message = `provider failed after ${this.streamRetries} retry attempt(s): ${(err as Error).message}`;
          this.deps.events.append("failure", { source: "provider", message });
          return { ...this.finish("provider_error", assistantText), detail: message };
        }
        this.deps.events.append("failure", { source: "provider", message: (err as Error).message });
        return { ...this.finish("provider_error", assistantText), detail: (err as Error).message };
      }

      if (turnUsage) {
        this.deps.budget.recordUsage(turnUsage);
        this.usage = addUsage(this.usage, turnUsage);
      }
      if (text) assistantText = text;
      void stopReason;

      if (toolCalls.length === 0) {
        // Model finished its turn with prose — the Gate decides what happens.
        // Workers finish without a gate: their run ends at prose by contract.
        if (this.isWorker || !this.deps.gate) {
          return this.finish("completed", assistantText);
        }
        const gate = this.deps.gate.evaluate();
        if (gate.verdict === "COMPLETE") this.deps.events.append("task_completed", { reason: "gate_complete" });
        const status: RunResult["status"] = gate.verdict === "COMPLETE" ? "completed" : gate.verdict === "BLOCKED" ? "blocked" : "incomplete";
        return this.finish(status, assistantText, gate);
      }

      this.messages.push({
        role: "assistant",
        parts: [{ type: "text", text }],
        toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, argumentsJson: tc.argumentsJson })),
      });

      for (const call of toolCalls) {
        if (this.deps.cancellation.isCancelled) return this.finish("cancelled", assistantText);

        const toolVerdict = this.deps.budget.check("tool_call");
        if (!toolVerdict.allowed) {
          this.deps.events.append("budget_exceeded", { resource: toolVerdict.resource, message: toolVerdict.message });
          this.pushToolResult(call.id, call.name, `BUDGET EXCEEDED: ${toolVerdict.message}. No further tool calls are allowed this task.`);
          return { ...this.finish("budget_exceeded", assistantText), detail: toolVerdict.message };
        }

        const result = await this.executeTool(call);
        opts.onTool?.(call.name, result.output.split("\n")[0]?.slice(0, 100) ?? "");
        this.pushToolResult(call.id, call.name, result.output);
      }
    }
  }

  // ─── Tool execution with repetition guard interception ──────────────────────

  private async executeTool(call: PendingToolCall): Promise<{ output: string }> {
    const tool = this.deps.registry.get(call.name);
    if (!tool) return { output: `unknown tool: ${call.name}. Available: ${this.deps.registry.names().join(", ")}` };

    let args: Record<string, unknown> = {};
    try {
      args = call.argumentsJson.trim() ? (JSON.parse(call.argumentsJson) as Record<string, unknown>) : {};
    } catch {
      return { output: `tool ${call.name}: arguments are not valid JSON: ${call.argumentsJson.slice(0, 200)}` };
    }

    // ── Repetition Guard: classify BEFORE executing (Part 26) ──
    const key = guardKey(call.name, args);
    const fingerprint = await fingerprintCall(call.name, args, this.deps.ctx.root);

    const schemaCheck = validateToolArgs(args, tool.parameters);
    if (!schemaCheck.ok) {
      this.deps.events.append("tool_failed", { name: call.name, category: "bad_args", message: schemaCheck.error });
      this.guard.recordNonStorm(key, fingerprint, "bad_args");
      return { output: `tool ${call.name}: invalid arguments — ${schemaCheck.error}. Fix the arguments and try again.` };
    }

    const decision = this.guard.evaluate(key, fingerprint, Date.now(), call.name);
    if (decision.verdict === "REPEATED_FAILURE" || decision.verdict === "KNOWN_BAD_PATTERN") {
      this.deps.events.append("tool_failed", { name: call.name, category: decision.verdict, message: decision.reason });
      return {
        output: `REPETITION GUARD: ${decision.verdict} — ${decision.reason}. Do not repeat this call unchanged. Change something material (code, command, or state) first, or stop and report.`,
      };
    }

    // ── Skill constraints (Part 38): enforced by the runtime, before the tool runs.
    const constraintBlock = await this.checkSkillConstraints(call.name);
    if (constraintBlock) return { output: constraintBlock };

    this.deps.budget.record("tool_call");
    this.deps.events.append("tool_started", { name: call.name, args_summary: summarizeArgs(args) });

    let result;
    try {
      result = await tool.execute(args, this.deps.ctx);
    } catch (err) {
      // Tool-internal mistakes (e.g. bad paths) are caller errors, not
      // environment storms — they count for repetition, not for lockout.
      const msg = (err as Error).message;
      if (/escapes workspace|bad_args|invalid/i.test(msg)) {
        this.deps.events.append("tool_failed", { name: call.name, category: "bad_args", message: msg });
        this.guard.recordNonStorm(key, fingerprint, "bad_args");
        return { output: `tool ${call.name}: ${msg}. Correct the arguments — do not retry unchanged.` };
      }
      result = { ok: false, output: `tool ${call.name} threw: ${msg}`, errorCategory: "tool_threw" };
    }

    if (result.ok) {
      this.deps.events.append("tool_completed", { name: call.name, bytes: result.output.length });
      this.guard.record(key, fingerprint, true, undefined, Date.now(), call.name);
      // A workspace edit is runtime evidence that a "fix" checklist step happened.
      if (call.name === "edit_file" || call.name === "write_file") {
        this.satisfySkillRequirements("-fix", result.output.slice(0, 120), "tool:" + call.name);
        const scanNote = await this.scanRejections(String(args["path"] ?? ""));
        if (scanNote) result.output = `${result.output}\n${scanNote}`;
      }
    } else {
      const exitCode = result.meta?.["exitCode"];
      const category =
        call.name === "run_shell" && typeof exitCode === "number" && exitCode !== 0
          ? classifyShellFailure(result.output, exitCode)
          : result.errorCategory ?? "tool_error";
      this.deps.events.append("tool_failed", { name: call.name, category, message: result.output.slice(0, 300) });
      this.guard.record(key, fingerprint, false, category, Date.now(), call.name);
      // Failure learning pipeline (Part 28): classify, record, promote on recurrence.
      if (this.deps.learner) {
        try {
          const target = String(args["command"] ?? args["path"] ?? call.name);
          const lesson = this.deps.learner.recordFailure({ tool: call.name, category, observation: result.output, target });
          if (lesson) {
            this.deps.events.append("lesson_verified", { key: lesson.key, statement: lesson.statement });
            this.pushSystemNotice(`Runtime lesson learned (will persist): ${lesson.statement}`);
          }
        } catch {
          /* learning must never break the run */
        }
      }
      this.deps.events.append("lesson_candidate", { category, tool: call.name, observation: result.output.slice(0, 300) });
    }

    this.recordVerification(call.name, result.ok, result.output, String(args["command"] ?? ""));
    return { output: truncateForTranscript(result.output) };
  }

  /** Record test/build/lint shell results as verification events (gate inputs).
   *  The runtime — not the model — derives requirements from these results:
   *  a passing suite creates+satisfies "tests-pass"; a failing one invalidates it. */
  private recordVerification(toolName: string, ok: boolean, output: string, command = ""): void {
    if (toolName !== "run_shell") return;
    // Classification considers the command itself plus its output: a direct
    // `node --test` run may not echo the word "test" in its results.
    const head = `${command}\n${output}`.slice(0, 4000).toLowerCase();
    const isTest = /\b(tests?|vitest|jest|node --test|mocha|pytest|cargo test)\b/.test(head) || head.includes("# pass");
    const isBuild = /\b(build|tsc|compile)\b/.test(head);
    const isLint = /\b(lint|eslint|biome)\b/.test(head);
    const observation = output.slice(0, 200);
    // False-green guard: an exit-0 test run reporting fewer than the
    // configured minimum tests proves nothing (empty suite, wrong glob).
    // min_test_count = 0 disables the guard.
    const minTests = this.deps.config.runtime.minTestCount;
    let zeroTests = false;
    if (isTest && minTests > 0) {
      const testsLine = output.match(/(?:^|\n)\s*(?:ℹ )?tests\s+(\d+)/i);
      const count = testsLine ? Number(testsLine[1]) : null;
      const noTestsMsg = /no tests (?:found|ran)/i.test(output);
      zeroTests = noTestsMsg || count === null ? /node --test|vitest|jest|pytest|mocha/i.test(`${command}\n${output}`) && (count === 0 || noTestsMsg) : count < minTests;
    }
    const effectiveOk = ok && !(isTest && zeroTests);
    if (isTest) {
      this.ensureRequirement("tests-pass", "Project tests pass", effectiveOk);
      this.deps.events.append("test_result", { ok: effectiveOk, observation: zeroTests && ok ? "exit 0 but 0 tests executed — not counted as verification" : observation });
      // Skill semantics (deterministic): a failing suite is evidence of
      // reproduction; a passing suite verifies the fix.
      if (effectiveOk) this.satisfySkillRequirements("-verify", observation, "tool:run_shell");
      else this.satisfySkillRequirements("-reproduce", observation, "tool:run_shell");
    } else if (isBuild) {
      this.ensureRequirement("build-pass", "Project build succeeds", ok);
      this.deps.events.append("verification_result", { kind: "build", ok, observation });
      if (ok) this.satisfySkillRequirements("-verify", observation, "tool:run_shell");
    } else if (isLint) {
      this.ensureRequirement("lint-pass", "Lint passes", ok);
      this.deps.events.append("verification_result", { kind: "lint", ok, observation });
      if (ok) this.satisfySkillRequirements("-verify", observation, "tool:run_shell");
    }
  }

  /** Create a requirement on first sight; satisfy on success, invalidate on failure. */
  private ensureRequirement(id: string, description: string, ok: boolean): void {
    const state = reduce(this.deps.events.readAll());
    const existing = state.requirements.get(id);
    if (!existing) this.deps.events.append("requirement_added", { id, description, required: true });
    if (ok) this.deps.events.append("requirement_satisfied", { id, source: "tool:run_shell", producer: "runtime", observation: "verification command succeeded" });
    else this.deps.events.append("requirement_invalidated", { id, reason: "verification command failed" });
  }

  /**
   * Deterministic stale-rejection scan (Part 75: no stale implementation may
   * survive unnoticed). After each workspace mutation, the written file is
   * scanned for rejected-approach keys from memory. A hit is recorded as a
   * failed verification_result the gate enforces; a later clean scan of the
   * same file+key resolves it.
   */
  private async scanRejections(path: string): Promise<string | null> {
    const learner = this.deps.learner;
    if (!learner || !path) return null;
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9@/._-]/g, "").replace(/\.+$/, "");
    let content: string;
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      content = (await readFile(join(this.deps.ctx.root, path), "utf8")).toLowerCase();
    } catch {
      return null;
    }
    const hits: string[] = [];
    for (const rec of learner.store.all("rejected_approach")) {
      const key = norm(rec.key);
      if (key.length < 3) continue;
      const present = content.includes(key);
      if (present) {
        hits.push(key);
        if (!this.rejectionHits.has(`${path}:${key}`)) {
          this.rejectionHits.add(`${path}:${key}`);
          this.deps.events.append("verification_result", {
            kind: "rejection_scan",
            ok: false,
            observation: `rejected approach '${key}' present in ${path}`,
          });
          // Gate enforcement flows through requirements (Part 21).
          this.ensureRequirement("rejection-clean", "No user-rejected approaches present in edited files", false);
        }
      } else if (this.rejectionHits.has(`${path}:${key}`)) {
        this.rejectionHits.delete(`${path}:${key}`);
        this.deps.events.append("verification_result", {
          kind: "rejection_scan",
          ok: true,
          observation: `rejected approach '${key}' removed from ${path}`,
        });
        this.ensureRequirement("rejection-clean", "No user-rejected approaches present in edited files", true);
      }
    }
    if (hits.length) {
      return `RUNTIME SCAN: rejected approach(s) ${hits.map((k) => `'${k}'`).join(", ")} detected in ${path} — the user rejected this approach. Remove it and follow the user rule instead.`;
    }
    return null;
  }

  /**
   * Satisfy skill-owned requirements whose id carries the given suffix
   * (skill checklist convention: *-reproduce, *-fix, *-verify). Both pending
   * and invalidated items qualify: a user correction invalidates satisfied
   * checklists wholesale, and fresh runtime evidence is exactly what re-earns
   * them — an invalidated checklist that could never recover would block the
   * gate forever after any correction. Evidence always comes from an executed
   * tool, never from model prose.
   */
  private satisfySkillRequirements(suffix: string, observation: string, source: string): void {
    const state = reduce(this.deps.events.readAll());
    for (const [id, req] of state.requirements) {
      if (req.skill && (req.status === "pending" || req.status === "invalidated") && id.endsWith(suffix)) {
        this.deps.events.append("requirement_satisfied", { id, source, producer: "runtime", observation });
      }
    }
  }

  private pushToolResult(id: string, name: string, output: string): void {
    this.messages.push({ role: "tool", parts: [{ type: "text", text: output }], toolCallId: id, toolName: name });
  }

  /** Inject a runtime notice into the transcript (not attributed to the user). */
  private pushSystemNotice(text: string): void {
    this.messages.push({ role: "system", parts: [{ type: "text", text }] });
    try {
      this.deps.onNotice?.(text);
    } catch {
      /* observers must never break the run */
    }
  }

  /**
   * Enforce skill constraints (Part 38): a blocking constraint refuses the
   * tool call until its guarding requirement is satisfied; required returns
   * a warning; advisory is informational. Requirements can be discharged by
   * any runtime-verified evidence (e.g. a failing test run for tffb-reproduce).
   */
  private async checkSkillConstraints(toolName: string): Promise<string | null> {
    const router = this.deps.skillRouter;
    if (!router) return null;
    const state = reduce(this.deps.events.readAll());
    const warnings: string[] = [];
    for (const skill of state.skills.values()) {
      const def = router.skills.find((s) => s.name === skill.name);
      if (!def) continue;
      for (const c of def.constraints) {
        if (c.beforeTool !== toolName) continue;
        const req = state.requirements.get(c.requiresRequirement);
        const discharged = req?.status === "satisfied";
        if (discharged) continue;
        const msg = `SKILL CONSTRAINT (${def.name}/${c.id}, ${c.severity}): ${c.description}. Satisfy requirement "${c.requiresRequirement}" first (${req ? `currently ${req.status}` : "not yet registered"}).`;
        if (c.severity === "blocking") {
          this.deps.events.append("failure", { source: "skill_constraint", message: msg });
          return `REFUSED BY SKILL CONSTRAINT — ${msg} This call was not executed.`;
        }
        warnings.push(msg);
      }
    }
    if (warnings.length) return `SKILL WARNINGS — ${warnings.join(" | ")}`;
    return null;
  }

  private finish(status: RunResult["status"], assistantText: string, gate: GateReport | null = null): RunResult {
    this.busy = false;
    return { status, gate, usage: this.usage, assistantText };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function truncateForTranscript(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_IN_TRANSCRIPT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_IN_TRANSCRIPT)}\n… [truncated for transcript]`;
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? (v.length > 60 ? `${v.slice(0, 60)}…` : v) : JSON.stringify(v)}`)
    .join(" ")
    .slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
