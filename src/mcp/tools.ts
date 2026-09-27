import type { ToolDefinition, ToolRegistry, ToolResult, ToolExecContext } from "../tools/registry.ts";
import { truncateOutput } from "../tools/util.ts";
import { McpClient } from "./client.ts";
import type { McpServerSpec } from "./config.ts";
import type { WorkerRole } from "../workers/roles.ts";

/**
 * MCP → registry compilation (Part 55). An MCP tool appears as a standard
 * ToolDefinition — same schema validation, repetition guard, budgets, and
 * transcript treatment as builtins; there is no "special" category and no
 * MCP-specific logic anywhere in the Manager.
 *
 * Names are prefixed `mcp_<server>_<tool>` to keep servers namespace-isolated
 * and collisions impossible. A tool call that fails (server down, error,
 * timeout) returns a failed ToolResult — one bad server degrades, never crashes.
 */

export interface McpRegistration {
  serverName: string;
  started: boolean;
  tools: string[];
  /** Live client (same instance the compiled tools close over) when started. */
  client?: McpClient;
  error?: string;
}

/** Largest sanitized tool count per server; guards pathological manifests. */
const MAX_TOOLS_PER_SERVER = 64;

function sanitizeFragment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "x";
}

/** Names MCP tools own; external/builtin names can't be shadowed. */
export const MCP_PREFIX = "mcp_";

export async function registerMcpServer(registry: ToolRegistry, spec: McpServerSpec, deps: { cancellation?: { signal?: AbortSignal } } = {}): Promise<McpRegistration> {
  const client = new McpClient(spec.name, spec.command, spec.args, spec.env, spec.timeoutSeconds * 1000);
  const toolNames: string[] = [];
  try {
    await client.start();
  } catch (err) {
    client.stop();
    return { serverName: spec.name, started: false, tools: [], error: `start failed: ${(err as Error).message}` };
  }
  // Cancellation lifecycle (P1): the MCP server dies with the task that owns
  // it — Ctrl+C / /cancel terminates it like any shell child.
  client.bindCancellation(deps.cancellation?.signal);
  let infos;
  try {
    infos = await client.listTools();
  } catch (err) {
    client.stop();
    return { serverName: spec.name, started: true, tools: [], error: `tools/list failed: ${(err as Error).message}` };
  }
  for (const info of infos.slice(0, MAX_TOOLS_PER_SERVER)) {
    const name = `${MCP_PREFIX}${sanitizeFragment(spec.name)}_${sanitizeFragment(info.name)}`;
    if (registry.get(name)) continue; // never shadow anything
    registry.register(compileMcpTool(name, spec, client, info));
    toolNames.push(name);
  }
  return { serverName: spec.name, started: true, tools: toolNames, client };
}

/** MCP tool annotations (2025 spec shape, tolerated absent). */
interface McpAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

function annotationsOf(info: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: unknown }): McpAnnotations {
  const a = info.annotations;
  return typeof a === "object" && a !== null ? (a as McpAnnotations) : {};
}

/**
 * Side-effect classification (P1): map server annotations to the registry's
 * policy fields instead of blanket "mutative, medium". No annotations ⇒
 * conservative fallback (mutative — treated like shell). readOnlyHint ⇒
 * read-only and parallelizable; destructiveHint escalates risk to high.
 */
export function classifyMcpTool(info: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: unknown }): { permission: "read" | "shell" | "network"; mutative: boolean; risk: "low" | "medium" | "high" } {
  const a = annotationsOf(info);
  if (a.readOnlyHint === true) {
    return { permission: "read", mutative: false, risk: "low" };
  }
  if (a.destructiveHint === true) {
    return { permission: "shell", mutative: true, risk: "high" };
  }
  return { permission: "shell", mutative: true, risk: "medium" };
}

function compileMcpTool(
  registryName: string,
  spec: McpServerSpec,
  client: McpClient,
  info: { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: unknown },
): ToolDefinition {
  const workerRoles = spec.workerRoles;
  // Side-effect classification (P1): annotations → policy, conservative fallback.
  const cls = classifyMcpTool(info);
  return {
    name: registryName,
    description: info.description ? `[mcp:${spec.name}] ${info.description}` : `[mcp:${spec.name}] MCP tool ${info.name}`,
    permission: cls.permission,
    mutative: cls.mutative,
    risk: cls.risk,
    external: true,
    workerRoles,
    parameters: normalizeSchema(info.inputSchema),
    async execute(args: Record<string, unknown>, ctx: ToolExecContext): Promise<ToolResult> {
      const res = await client.callTool(info.name, args);
      const t = truncateOutput(ctx.redact(res.output), ctx.maxOutputBytes);
      if (!res.ok) {
        return { ok: false, output: `mcp ${registryName} failed: ${res.error ?? t.text}`, errorCategory: "mcp_error" };
      }
      return { ok: true, output: t.text };
    },
  };
}

/** Ensure the schema is a valid object-shape for the registry validator. */
function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && schema["type"] === "object") return schema;
  // Servers occasionally emit draft shapes without top-level type; coerce
  // conservatively so validation treats unknown properties as rejected.
  return { type: "object", properties: {}, additionalProperties: false };
}

/** Worker-visible MCP tool names for a role (mirrors external tools policy). */
export function mcpWorkerTools(registry: ToolRegistry, role: WorkerRole): string[] {
  const names: string[] = [];
  for (const name of registry.names()) {
    if (!name.startsWith(MCP_PREFIX)) continue;
    const tool = registry.get(name);
    if (tool && Array.isArray(tool.workerRoles) && (tool.workerRoles as string[]).includes(role)) names.push(name);
  }
  return names;
}

/** Stop every MCP server tracked in the registry's session (helper for shutdown). */
export function closeMcpClients(clients: McpClient[]): void {
  for (const c of clients) c.stop();
}
