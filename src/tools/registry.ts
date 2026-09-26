/**
 * Unified Tool Registry (Parts 43–44). Every tool declares schema, permission,
 * mutability, and risk. Provider tools and (later) MCP tools plug into the
 * same shape — there is no "special" category of tools (Part 55).
 */

export type ToolPermission = "read" | "write" | "shell" | "network";
export type ToolRisk = "low" | "medium" | "high";

export interface ToolResult {
  ok: boolean;
  /** Human/model-readable output (already redacted + truncated). */
  output: string;
  /** Structured extras (e.g. exit code, match count). */
  meta?: Record<string, unknown>;
  errorCategory?: string;
}

export interface ToolExecContext {
  /** Workspace root — tools must not escape it. */
  root: string;
  /** Redact secrets from any text leaving the tool boundary. */
  redact(text: string): string;
  maxOutputBytes: number;
  shellTimeoutSeconds: number;
  /** Cancellation signal — network/shell tools should honor it. */
  signal?: AbortSignal;
  /** Optional per-scope controller (Part 62): a worker's shell children bind
   *  to the worker's controller so /stop <id> kills them, not the session's. */
  cancellation?: import("../runtime/cancellation.ts").CancellationController;
}

export interface ToolDefinition {
  name: string;
  description: string;

  /** JSON-schema subset: { type:"object", properties, required } */
  parameters: Record<string, unknown>;
  permission: ToolPermission;
  /** Mutating tools are subject to the single-writer rule + repetition guard. */
  mutative: boolean;
  risk: ToolRisk;
  /** Marks a user-declared external tool (optional policy surface, Phase 9). */
  external?: boolean;
  /** Worker roles allowed to use this tool when `external` is set. */
  workerRoles?: readonly string[];
  execute(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  /** Disabled tools stay registered for shape stability (prompt cache) but
   *  resolve as absent; their specs render as disabled placeholders. */
  private readonly disabled = new Set<string>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
    this.disabled.delete(tool.name);
  }

  get(name: string): ToolDefinition | undefined {
    if (this.disabled.has(name)) return undefined;
    return this.tools.get(name);
  }

  /** Remove a tool entirely (used by tests and external-tool reloads). */
  remove(name: string): void {
    this.tools.delete(name);
    this.disabled.delete(name);
  }

  /**
   * Disable without removing (parallel-write discipline, Scale Batch 2):
   * the tool resolves as absent for execution, but `specs()` keeps emitting
   * its definition in the SAME position, marked disabled — so the serialized
   * tool array is byte-stable across the strip/restore window and
   * provider-side prompt caches on the tools prefix stay valid.
   */
  setDisabled(name: string, disabled: boolean): void {
    if (!this.tools.has(name)) return;
    if (disabled) this.disabled.add(name);
    else this.disabled.delete(name);
  }

  isDisabled(name: string): boolean {
    return this.disabled.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Provider-facing specs (OpenAI function-calling shape). Order is canonical
   *  (sorted) and stable across disable/enable so prompt caches hold. */
  specs(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) =>
        this.disabled.has(t.name)
          ? {
              name: t.name,
              description: `[currently disabled — write tools are paused while workers run; it will return when the workspace is yours again]`,
              parameters: t.parameters,
            }
          : { name: t.name, description: t.description, parameters: t.parameters },
      );
  }
}

// ─── Minimal JSON-schema validation (subset, deterministic) ──────────────────

export function validateToolArgs(args: unknown, schema: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (schema["type"] !== "object") return { ok: true, args: {} };
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "arguments must be an object" };
  }
  const obj = args as Record<string, unknown>;
  const props = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];

  for (const key of required) {
    if (!(key in obj) || obj[key] === undefined) return { ok: false, error: `missing required argument: ${key}` };
  }
  for (const [key, value] of Object.entries(obj)) {
    const prop = props[key];
    if (!prop) {
      if (schema["additionalProperties"] === false) return { ok: false, error: `unknown argument: ${key}` };
      continue;
    }
    const err = checkType(value, prop, key);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, args: obj };
}

function checkType(value: unknown, prop: Record<string, unknown>, key: string): string | null {
  const type = prop["type"];
  const enumVals = prop["enum"];
  if (Array.isArray(enumVals) && !enumVals.includes(value)) {
    return `argument ${key}: must be one of ${enumVals.map((v) => JSON.stringify(v)).join(", ")}`;
  }
  switch (type) {
    case "string":
      if (typeof value !== "string") return `argument ${key}: must be a string`;
      break;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) return `argument ${key}: must be a number`;
      if (type === "integer" && !Number.isInteger(value)) return `argument ${key}: must be an integer`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `argument ${key}: must be a boolean`;
      break;
    case "array":
      if (!Array.isArray(value)) return `argument ${key}: must be an array`;
      break;
    default:
      break; // untyped: accept
  }
  return null;
}
