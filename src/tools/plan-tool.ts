import type { ToolDefinition } from "./registry.ts";
import type { EventLog } from "../events/log.ts";

/**
 * Plan tool (Scale Batch 5, docs/SCALE_ROADMAP.md item 16) — the todo-write
 * pattern, gate-visible so a 30-file build keeps its plot. The Manager writes
 * its plan as first-class `plan_updated` events; the runtime stores it, the
 * gate audits it, and turn summaries render it. The model cannot silently
 * drift: the current plan is re-injected into the context on /plan status and
 * any plan change is a durable event, not a chat line.
 */

export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "done";
}

const MAX_STEPS = 12;
const MAX_STEP_CHARS = 200;

export interface PlanStepInput {
  text?: unknown;
  status?: unknown;
}

/** Parse/validate a set_plan/update_plan payload. Tolerant, never throws. */
export function parsePlanSteps(raw: unknown): { ok: true; steps: PlanStep[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "steps must be an array of { text, status }" };
  if (raw.length > MAX_STEPS) return { ok: false, error: `too many steps (max ${MAX_STEPS})` };
  const steps: PlanStep[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return { ok: false, error: "each step must be an object" };
    const rec = item as Record<string, unknown>;
    const text = typeof rec["text"] === "string" ? rec["text"].trim().slice(0, MAX_STEP_CHARS) : "";
    if (!text) return { ok: false, error: "each step needs a non-empty text" };
    const statusRaw = typeof rec["status"] === "string" ? rec["status"].toLowerCase() : "pending";
    if (!["pending", "in_progress", "done"].includes(statusRaw)) {
      return { ok: false, error: `invalid status '${statusRaw}' (pending | in_progress | done)` };
    }
    steps.push({ text, status: statusRaw as PlanStep["status"] });
  }
  return { ok: true, steps };
}

/** Compact deterministic rendering used in transcripts and gate summaries. */
export function renderPlan(steps: PlanStep[]): string {
  const icons = { pending: "□", in_progress: "◐", done: "■" } as const;
  return steps.map((s, i) => `${icons[s.status]} ${i + 1}. ${s.text}`).join("\n");
}

/** Rebindable event sink: /new points the plan tools at the fresh task log. */
export interface PlanEventSink {
  events: EventLog;
}

export function registerPlanTools(registry: import("./registry.ts").ToolRegistry, events: EventLog, sink?: PlanEventSink): void {
  const target: PlanEventSink = sink ?? { events };
  const execute = async (args: Record<string, unknown>) => {
    const parsed = parsePlanSteps(args["steps"]);
    if (!parsed.ok) return { ok: false, output: `plan: ${parsed.error}`, errorCategory: "bad_args" as const };
    target.events.append("plan_updated", {
      steps: parsed.steps.map((s) => ({ text: s.text, status: s.status })),
    });
    return {
      ok: true,
      output: `plan recorded (${parsed.steps.length} step${parsed.steps.length === 1 ? "" : "s"}):\n${renderPlan(parsed.steps)}\nKeep the plan updated as you progress — the Completion Gate reviews it.`,
    };
  };

  const planTool: ToolDefinition = {
    name: "set_plan",
    description:
      "Record or replace your multi-step plan for the current task. REQUIRED before starting work that touches more than two files. One entry per concrete step; mark exactly one step in_progress while working.",
    permission: "read",
    mutative: false,
    risk: "low",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "The full plan, in order",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The step, concrete and verifiable" },
              status: { type: "string", enum: ["pending", "in_progress", "done"], description: "Step state" },
            },
            required: ["text"],
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    execute,
  };

  const updateTool: ToolDefinition = {
    ...planTool,
    name: "update_plan",
    description:
      "Update the plan after real progress: mark steps done, add steps the work revealed, or re-scope. Call this whenever the plan changes — the runtime keeps the authoritative copy.",
    execute,
  };

  registry.register(planTool);
  registry.register(updateTool);
}
