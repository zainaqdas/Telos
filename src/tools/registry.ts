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
}export interface ToolDefinition {
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

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Remove a tool (parallel-write discipline: write tools are stripped from
   *  the Manager's registry while workers run; restore re-registers them). */
  remove(name: string): void {
    this.tools.delete(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** Provider-facing specs (OpenAI function-calling shape). */
  specs(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
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
